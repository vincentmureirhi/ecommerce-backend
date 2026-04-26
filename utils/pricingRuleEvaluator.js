'use strict';

const Decimal = require('decimal.js');
const { resolveProductUnitPrice, computeLineTotal } = require('./pricingEngine');

/**
 * price_source vocabulary
 * =======================
 * Values written to order_items.price_source and propagated to
 * order_item_pricing_audit via DB trigger:
 *
 *   'retail_fallback'  : No pricing rule; qty below wholesale threshold.
 *                        Falls back to product.retail_price.
 *   'wholesale'        : No pricing rule; qty >= product.min_qty_wholesale.
 *                        Uses product.wholesale_price (legacy SKU threshold).
 *   'tier'             : No pricing rule; matched product_price_tiers entry.
 *   'constant'         : CONSTANT rule — always retail_price.
 *   'sku_threshold'    : SKU_THRESHOLD rule — this SKU qty >= threshold_qty.
 *   'group_threshold'  : GROUP_THRESHOLD rule — group total qty >= threshold_qty.
 *   'tiered'           : TIERED rule — resolved via product_price_tiers.
 *   'manual_price'     : requires_manual_price product; price supplied by admin.
 *
 * Flash sale discounts are currently informational/display-only (exposed via
 * the products API) and are NOT applied at order-creation time.
 * price_source will never be 'flash_sale' in the current implementation.
 * See docs/pricing-precedence.md §Flash Sales for status.
 */

// ─────────────────────────────────────────────────────────────
// DB helpers (used by createOrder / guestCheckout)
// ─────────────────────────────────────────────────────────────

/**
 * Batch-load products + their active pricing rules + tiers.
 *
 * @param  {pg.PoolClient} client
 * @param  {number[]}      productIds
 * @returns {{ productMap: Map<number, object>, tiersMap: Map<number, object[]> }}
 */
async function loadPricingContext(client, productIds) {
  const ids = [...new Set(productIds.map(Number))].filter(Boolean);
  if (ids.length === 0) return { productMap: new Map(), tiersMap: new Map() };

  // Products joined with their active pricing rule (if any)
  const prodResult = await client.query(
    `
    SELECT
      p.id,
      p.name,
      p.sku,
      p.retail_price,
      p.wholesale_price,
      p.min_qty_wholesale,
      p.requires_manual_price,
      p.current_stock,
      pr.id            AS pricing_rule_id,
      pr.name          AS pricing_rule_name,
      pr.rule_type     AS pricing_rule_type,
      pr.threshold_qty AS pricing_rule_threshold_qty
    FROM products p
    LEFT JOIN pricing_rules pr
           ON pr.id = p.pricing_rule_id
          AND pr.is_active = TRUE
    WHERE p.id = ANY($1)
    `,
    [ids]
  );

  const productMap = new Map();
  for (const row of prodResult.rows) {
    const rule = row.pricing_rule_id
      ? {
          id:            row.pricing_rule_id,
          name:          row.pricing_rule_name,
          rule_type:     row.pricing_rule_type,
          threshold_qty: row.pricing_rule_threshold_qty,
        }
      : null;

    productMap.set(row.id, {
      id:                   row.id,
      name:                 row.name,
      sku:                  row.sku,
      retail_price:         row.retail_price,
      wholesale_price:      row.wholesale_price,
      min_qty_wholesale:    row.min_qty_wholesale,
      requires_manual_price: row.requires_manual_price,
      current_stock:        row.current_stock,
      pricing_rule:         rule,
    });
  }

  // Tiers
  const tiersResult = await client.query(
    `
    SELECT product_id, min_qty, max_qty, unit_price
    FROM product_price_tiers
    WHERE product_id = ANY($1)
    ORDER BY product_id, min_qty ASC
    `,
    [ids]
  );

  const tiersMap = new Map();
  for (const row of tiersResult.rows) {
    if (!tiersMap.has(row.product_id)) tiersMap.set(row.product_id, []);
    tiersMap.get(row.product_id).push(row);
  }

  return { productMap, tiersMap };
}

// ─────────────────────────────────────────────────────────────
// Pure pricing evaluator (no DB access — unit-testable)
// ─────────────────────────────────────────────────────────────

/**
 * Determine the source label for a legacy-fallback resolution.
 *
 * @param  {object}        product  Product row
 * @param  {number}        qty
 * @param  {object[]}      tiers    Normalised tier rows
 * @param  {Decimal|null}  resolved Result from resolveProductUnitPrice
 * @returns {string}
 */
function _legacySource(product, qty, tiers, resolved) {
  // null resolved on a non-manual product means no retail_price is set —
  // classify as retail_fallback (product data is incomplete)
  if (resolved === null) return 'retail_fallback';

  const normalizedTiers = (Array.isArray(tiers) ? tiers : [])
    .map((t) => ({
      minQty: Number(t.min_qty),
      maxQty: t.max_qty == null ? null : Number(t.max_qty),
      unitPrice: new Decimal(t.unit_price),
    }))
    .filter((t) => t.minQty >= 1)
    .sort((a, b) => b.minQty - a.minQty);

  const tierHit = normalizedTiers.find(
    (t) => qty >= t.minQty && (t.maxQty == null || qty <= t.maxQty)
  );

  if (tierHit) return 'tier';

  const wholesale = product.wholesale_price != null
    ? new Decimal(product.wholesale_price) : null;
  const minWholesale = product.min_qty_wholesale != null
    ? Number(product.min_qty_wholesale) : null;

  if (wholesale != null && minWholesale != null && qty >= minWholesale) {
    return 'wholesale';
  }

  return 'retail_fallback';
}

