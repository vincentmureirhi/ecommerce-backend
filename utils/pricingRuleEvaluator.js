'use strict';

const Decimal = require('decimal.js');
const { resolveProductUnitPrice } = require('./pricingEngine');

/**
 * Supported pricing rule types.
 */
const RULE_TYPES = Object.freeze({
  CONSTANT:        'CONSTANT',
  SKU_THRESHOLD:   'SKU_THRESHOLD',
  GROUP_THRESHOLD: 'GROUP_THRESHOLD',
  TIERED:          'TIERED',
});

/**
 * Derive a legacy price_source label (no rule assigned).
 */
function legacyPriceSource(product, qty, tiers) {
  if (product.requires_manual_price) return 'manual_price';

  const normalizedTiers = normalizeTiers(tiers);
  const tierHit = normalizedTiers.find(
    (t) => qty >= t.minQty && (t.maxQty == null || qty <= t.maxQty)
  );
  if (tierHit) return 'tier';

  const wholesale =
    product.wholesale_price != null ? new Decimal(product.wholesale_price) : null;
  const minWholesaleQty =
    product.min_qty_wholesale != null ? Number(product.min_qty_wholesale) : null;

  if (wholesale != null && minWholesaleQty != null && qty >= minWholesaleQty) {
    return 'wholesale';
  }

  return 'retail';
}

/**
 * Normalise raw tier rows into a sorted, validated array.
 */
function normalizeTiers(tiers) {
  return (Array.isArray(tiers) ? tiers : [])
    .map((t) => {
      const minQty = t.min_qty != null ? Math.trunc(Number(t.min_qty)) : null;
      const maxQty = t.max_qty != null ? Math.trunc(Number(t.max_qty)) : null;
      const unitPrice = t.unit_price != null ? new Decimal(t.unit_price) : null;
      if (minQty == null || minQty < 1 || unitPrice == null || unitPrice.isNegative())
        return null;
      return { minQty, maxQty, unitPrice };
    })
    .filter(Boolean)
    .sort((a, b) => b.minQty - a.minQty);
}

/**
 * Resolve the unit price and price_source for a single product line.
 *
 * @param {Object}      product      - product row (retail_price, wholesale_price,
 *                                     min_qty_wholesale, requires_manual_price)
 * @param {number}      qty          - effective quantity (may be group total for
 *                                     GROUP_THRESHOLD rules)
 * @param {Array}       tiers        - product_price_tiers rows for this product
 * @param {Object|null} rule         - pricing rule (id, rule_type, threshold_qty)
 *                                     or null for legacy behaviour
 * @returns {{ unitPrice: Decimal|null, priceSource: string }}
 */
