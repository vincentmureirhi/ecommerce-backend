'use strict';

const assert = require('assert');
const Decimal = require('decimal.js');
const { RULE_TYPES, resolveItemPricing, evaluateCartPricing, evaluateCartPricingWithMeta } = require('./pricingRuleEvaluator');

// ─────────────────────────────────────────────────────────────────────────────
// resolveItemPricing — no rule (legacy fallback)
// ─────────────────────────────────────────────────────────────────────────────

// Legacy: tier wins
{
  const product = { retail_price: '100', wholesale_price: '60', min_qty_wholesale: 10, requires_manual_price: false };
  const tiers = [
    { min_qty: 50, max_qty: 99, unit_price: '47' },
    { min_qty: 1,  max_qty: 49, unit_price: '100' },
  ];
  const { unitPrice, priceSource } = resolveItemPricing(product, 55, tiers, null);
  assert(unitPrice instanceof Decimal);
  assert.strictEqual(unitPrice.toFixed(2), '47.00');
  assert.strictEqual(priceSource, 'tier');
}

// Legacy: wholesale fallback
{
  const product = { retail_price: '100', wholesale_price: '60', min_qty_wholesale: 10, requires_manual_price: false };
  const { unitPrice, priceSource } = resolveItemPricing(product, 12, [], null);
  assert.strictEqual(unitPrice.toFixed(2), '60.00');
  assert.strictEqual(priceSource, 'wholesale');
}

// Legacy: retail fallback
{
  const product = { retail_price: '100', wholesale_price: null, min_qty_wholesale: null, requires_manual_price: false };
  const { unitPrice, priceSource } = resolveItemPricing(product, 1, [], null);
  assert.strictEqual(unitPrice.toFixed(2), '100.00');
  assert.strictEqual(priceSource, 'retail');
}

