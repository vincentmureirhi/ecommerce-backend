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
 * Evaluate pricing for a set of cart / order items.
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
  const safeItems = Array.isArray(items) ? items : [];

  // ── 1. Pre-compute GROUP_THRESHOLD group totals ───────────────────────────
  const groupTotals = {}; // rule_id -> total qty
  for (const item of safeItems) {
    const product = productMap[item.product_id];
    if (!product) continue;
    const rule = product._pricingRule;
    if (rule && rule.rule_type === RULE_TYPES.GROUP_THRESHOLD) {
      const ruleId = rule.id;
      groupTotals[ruleId] = (groupTotals[ruleId] || 0) + item.quantity;
    }
  }

  // ── 2. Resolve per-line pricing ───────────────────────────────────────────
  return safeItems.map((item) => {
    const product = productMap[item.product_id];
    if (!product) {
      return { ...item, unit_price: null, price_source: 'unknown_product' };
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

    return { ...item, unit_price: unitPrice, price_source: priceSource };
  });
}

/**
 * Build a human-readable pricing summary string for a single product.
 *
 * Examples:
 *  - "Fixed price: KES 200.00"
 *  - "Retail: KES 121.00 | Wholesale: KES 109.00 from 3 pcs"
 *  - "Retail: KES 100.00 | Combo wholesale: KES 70.00 when combined quantity in this group (Group A) reaches 10 pcs"
 *  - "Tiered: 1–49 pcs: KES 100.00 | 50–99 pcs: KES 47.00 | 100+ pcs: KES 45.00"
 *  - "Price set by admin"
 *
 * @param {Object}      product   - product row
 * @param {Object|null} rule      - pricing rule row (id, rule_type, threshold_qty, name) or null
 * @param {Array}       tiers     - product_price_tiers rows for this product
 * @returns {string}
 */
function describePricing(product, rule, tiers) {
  const retailStr =
    product.retail_price != null
      ? `KES ${new Decimal(product.retail_price).toFixed(2)}`
      : null;
  const wholesaleStr =
    product.wholesale_price != null
      ? `KES ${new Decimal(product.wholesale_price).toFixed(2)}`
      : null;

  if (product.requires_manual_price) {
    return 'Price set by admin';
  }

  if (!rule) {
    // Legacy: tier → wholesale → retail
    const normalizedTiers = normalizeTiers(tiers);
    if (normalizedTiers.length > 0) {
      const parts = normalizedTiers
        .slice()
        .sort((a, b) => a.minQty - b.minQty)
        .map((t) => {
          const range =
            t.maxQty != null
              ? `${t.minQty}–${t.maxQty} pcs`
              : `${t.minQty}+ pcs`;
          return `${range}: KES ${t.unitPrice.toFixed(2)}`;
        });
      return `Tiered: ${parts.join(' | ')}`;
    }
    const threshold =
      product.min_qty_wholesale != null
        ? Number(product.min_qty_wholesale)
        : null;
    if (wholesaleStr && threshold != null) {
      return `Retail: ${retailStr} | Wholesale: ${wholesaleStr} from ${threshold} pcs`;
    }
    if (retailStr) return `Retail: ${retailStr}`;
    return 'Price not configured';
  }

  switch (rule.rule_type) {
    case RULE_TYPES.CONSTANT:
      return `Fixed price: ${retailStr}`;

    case RULE_TYPES.SKU_THRESHOLD: {
      const threshold =
        rule.threshold_qty != null
          ? rule.threshold_qty
          : product.min_qty_wholesale;
      if (wholesaleStr && threshold != null) {
        return `Retail: ${retailStr} | Wholesale: ${wholesaleStr} from ${threshold} pcs`;
      }
      return `Retail: ${retailStr}`;
    }

    case RULE_TYPES.GROUP_THRESHOLD: {
      const threshold =
        rule.threshold_qty != null
          ? rule.threshold_qty
          : product.min_qty_wholesale;
      const ruleName = rule.name ? ` (${rule.name})` : '';
      if (wholesaleStr && threshold != null) {
        return (
          `Retail: ${retailStr} | Combo wholesale: ${wholesaleStr} when combined` +
          ` quantity in this group${ruleName} reaches ${threshold} pcs`
        );
      }
      return `Retail: ${retailStr}`;
    }

    case RULE_TYPES.TIERED: {
      const normalizedTiers = normalizeTiers(tiers);
      if (normalizedTiers.length > 0) {
        const parts = normalizedTiers
          .slice()
          .sort((a, b) => a.minQty - b.minQty)
          .map((t) => {
            const range =
              t.maxQty != null
                ? `${t.minQty}–${t.maxQty} pcs`
                : `${t.minQty}+ pcs`;
            return `${range}: KES ${t.unitPrice.toFixed(2)}`;
          });
        return `Tiered: ${parts.join(' | ')}`;
      }
      return `Retail: ${retailStr}`;
    }

    default:
      return retailStr ? `Retail: ${retailStr}` : 'Price not configured';
  }
}