function resolveItemPricing(product, qty, tiers, rule) {
  if (product.requires_manual_price) {
    return { unitPrice: null, priceSource: 'manual_price' };
  }

  // ── No rule assigned: legacy tier → wholesale → retail priority ──────────
  if (!rule) {
    const unitPrice = resolveProductUnitPrice(product, qty, tiers);
    const priceSource = legacyPriceSource(product, qty, tiers);
    return { unitPrice, priceSource };
  }

  const ruleType = rule.rule_type;

  switch (ruleType) {
    case RULE_TYPES.CONSTANT: {
      // Fixed retail price; tiers and wholesale are not considered.
      const retail =
        product.retail_price != null ? new Decimal(product.retail_price) : null;
      return { unitPrice: retail, priceSource: 'rule:CONSTANT' };
    }

    case RULE_TYPES.SKU_THRESHOLD: {
      // Wholesale applies when this exact SKU's qty meets the threshold.
      // Threshold: rule.threshold_qty, fallback to product.min_qty_wholesale.
      const threshold =
        rule.threshold_qty != null
          ? rule.threshold_qty
          : product.min_qty_wholesale;
      const wholesale =
        product.wholesale_price != null ? new Decimal(product.wholesale_price) : null;
      const retail =
        product.retail_price != null ? new Decimal(product.retail_price) : null;

      if (wholesale != null && threshold != null && qty >= threshold) {
        return { unitPrice: wholesale, priceSource: 'rule:SKU_THRESHOLD:wholesale' };
      }
      return { unitPrice: retail, priceSource: 'rule:SKU_THRESHOLD:retail' };
    }

    case RULE_TYPES.GROUP_THRESHOLD: {
      // qty is pre-computed group total (all products sharing this rule).
      // Wholesale applies when group total meets threshold.
      const threshold =
        rule.threshold_qty != null
          ? rule.threshold_qty
          : product.min_qty_wholesale;
      const wholesale =
        product.wholesale_price != null ? new Decimal(product.wholesale_price) : null;
      const retail =
        product.retail_price != null ? new Decimal(product.retail_price) : null;

      if (wholesale != null && threshold != null && qty >= threshold) {
        return { unitPrice: wholesale, priceSource: 'rule:GROUP_THRESHOLD:wholesale' };
      }
      return { unitPrice: retail, priceSource: 'rule:GROUP_THRESHOLD:retail' };
    }

    case RULE_TYPES.TIERED: {
      // Tier pricing; falls back to wholesale/retail via resolveProductUnitPrice.
      const unitPrice = resolveProductUnitPrice(product, qty, tiers);
      const normalizedTiers = normalizeTiers(tiers);
      const tierHit = normalizedTiers.find(
        (t) => qty >= t.minQty && (t.maxQty == null || qty <= t.maxQty)
      );
      const priceSource = tierHit ? 'rule:TIERED:tier' : 'rule:TIERED:retail';
      return { unitPrice, priceSource };
    }

    default: {
      // Unknown rule type: safe legacy fallback.
      const unitPrice = resolveProductUnitPrice(product, qty, tiers);
      const priceSource = legacyPriceSource(product, qty, tiers);
      return { unitPrice, priceSource };
    }
  }
}

/**
 * Pre-compute GROUP_THRESHOLD group totals from a set of items.
 * Returns { [ruleId]: totalQty }.
 */
function computeGroupTotals(safeItems, productMap) {
  const groupTotals = {};
  for (const item of safeItems) {
    const product = productMap[item.product_id];
    if (!product) continue;
    const rule = product._pricingRule;
    if (rule && rule.rule_type === RULE_TYPES.GROUP_THRESHOLD) {
      const ruleId = rule.id;
      groupTotals[ruleId] = (groupTotals[ruleId] || 0) + item.quantity;
    }
  }
  return groupTotals;
}

/**
 * Derive the applicable wholesale threshold quantity for a product+rule combination.
 * Returns null when wholesale is not applicable (e.g. CONSTANT, TIERED, manual).
 */
function deriveThresholdQty(product, rule) {
  if (!rule) {
    // Legacy: threshold is product.min_qty_wholesale
    return product.min_qty_wholesale != null ? Number(product.min_qty_wholesale) : null;
  }
  if (rule.rule_type === RULE_TYPES.SKU_THRESHOLD || rule.rule_type === RULE_TYPES.GROUP_THRESHOLD) {
    return rule.threshold_qty != null
      ? Number(rule.threshold_qty)
      : (product.min_qty_wholesale != null ? Number(product.min_qty_wholesale) : null);
  }
  return null; // CONSTANT, TIERED, unknown — no threshold-based wholesale
}

/**
 * Derive a human-readable pricing label from a price_source string.
 */
function derivePricingLabel(priceSource, ruleType) {
  if (!priceSource || priceSource === 'unknown_product') return 'unknown_product';
  if (priceSource === 'manual_price') return 'manual_price';
  if (priceSource.includes('wholesale')) return `wholesale (${ruleType || 'legacy'})`;
  if (priceSource.includes(':tier') || priceSource === 'tier') return `tier (${ruleType || 'legacy'})`;
  if (priceSource === 'rule:CONSTANT') return 'constant';
  if (priceSource.includes(':retail') || priceSource === 'retail') return `retail (${ruleType || 'legacy'})`;
  return priceSource;
}