// Legacy: manual price returns null
{
  const product = { retail_price: null, wholesale_price: null, min_qty_wholesale: null, requires_manual_price: true };
  const { unitPrice, priceSource } = resolveItemPricing(product, 1, [], null);
  assert.strictEqual(unitPrice, null);
  assert.strictEqual(priceSource, 'manual_price');
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveItemPricing — CONSTANT rule
// ─────────────────────────────────────────────────────────────────────────────

// CONSTANT: always returns retail regardless of qty or tiers
{
  const product = { retail_price: '200', wholesale_price: '120', min_qty_wholesale: 5, requires_manual_price: false };
  const tiers = [{ min_qty: 10, max_qty: null, unit_price: '80' }];
  const rule = { id: 1, rule_type: RULE_TYPES.CONSTANT, threshold_qty: null };
  const { unitPrice, priceSource } = resolveItemPricing(product, 100, tiers, rule);
  assert.strictEqual(unitPrice.toFixed(2), '200.00');
  assert.strictEqual(priceSource, 'rule:CONSTANT');
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveItemPricing — SKU_THRESHOLD rule
// ─────────────────────────────────────────────────────────────────────────────

// SKU_THRESHOLD: below threshold → retail
{
  const product = { retail_price: '100', wholesale_price: '70', min_qty_wholesale: 10, requires_manual_price: false };
  const rule = { id: 2, rule_type: RULE_TYPES.SKU_THRESHOLD, threshold_qty: 10 };
  const { unitPrice, priceSource } = resolveItemPricing(product, 5, [], rule);
  assert.strictEqual(unitPrice.toFixed(2), '100.00');
  assert.strictEqual(priceSource, 'rule:SKU_THRESHOLD:retail');
}

// SKU_THRESHOLD: at threshold → wholesale
{
  const product = { retail_price: '100', wholesale_price: '70', min_qty_wholesale: 10, requires_manual_price: false };
  const rule = { id: 2, rule_type: RULE_TYPES.SKU_THRESHOLD, threshold_qty: 10 };
  const { unitPrice, priceSource } = resolveItemPricing(product, 10, [], rule);
  assert.strictEqual(unitPrice.toFixed(2), '70.00');
  assert.strictEqual(priceSource, 'rule:SKU_THRESHOLD:wholesale');
}

// SKU_THRESHOLD: threshold from rule overrides product.min_qty_wholesale
{
  const product = { retail_price: '100', wholesale_price: '70', min_qty_wholesale: 20, requires_manual_price: false };
  const rule = { id: 2, rule_type: RULE_TYPES.SKU_THRESHOLD, threshold_qty: 5 };
  const { unitPrice, priceSource } = resolveItemPricing(product, 5, [], rule);
  assert.strictEqual(unitPrice.toFixed(2), '70.00');
  assert.strictEqual(priceSource, 'rule:SKU_THRESHOLD:wholesale');
}

// SKU_THRESHOLD: no rule threshold_qty → falls back to product.min_qty_wholesale
{
  const product = { retail_price: '100', wholesale_price: '70', min_qty_wholesale: 8, requires_manual_price: false };
  const rule = { id: 2, rule_type: RULE_TYPES.SKU_THRESHOLD, threshold_qty: null };
  const { unitPrice, priceSource } = resolveItemPricing(product, 8, [], rule);
  assert.strictEqual(unitPrice.toFixed(2), '70.00');
  assert.strictEqual(priceSource, 'rule:SKU_THRESHOLD:wholesale');
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveItemPricing — GROUP_THRESHOLD rule (effectiveQty supplied by caller)
// ─────────────────────────────────────────────────────────────────────────────

// GROUP_THRESHOLD: group total below threshold → retail
{
  const product = { retail_price: '100', wholesale_price: '70', min_qty_wholesale: 10, requires_manual_price: false };
  const rule = { id: 3, rule_type: RULE_TYPES.GROUP_THRESHOLD, threshold_qty: 10 };
  const { unitPrice, priceSource } = resolveItemPricing(product, 4, [], rule);
  assert.strictEqual(unitPrice.toFixed(2), '100.00');
  assert.strictEqual(priceSource, 'rule:GROUP_THRESHOLD:retail');
}

// GROUP_THRESHOLD: group total meets threshold → wholesale
{
  const product = { retail_price: '100', wholesale_price: '70', min_qty_wholesale: 10, requires_manual_price: false };
  const rule = { id: 3, rule_type: RULE_TYPES.GROUP_THRESHOLD, threshold_qty: 10 };
  const { unitPrice, priceSource } = resolveItemPricing(product, 12, [], rule);
  assert.strictEqual(unitPrice.toFixed(2), '70.00');
  assert.strictEqual(priceSource, 'rule:GROUP_THRESHOLD:wholesale');
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveItemPricing — TIERED rule
// ─────────────────────────────────────────────────────────────────────────────

// TIERED: tier match
{
  const product = { retail_price: '100', wholesale_price: '60', min_qty_wholesale: 10, requires_manual_price: false };
  const tiers = [
    { min_qty: 1,  max_qty: 49,  unit_price: '100' },
    { min_qty: 50, max_qty: 99,  unit_price: '47' },
    { min_qty: 100, max_qty: null, unit_price: '45' },
  ];
  const rule = { id: 4, rule_type: RULE_TYPES.TIERED, threshold_qty: null };
  const { unitPrice, priceSource } = resolveItemPricing(product, 75, tiers, rule);
  assert.strictEqual(unitPrice.toFixed(2), '47.00');
  assert.strictEqual(priceSource, 'rule:TIERED:tier');
}

// TIERED: no tier match → retail
{
  const product = { retail_price: '100', wholesale_price: '60', min_qty_wholesale: 10, requires_manual_price: false };
  const rule = { id: 4, rule_type: RULE_TYPES.TIERED, threshold_qty: null };
  const { unitPrice, priceSource } = resolveItemPricing(product, 1, [], rule);
  assert.strictEqual(unitPrice.toFixed(2), '100.00');
  assert.strictEqual(priceSource, 'rule:TIERED:retail');
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateCartPricing — group threshold accumulation
// ─────────────────────────────────────────────────────────────────────────────

// Two products share GROUP_THRESHOLD rule; individually below threshold but
// combined they qualify → both get wholesale
{
  const rule = { id: 10, rule_type: RULE_TYPES.GROUP_THRESHOLD, threshold_qty: 10 };

  const productA = {
    id: 1,
    retail_price: '100', wholesale_price: '70', min_qty_wholesale: 10,
    requires_manual_price: false,
    _pricingRule: rule,
  };
  const productB = {
    id: 2,
    retail_price: '80', wholesale_price: '55', min_qty_wholesale: 10,
    requires_manual_price: false,
    _pricingRule: rule,
  };

  const items = [
    { product_id: 1, quantity: 6 },
    { product_id: 2, quantity: 5 },
  ];
  const productMap = { 1: productA, 2: productB };
  const tiersMap = {};

  const result = evaluateCartPricing(items, productMap, tiersMap);

  assert.strictEqual(result[0].unit_price.toFixed(2), '70.00', 'productA should get wholesale');
  assert.strictEqual(result[0].price_source, 'rule:GROUP_THRESHOLD:wholesale');
  assert.strictEqual(result[1].unit_price.toFixed(2), '55.00', 'productB should get wholesale');
  assert.strictEqual(result[1].price_source, 'rule:GROUP_THRESHOLD:wholesale');
}

// Two products share GROUP_THRESHOLD rule; group total is below threshold → both get retail
{
  const rule = { id: 11, rule_type: RULE_TYPES.GROUP_THRESHOLD, threshold_qty: 20 };

  const productA = {
    id: 3,
    retail_price: '100', wholesale_price: '70', min_qty_wholesale: 20,
    requires_manual_price: false,
    _pricingRule: rule,
  };
  const productB = {
    id: 4,
    retail_price: '80', wholesale_price: '55', min_qty_wholesale: 20,
    requires_manual_price: false,
    _pricingRule: rule,
  };

  const items = [
    { product_id: 3, quantity: 4 },
    { product_id: 4, quantity: 5 },
  ];
  const productMap = { 3: productA, 4: productB };
  const tiersMap = {};

  const result = evaluateCartPricing(items, productMap, tiersMap);

  assert.strictEqual(result[0].unit_price.toFixed(2), '100.00');
  assert.strictEqual(result[0].price_source, 'rule:GROUP_THRESHOLD:retail');
  assert.strictEqual(result[1].unit_price.toFixed(2), '80.00');
  assert.strictEqual(result[1].price_source, 'rule:GROUP_THRESHOLD:retail');
}

// Products with different rules are NOT grouped together
{
  const ruleA = { id: 20, rule_type: RULE_TYPES.GROUP_THRESHOLD, threshold_qty: 10 };
  const ruleB = { id: 21, rule_type: RULE_TYPES.GROUP_THRESHOLD, threshold_qty: 10 };

  const productA = {
    id: 5,
    retail_price: '100', wholesale_price: '70', min_qty_wholesale: 10,
    requires_manual_price: false,
    _pricingRule: ruleA,
  };
  const productB = {
    id: 6,
    retail_price: '80', wholesale_price: '55', min_qty_wholesale: 10,
    requires_manual_price: false,
    _pricingRule: ruleB,
  };

  const items = [
    { product_id: 5, quantity: 6 },
    { product_id: 6, quantity: 7 },
  ];
  const productMap = { 5: productA, 6: productB };
  const tiersMap = {};

  const result = evaluateCartPricing(items, productMap, tiersMap);

  // Each rule group total < 10 → both retail
  assert.strictEqual(result[0].unit_price.toFixed(2), '100.00');
  assert.strictEqual(result[0].price_source, 'rule:GROUP_THRESHOLD:retail');
  assert.strictEqual(result[1].unit_price.toFixed(2), '80.00');
  assert.strictEqual(result[1].price_source, 'rule:GROUP_THRESHOLD:retail');
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateCartPricing — product without rule uses legacy fallback
// ─────────────────────────────────────────────────────────────────────────────
{
  const product = {
    id: 99,
    retail_price: '150', wholesale_price: '100', min_qty_wholesale: 5,
    requires_manual_price: false,
    _pricingRule: null,
  };
  const items = [{ product_id: 99, quantity: 6 }];
  const productMap = { 99: product };
  const tiersMap = {};

  const result = evaluateCartPricing(items, productMap, tiersMap);

  assert.strictEqual(result[0].unit_price.toFixed(2), '100.00');
  assert.strictEqual(result[0].price_source, 'wholesale');
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateCartPricingWithMeta — wholesale threshold enforcement
// Tests cover the loophole: client requests wholesale below threshold must be
// detectable (is_wholesale_eligible=false) so the order controller can reject
// them with HTTP 422.
// ─────────────────────────────────────────────────────────────────────────────

// SKU_THRESHOLD: qty below threshold → is_wholesale_eligible=false, threshold_qty populated
{
  const product = {
    id: 100,
    retail_price: '100', wholesale_price: '70', min_qty_wholesale: 3,
    requires_manual_price: false,
    _pricingRule: { id: 30, rule_type: RULE_TYPES.SKU_THRESHOLD, threshold_qty: 3, name: 'Min3' },
  };
  const items = [{ product_id: 100, quantity: 1 }];
  const productMap = { 100: product };
  const tiersMap = {};

  const result = evaluateCartPricingWithMeta(items, productMap, tiersMap);

  assert.strictEqual(result[0].is_wholesale_eligible, false, 'qty 1 < threshold 3 → not eligible');
  assert.strictEqual(result[0].threshold_qty, 3, 'threshold_qty must be 3');
  assert.strictEqual(result[0].effective_qty, 1, 'effective_qty is individual qty for SKU_THRESHOLD');
  assert.strictEqual(result[0].rule_type, RULE_TYPES.SKU_THRESHOLD);
  assert.strictEqual(result[0].pricing_label, `retail (${RULE_TYPES.SKU_THRESHOLD})`);
  assert.strictEqual(result[0].unit_price.toFixed(2), '100.00');
}

// SKU_THRESHOLD: qty at threshold → is_wholesale_eligible=true
{
  const product = {
    id: 101,
    retail_price: '100', wholesale_price: '70', min_qty_wholesale: 3,
    requires_manual_price: false,
    _pricingRule: { id: 31, rule_type: RULE_TYPES.SKU_THRESHOLD, threshold_qty: 3, name: 'Min3' },
  };
  const items = [{ product_id: 101, quantity: 3 }];
  const productMap = { 101: product };
  const tiersMap = {};

  const result = evaluateCartPricingWithMeta(items, productMap, tiersMap);

  assert.strictEqual(result[0].is_wholesale_eligible, true, 'qty 3 = threshold 3 → eligible');
  assert.strictEqual(result[0].threshold_qty, 3);
  assert.strictEqual(result[0].effective_qty, 3);
  assert.strictEqual(result[0].pricing_label, `wholesale (${RULE_TYPES.SKU_THRESHOLD})`);
  assert.strictEqual(result[0].unit_price.toFixed(2), '70.00');
}

// SKU_THRESHOLD: qty above threshold → eligible
{
  const product = {
    id: 102,
    retail_price: '100', wholesale_price: '70', min_qty_wholesale: 3,
    requires_manual_price: false,
    _pricingRule: { id: 32, rule_type: RULE_TYPES.SKU_THRESHOLD, threshold_qty: 3, name: 'Min3' },
  };
  const items = [{ product_id: 102, quantity: 5 }];
  const productMap = { 102: product };
  const tiersMap = {};

  const result = evaluateCartPricingWithMeta(items, productMap, tiersMap);

  assert.strictEqual(result[0].is_wholesale_eligible, true, 'qty 5 > threshold 3 → eligible');
  assert.strictEqual(result[0].unit_price.toFixed(2), '70.00');
}

// GROUP_THRESHOLD: group total below threshold → both items is_wholesale_eligible=false
{
  const rule = { id: 40, rule_type: RULE_TYPES.GROUP_THRESHOLD, threshold_qty: 5, name: 'Grp5' };
  const productA = {
    id: 103,
    retail_price: '100', wholesale_price: '70', min_qty_wholesale: 5,
    requires_manual_price: false,
    _pricingRule: rule,
  };
  const productB = {
    id: 104,
    retail_price: '80', wholesale_price: '55', min_qty_wholesale: 5,
    requires_manual_price: false,
    _pricingRule: rule,
  };

  const items = [
    { product_id: 103, quantity: 1 },
    { product_id: 104, quantity: 2 },
  ];
  const productMap = { 103: productA, 104: productB };
  const tiersMap = {};

  // Group total = 3, threshold = 5 → below threshold
  const result = evaluateCartPricingWithMeta(items, productMap, tiersMap);

  assert.strictEqual(result[0].is_wholesale_eligible, false, 'GROUP_THRESHOLD group total 3 < 5 → not eligible');
  assert.strictEqual(result[0].effective_qty, 3, 'effective_qty is group total for GROUP_THRESHOLD');
  assert.strictEqual(result[0].threshold_qty, 5);
  assert.strictEqual(result[0].unit_price.toFixed(2), '100.00');
  assert.strictEqual(result[1].is_wholesale_eligible, false);
  assert.strictEqual(result[1].effective_qty, 3);
  assert.strictEqual(result[1].unit_price.toFixed(2), '80.00');
}

// GROUP_THRESHOLD: group total at threshold → both items is_wholesale_eligible=true
{
  const rule = { id: 41, rule_type: RULE_TYPES.GROUP_THRESHOLD, threshold_qty: 5, name: 'Grp5' };
  const productA = {
    id: 105,
    retail_price: '100', wholesale_price: '70', min_qty_wholesale: 5,
    requires_manual_price: false,
    _pricingRule: rule,
  };
  const productB = {
    id: 106,
    retail_price: '80', wholesale_price: '55', min_qty_wholesale: 5,
    requires_manual_price: false,
    _pricingRule: rule,
  };

  const items = [
    { product_id: 105, quantity: 3 },
    { product_id: 106, quantity: 2 },
  ];
  const productMap = { 105: productA, 106: productB };
  const tiersMap = {};

  // Group total = 5, threshold = 5 → at threshold
  const result = evaluateCartPricingWithMeta(items, productMap, tiersMap);

  assert.strictEqual(result[0].is_wholesale_eligible, true, 'GROUP_THRESHOLD group total 5 = threshold 5 → eligible');
  assert.strictEqual(result[0].effective_qty, 5);
  assert.strictEqual(result[0].unit_price.toFixed(2), '70.00');
  assert.strictEqual(result[1].is_wholesale_eligible, true);
  assert.strictEqual(result[1].effective_qty, 5);
  assert.strictEqual(result[1].unit_price.toFixed(2), '55.00');
}

// Legacy (no pricing rule): qty below min_qty_wholesale → is_wholesale_eligible=false
{
  const product = {
    id: 107,
    retail_price: '100', wholesale_price: '70', min_qty_wholesale: 5,
    requires_manual_price: false,
    _pricingRule: null,
  };
  const items = [{ product_id: 107, quantity: 2 }];
  const productMap = { 107: product };
  const tiersMap = {};

  const result = evaluateCartPricingWithMeta(items, productMap, tiersMap);

  assert.strictEqual(result[0].is_wholesale_eligible, false, 'legacy: qty 2 < min_qty_wholesale 5 → not eligible');
  assert.strictEqual(result[0].threshold_qty, 5, 'legacy threshold is product.min_qty_wholesale');
  assert.strictEqual(result[0].rule_type, 'legacy');
  assert.strictEqual(result[0].unit_price.toFixed(2), '100.00');
}

// Legacy (no pricing rule): qty at min_qty_wholesale → is_wholesale_eligible=true
{
  const product = {
    id: 108,
    retail_price: '100', wholesale_price: '70', min_qty_wholesale: 5,
    requires_manual_price: false,
    _pricingRule: null,
  };
  const items = [{ product_id: 108, quantity: 5 }];
  const productMap = { 108: product };
  const tiersMap = {};

  const result = evaluateCartPricingWithMeta(items, productMap, tiersMap);

  assert.strictEqual(result[0].is_wholesale_eligible, true, 'legacy: qty 5 = min_qty_wholesale 5 → eligible');
  assert.strictEqual(result[0].threshold_qty, 5);
  assert.strictEqual(result[0].unit_price.toFixed(2), '70.00');
}

// CONSTANT rule: is_wholesale_eligible is always false (no threshold-based wholesale)
{
  const product = {
    id: 109,
    retail_price: '200', wholesale_price: '120', min_qty_wholesale: 1,
    requires_manual_price: false,
    _pricingRule: { id: 50, rule_type: RULE_TYPES.CONSTANT, threshold_qty: null, name: 'ConstantRule' },
  };
  const items = [{ product_id: 109, quantity: 100 }];
  const productMap = { 109: product };
  const tiersMap = {};

  const result = evaluateCartPricingWithMeta(items, productMap, tiersMap);

  assert.strictEqual(result[0].is_wholesale_eligible, false, 'CONSTANT rule never grants wholesale');
  assert.strictEqual(result[0].threshold_qty, null, 'CONSTANT rule has no threshold');
  assert.strictEqual(result[0].unit_price.toFixed(2), '200.00');
  assert.strictEqual(result[0].pricing_label, 'constant');
}

// evaluateCartPricing delegates to evaluateCartPricingWithMeta — backward compatible
{
  const product = {
    id: 110,
    retail_price: '100', wholesale_price: '70', min_qty_wholesale: 3,
    requires_manual_price: false,
    _pricingRule: { id: 60, rule_type: RULE_TYPES.SKU_THRESHOLD, threshold_qty: 3, name: 'Min3' },
  };
  const items = [{ product_id: 110, quantity: 3 }];
  const productMap = { 110: product };
  const tiersMap = {};

  const result = evaluateCartPricing(items, productMap, tiersMap);

  // evaluateCartPricing must still return unit_price and price_source
  assert.strictEqual(result[0].unit_price.toFixed(2), '70.00', 'evaluateCartPricing backward-compatible');
  assert.strictEqual(result[0].price_source, 'rule:SKU_THRESHOLD:wholesale');
}

console.log('pricingRuleEvaluator tests passed');
