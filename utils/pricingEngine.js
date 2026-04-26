'use strict';

const Decimal = require('decimal.js');

/**
 * Helpers
 */
function toInt(v, fieldName) {
  if (v == null) return null;

  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`${fieldName} must be a finite number`);
  }

  const i = Math.trunc(n);
  if (i !== n) {
    throw new Error(`${fieldName} must be an integer`);
  }

  return i;
}

function toDecimal(v, fieldName) {
  if (v == null) return null;
  try {
    const d = new Decimal(v);
    if (!d.isFinite()) throw new Error('not finite');
    return d;
  } catch {
    throw new Error(`${fieldName} must be a valid decimal number`);
  }
}

function appendSource(existing, suffix) {
  if (!existing) return suffix;
  if (String(existing).includes(suffix)) return String(existing);
  return `${existing}+${suffix}`;
}

/**
 * Rule priority per line:
 * 1) requires_manual_price => null
 * 2) tier match => tier.unit_price
 * 3) wholesale if qty >= min_qty_wholesale
 * 4) retail
 * 5) else null
 *
 * Returns: Decimal | null
 */
function resolveProductUnitPrice(product, qty, tiers = []) {
  const q = toInt(qty, 'qty');
  if (q == null || q < 1) throw new Error('qty must be an integer >= 1');

  if (!product || typeof product !== 'object') {
    throw new Error('product is required');
  }

  if (product.requires_manual_price) return null;

  const retail = toDecimal(product.retail_price, 'product.retail_price');
  const wholesale = toDecimal(product.wholesale_price, 'product.wholesale_price');
  const minWholesaleQty = toInt(product.min_qty_wholesale, 'product.min_qty_wholesale');

  // Normalize tiers
  const normalizedTiers = (Array.isArray(tiers) ? tiers : [])
    .map((t, idx) => {
      const minQty = toInt(t.min_qty, `tiers[${idx}].min_qty`);
      const maxQty = t.max_qty == null ? null : toInt(t.max_qty, `tiers[${idx}].max_qty`);
      const unitPrice = toDecimal(t.unit_price, `tiers[${idx}].unit_price`);

      if (minQty == null || minQty < 1) return null;
      if (maxQty != null && maxQty < minQty) return null;
      if (unitPrice == null || unitPrice.isNegative()) return null;

      return { minQty, maxQty, unitPrice };
    })
    .filter(Boolean)
    .sort((a, b) => b.minQty - a.minQty);

  const tierHit = normalizedTiers.find(
    (t) => q >= t.minQty && (t.maxQty == null || q <= t.maxQty)
  );

  if (tierHit) return tierHit.unitPrice;

  if (wholesale != null && minWholesaleQty != null && q >= minWholesaleQty) {
    return wholesale;
  }

  if (retail != null) return retail;

  return null;
}

/**
 * @deprecated Category-based combo pricing is no longer the active pricing model.
 *
 * The `categories.combo_discount_qty` / `combo_discount_price` fields and this
 * function are retained for backward compatibility only.  New products should use
 * named `pricing_rules` (CONSTANT, SKU_THRESHOLD, GROUP_THRESHOLD, TIERED) instead.
 * See `utils/pricingRuleEvaluator.js` and `docs/pricing-precedence.md`.
 *
 * Categories remain taxonomy/inventory-oriented entities.
 * They are NOT the pricing engine.
 *
 * ── Original behaviour (preserved for legacy callers) ────────────────────────
 * Category combo discount (FIXED v5):
 * ONLY applies to LOW-VALUE products (price < 1000kes)
 *
 * Only apply combo if:
 * 1. Category total qty >= combo_discount_qty
 * 2. Product unit price < 1000kes (low-value items only)
 * 3. Product is NOT using tier pricing
 * 4. Product is NOT manual-price
 * 5. Combo price is lower than current prices
 *
 * Rules:
 * - Never raises prices
 * - Never touches manual_price lines
 * - Never touches lines with unit_price = null
 * - SKIP if this specific product uses tier pricing
 * - SKIP if product is high-value (>= 1000kes)
 * - Distributes combo total price evenly across ELIGIBLE items in category
 * - Returns a new array (does not mutate original)
 */