/**
 * Evaluate pricing for a set of cart / order items.
 *
 * The backend is the single source of truth for pricing. Prices are always
 * computed server-side regardless of any client-supplied price hint.
 *
 * GROUP_THRESHOLD group totals are computed once across all items before
 * per-line resolution so that qualifying together works correctly.
 *
 * @param {Array<{product_id: number, quantity: number}>} items
 * @param {Object} productMap   - { [product_id]: productRow }
 *                                productRow may have ._pricingRule attached
 * @param {Object} tiersMap     - { [product_id]: tierRow[] }
 * @returns {Array<{product_id, quantity, unit_price: Decimal|null, price_source: string}>}
 */
function evaluateCartPricing(items, productMap, tiersMap) {
  return evaluateCartPricingWithMeta(items, productMap, tiersMap);
}

/**
 * Evaluate pricing for a set of cart / order items, returning full pricing
 * metadata per line in addition to the computed price.
 *
 * Returned metadata fields (per item):
 *   is_wholesale_eligible {boolean}  — true when the server granted wholesale pricing
 *   threshold_qty         {number|null} — quantity threshold that must be met for wholesale
 *   effective_qty         {number}   — qty used for threshold comparison (group total for
 *                                      GROUP_THRESHOLD rules, individual qty otherwise)
 *   rule_type             {string}   — RULE_TYPES value or 'legacy' when no rule is assigned
 *   rule_name             {string|null} — pricing rule name (if available)
 *   pricing_label         {string}   — human-readable label (e.g. "wholesale (SKU_THRESHOLD)")
 *
 * This is the authoritative evaluation path.  evaluateCartPricing() delegates here.
 *
 * @param {Array<{product_id: number, quantity: number}>} items
 * @param {Object} productMap   - { [product_id]: productRow }
 * @param {Object} tiersMap     - { [product_id]: tierRow[] }
 * @returns {Array} — same ordering as items, each element extended with meta fields
 */
function evaluateCartPricingWithMeta(items, productMap, tiersMap) {
  const safeItems = Array.isArray(items) ? items : [];

  // ── 1. Pre-compute GROUP_THRESHOLD group totals ───────────────────────────
  const groupTotals = computeGroupTotals(safeItems, productMap);

  // ── 2. Resolve per-line pricing with metadata ─────────────────────────────
  return safeItems.map((item) => {
    const product = productMap[item.product_id];
    if (!product) {
      return {
        ...item,
        unit_price: null,
        price_source: 'unknown_product',
        is_wholesale_eligible: false,
        threshold_qty: null,
        effective_qty: item.quantity,
        rule_type: null,
        rule_name: null,
        pricing_label: 'unknown_product',
      };
    }

    const tiers = tiersMap[item.product_id] || [];
    const rule = product._pricingRule || null;

    // For GROUP_THRESHOLD: substitute individual qty with group total
    const effectiveQty =
      rule && rule.rule_type === RULE_TYPES.GROUP_THRESHOLD
        ? groupTotals[rule.id] || item.quantity
        : item.quantity;

    const { unitPrice, priceSource } = resolveItemPricing(
      product,
      effectiveQty,
      tiers,
      rule
    );

    const isWholesaleEligible = priceSource.includes('wholesale');
    const thresholdQty = deriveThresholdQty(product, rule);
    const ruleType = rule ? rule.rule_type : 'legacy';
    const ruleName = rule ? (rule.name || null) : null;
    const pricingLabel = derivePricingLabel(priceSource, ruleType);

    return {
      ...item,
      unit_price: unitPrice,
      price_source: priceSource,
      is_wholesale_eligible: isWholesaleEligible,
      threshold_qty: thresholdQty,
      effective_qty: effectiveQty,
      rule_type: ruleType,
      rule_name: ruleName,
      pricing_label: pricingLabel,
    };
  });
}

module.exports = {
  RULE_TYPES,
  resolveItemPricing,
  evaluateCartPricing,
  evaluateCartPricingWithMeta,
};