/**
 * Like evaluateCartPricing but returns additional metadata per line
 * to help frontends render appropriate pricing UI and enforce thresholds.
 *
 * Extra fields per result entry (beyond those from evaluateCartPricing):
 *  - retail_price          : Decimal|null
 *  - wholesale_price       : Decimal|null
 *  - is_wholesale_eligible : boolean  (true if wholesale price applies at current qty)
 *  - threshold_qty         : number|null  (qty needed to unlock wholesale)
 *  - effective_qty         : number   (qty used for threshold check; group total for GROUP_THRESHOLD)
 *  - rule_type             : string|null
 *  - rule_name             : string|null
 *  - pricing_label         : string   (human-readable summary)
 *
 * @param {Array<{product_id: number, quantity: number}>} items
 * @param {Object} productMap   - { [product_id]: productRow }
 * @param {Object} tiersMap     - { [product_id]: tierRow[] }
 * @returns {Array}
 */
function evaluateCartPricingWithMeta(items, productMap, tiersMap) {
  const safeItems = Array.isArray(items) ? items : [];

  // Pre-compute GROUP_THRESHOLD group totals
  const groupTotals = {};
  for (const item of safeItems) {
    const product = productMap[item.product_id];
    if (!product) continue;
    const rule = product._pricingRule;
    if (rule && rule.rule_type === RULE_TYPES.GROUP_THRESHOLD) {
      groupTotals[rule.id] = (groupTotals[rule.id] || 0) + item.quantity;
    }
  }

  return safeItems.map((item) => {
    const product = productMap[item.product_id];
    if (!product) {
      return {
        ...item,
        unit_price: null,
        price_source: 'unknown_product',
        retail_price: null,
        wholesale_price: null,
        is_wholesale_eligible: false,
        threshold_qty: null,
        effective_qty: item.quantity,
        rule_type: null,
        rule_name: null,
        pricing_label: 'Product not found',
      };
    }

    const tiers = tiersMap[item.product_id] || [];
    const rule = product._pricingRule || null;

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

    // Determine the threshold governing wholesale eligibility
    let threshold = null;
    if (rule) {
      threshold =
        rule.threshold_qty != null
          ? rule.threshold_qty
          : product.min_qty_wholesale != null
          ? Number(product.min_qty_wholesale)
          : null;
    } else {
      threshold =
        product.min_qty_wholesale != null
          ? Number(product.min_qty_wholesale)
          : null;
    }

    const isWholesaleEligible =
      priceSource === 'wholesale' ||
      priceSource.endsWith(':wholesale');

    const retailPrice =
      product.retail_price != null ? new Decimal(product.retail_price) : null;
    const wholesalePrice =
      product.wholesale_price != null
        ? new Decimal(product.wholesale_price)
        : null;

    const pricingLabel = describePricing(product, rule, tiers);

    return {
      ...item,
      unit_price: unitPrice,
      price_source: priceSource,
      retail_price: retailPrice,
      wholesale_price: wholesalePrice,
      is_wholesale_eligible: isWholesaleEligible,
      threshold_qty: threshold,
      effective_qty: effectiveQty,
      rule_type: rule ? rule.rule_type : null,
      rule_name: rule ? rule.name || null : null,
      pricing_label: pricingLabel,
    };
  });
}

module.exports = {
  RULE_TYPES,
  resolveItemPricing,
  evaluateCartPricing,
  evaluateCartPricingWithMeta,
  describePricing,
};