function applyCategoryComboDiscounts(lines, categories, productTiers = {}) {
  const safeLines = Array.isArray(lines) ? lines : [];
  const safeCats = Array.isArray(categories) ? categories : [];
  const safeProductTiers = productTiers || {};

  // Constant: only apply combo to items under this price
  const COMBO_MAX_PRICE = new Decimal('1000');

  // Build category map with validated values
  const catMap = new Map();
  for (const c of safeCats) {
    const id = toInt(c.id, 'category.id');
    if (id == null) continue;

    const comboQty = toInt(c.combo_discount_qty, `category(${id}).combo_discount_qty`);
    const comboPrice = toDecimal(c.combo_discount_price, `category(${id}).combo_discount_price`);

    catMap.set(id, { id, comboQty, comboPrice });
  }

  // Total qty per category (only count valid lines)
  const qtyByCat = {};
  for (const l of safeLines) {
    const catId = toInt(l.category_id, 'line.category_id');
    if (catId == null) continue;

    const q = toInt(l.qty, 'line.qty');
    if (q == null || q < 1) continue;

    qtyByCat[catId] = (qtyByCat[catId] || 0) + q;
  }

  // Count eligible items per category (low-value, not tiered, not manual)
  const eligibleQtyByCat = {};
  for (const l of safeLines) {
    const catId = toInt(l.category_id, 'line.category_id');
    if (catId == null) continue;

    // Skip manual-price lines
    if (l.price_source === 'manual_price') continue;

    // Skip if product has tiers
    const productId = toInt(l.product_id, 'line.product_id');
    if (productId != null && safeProductTiers[productId]) continue;

    // Skip HIGH-VALUE items (>= 1000kes)
    const unitPrice = toDecimal(l.unit_price, 'line.unit_price');
    if (unitPrice != null && unitPrice.greaterThanOrEqualTo(COMBO_MAX_PRICE)) continue;

    const q = toInt(l.qty, 'line.qty');
    if (q == null || q < 1) continue;

    eligibleQtyByCat[catId] = (eligibleQtyByCat[catId] || 0) + q;
  }

  return safeLines.map((l) => {
    const catId = toInt(l.category_id, 'line.category_id');
    const cat = catId == null ? null : catMap.get(catId);
    if (!cat) return l;

    if (cat.comboQty == null || cat.comboPrice == null) return l;

    const eligibleQty = eligibleQtyByCat[catId] || 0;

    // COMBO ONLY APPLIES IF ELIGIBLE QTY >= THRESHOLD
    if (eligibleQty < cat.comboQty) return l;

    // Never touch manual-price lines
    if (l.price_source === 'manual_price') return l;

    // If unit_price is null, it's manual/invalid => untouched
    if (l.unit_price == null) return l;

    const current = toDecimal(l.unit_price, 'line.unit_price');
    if (current == null) return l;

    // ===== KEY FIX v5: Skip high-value items =====
    if (current.greaterThanOrEqualTo(COMBO_MAX_PRICE)) {
      return l;
    }

    // ===== Skip if THIS PRODUCT has tiers =====
    const productId = toInt(l.product_id, 'line.product_id');
    if (productId != null && safeProductTiers[productId]) {
      return l;
    }

    // Calculate per-unit combo price (distribute total across ELIGIBLE items only)
    const comboUnitPrice = cat.comboPrice.div(eligibleQty);

    // CAP: only apply if it reduces price
    if (comboUnitPrice.greaterThanOrEqualTo(current)) return l;

    return {
      ...l,
      unit_price: comboUnitPrice,
      price_source: appendSource(l.price_source, 'category_combo_cap'),
    };
  });
}

/**
 * Compute line total safely
 * Returns Decimal
 */
function computeLineTotal(unitPrice, qty) {
  const q = toInt(qty, 'qty');
  if (q == null || q < 1) throw new Error('qty must be an integer >= 1');

  const price = toDecimal(unitPrice, 'unitPrice');
  if (price == null) throw new Error('unitPrice is required');

  return price.mul(q);
}

module.exports = {
  resolveProductUnitPrice,
  applyCategoryComboDiscounts,
  computeLineTotal,
};