/**
 * evaluateCartPricing
 * ===================
 * Server-side pricing resolution for all items in a cart/order.
 *
 * Pricing precedence per line item:
 *   1. requires_manual_price         → price_source = 'manual_price', unit_price = null
 *   2. TIERED rule                   → product_price_tiers resolution
 *   3. CONSTANT rule                 → retail_price always
 *   4. SKU_THRESHOLD rule            → wholesale if this-SKU qty >= threshold_qty
 *   5. GROUP_THRESHOLD rule          → wholesale if group total qty >= threshold_qty
 *   6. Legacy fallback (no rule)     → tier > wholesale (min_qty_wholesale) > retail
 *
 * Flash sale discounts are NOT applied here.
 * See docs/pricing-precedence.md §Flash Sales.
 *
 * @param  {Array}  items       Array of { product_id, quantity }
 * @param  {Map}    productMap  Map<product_id, product+pricing_rule> from loadPricingContext
 * @param  {Map}    tiersMap    Map<product_id, tier[]> from loadPricingContext
 * @returns {Array} Resolved items: { product_id, quantity, unit_price (Decimal|null),
 *                                    line_total (Decimal|null), price_source (string),
 *                                    pricing_rule_id (number|null), rule_type (string|null) }
 */
function evaluateCartPricing(items, productMap, tiersMap) {
  const safeItems = Array.isArray(items) ? items : [];

  // ── Pre-compute GROUP_THRESHOLD group totals ──────────────
  // Total quantity per pricing_rule_id (only GROUP_THRESHOLD rules)
  const groupTotals = new Map(); // pricing_rule_id → total qty
  for (const item of safeItems) {
    const product = productMap.get(Number(item.product_id));
    if (!product) continue;
    const rule = product.pricing_rule;
    if (!rule || rule.rule_type !== 'GROUP_THRESHOLD') continue;
    groupTotals.set(rule.id, (groupTotals.get(rule.id) || 0) + Number(item.quantity));
  }

  return safeItems.map((item) => {
    const productId = Number(item.product_id);
    const qty       = Number(item.quantity);

    const product = productMap.get(productId);
    if (!product) {
      throw new Error(`Product ${productId} not found in productMap`);
    }

    const tiers = tiersMap.get(productId) || [];
    const rule  = product.pricing_rule; // null for legacy products

    // ── Manual-price products ──────────────────────────────
    if (product.requires_manual_price) {
      return {
        product_id:      productId,
        quantity:        qty,
        unit_price:      null,
        line_total:      null,
        price_source:    'manual_price',
        pricing_rule_id: rule ? rule.id : null,
        rule_type:       rule ? rule.rule_type : null,
      };
    }

    let unitPrice;
    let priceSource;

    if (!rule) {
      // ── Legacy fallback ────────────────────────────────
      const resolved = resolveProductUnitPrice(product, qty, tiers);
      unitPrice   = resolved;
      priceSource = _legacySource(product, qty, tiers, resolved);
    } else {
      switch (rule.rule_type) {
        case 'CONSTANT': {
          const retail = product.retail_price != null
            ? new Decimal(product.retail_price) : null;
          unitPrice   = retail;
          priceSource = 'constant';
          break;
        }

        case 'SKU_THRESHOLD': {
          const threshold = rule.threshold_qty != null ? Number(rule.threshold_qty) : null;
          const wholesale = product.wholesale_price != null
            ? new Decimal(product.wholesale_price) : null;
          const retail    = product.retail_price != null
            ? new Decimal(product.retail_price) : null;

          if (threshold != null && qty >= threshold && wholesale != null) {
            unitPrice   = wholesale;
            priceSource = 'sku_threshold';
          } else {
            unitPrice   = retail;
            priceSource = 'retail_fallback';
          }
          break;
        }

        case 'GROUP_THRESHOLD': {
          const threshold  = rule.threshold_qty != null ? Number(rule.threshold_qty) : null;
          const groupTotal = groupTotals.get(rule.id) || 0;
          const wholesale  = product.wholesale_price != null
            ? new Decimal(product.wholesale_price) : null;
          const retail     = product.retail_price != null
            ? new Decimal(product.retail_price) : null;

          if (threshold != null && groupTotal >= threshold && wholesale != null) {
            unitPrice   = wholesale;
            priceSource = 'group_threshold';
          } else {
            unitPrice   = retail;
            priceSource = 'retail_fallback';
          }
          break;
        }

        case 'TIERED': {
          const resolved = resolveProductUnitPrice(product, qty, tiers);
          unitPrice   = resolved;
          priceSource = resolved != null ? 'tiered' : 'manual_price';
          break;
        }

        default: {
          // Unknown rule type — safe fallback to retail
          const retail = product.retail_price != null
            ? new Decimal(product.retail_price) : null;
          unitPrice   = retail;
          priceSource = 'retail_fallback';
          break;
        }
      }
    }

    const lineTotal = unitPrice != null
      ? computeLineTotal(unitPrice, qty)
      : null;

    return {
      product_id:      productId,
      quantity:        qty,
      unit_price:      unitPrice,
      line_total:      lineTotal,
      price_source:    priceSource,
      pricing_rule_id: rule ? rule.id   : null,
      rule_type:       rule ? rule.rule_type : null,
    };
  });
}

module.exports = { evaluateCartPricing, loadPricingContext };
