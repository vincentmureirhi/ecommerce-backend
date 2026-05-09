'use strict';

const assert = require('assert');
const Decimal = require('decimal.js');
const { RULE_TYPES, resolveItemPricing, evaluateCartPricing, evaluateCartPricingWithMeta, describePricing } = require('./pricingRuleEvaluator');

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

console.log('pricingRuleEvaluator tests passed');

// ─────────────────────────────────────────────────────────────────────────────
// describePricing — human-readable summaries
// ─────────────────────────────────────────────────────────────────────────────

// CONSTANT rule → fixed price label (wholesale is ignored regardless of quantity)
{
  const product = { retail_price: '200', wholesale_price: '120', min_qty_wholesale: 5, requires_manual_price: false };
  const rule = { id: 1, rule_type: RULE_TYPES.CONSTANT, threshold_qty: null, name: null };
  const label = describePricing(product, rule, []);
  assert.strictEqual(label, 'Fixed price: KES 200.00');
  // Confirm wholesale is not reflected in the label (retail-only rule)
  assert.ok(!label.includes('Wholesale'), 'CONSTANT rule label must not mention wholesale');
  // Confirm the resolved price is retail only via resolveItemPricing
  const { unitPrice, priceSource } = resolveItemPricing(product, 100, [], rule);
  assert.strictEqual(unitPrice.toFixed(2), '200.00', 'CONSTANT should always return retail');
  assert.strictEqual(priceSource, 'rule:CONSTANT');
}

// SKU_THRESHOLD rule → retail|wholesale from N pcs
{
  const product = { retail_price: '121', wholesale_price: '109', min_qty_wholesale: 3, requires_manual_price: false };
  const rule = { id: 2, rule_type: RULE_TYPES.SKU_THRESHOLD, threshold_qty: 3, name: null };
  const label = describePricing(product, rule, []);
  assert.strictEqual(label, 'Retail: KES 121.00 | Wholesale: KES 109.00 from 3 pcs');
}

// SKU_THRESHOLD: threshold falls back to product.min_qty_wholesale when rule has no threshold_qty
{
  const product = { retail_price: '100', wholesale_price: '70', min_qty_wholesale: 6, requires_manual_price: false };
  const rule = { id: 2, rule_type: RULE_TYPES.SKU_THRESHOLD, threshold_qty: null, name: null };
  const label = describePricing(product, rule, []);
  assert.strictEqual(label, 'Retail: KES 100.00 | Wholesale: KES 70.00 from 6 pcs');
}

// GROUP_THRESHOLD rule → combo wholesale label without rule name
{
  const product = { retail_price: '100', wholesale_price: '70', min_qty_wholesale: 10, requires_manual_price: false };
  const rule = { id: 3, rule_type: RULE_TYPES.GROUP_THRESHOLD, threshold_qty: 10, name: null };
  const label = describePricing(product, rule, []);
  assert.strictEqual(
    label,
    'Retail: KES 100.00 | Combo wholesale: KES 70.00 when combined quantity in this group reaches 10 pcs'
  );
}

// GROUP_THRESHOLD rule → combo label WITH rule name
{
  const product = { retail_price: '100', wholesale_price: '70', min_qty_wholesale: 10, requires_manual_price: false };
  const rule = { id: 3, rule_type: RULE_TYPES.GROUP_THRESHOLD, threshold_qty: 10, name: 'Body Butters Combo' };
  const label = describePricing(product, rule, []);
  assert.strictEqual(
    label,
    'Retail: KES 100.00 | Combo wholesale: KES 70.00 when combined quantity in this group (Body Butters Combo) reaches 10 pcs'
  );
}

// TIERED rule → tier ranges listed
{
  const product = { retail_price: '100', wholesale_price: '60', min_qty_wholesale: 50, requires_manual_price: false };
  const tiers = [
    { min_qty: 1,   max_qty: 49,  unit_price: '100' },
    { min_qty: 50,  max_qty: 99,  unit_price: '47'  },
    { min_qty: 100, max_qty: null, unit_price: '45' },
  ];
  const rule = { id: 4, rule_type: RULE_TYPES.TIERED, threshold_qty: null, name: null };
  const label = describePricing(product, rule, tiers);
  assert.strictEqual(label, 'Tiered: 1–49 pcs: KES 100.00 | 50–99 pcs: KES 47.00 | 100+ pcs: KES 45.00');
}

// manual price product → special label
{
  const product = { retail_price: null, wholesale_price: null, min_qty_wholesale: null, requires_manual_price: true };
  const label = describePricing(product, null, []);
  assert.strictEqual(label, 'Price set by admin');
}

// Legacy no-rule product with wholesale threshold
{
  const product = { retail_price: '150', wholesale_price: '100', min_qty_wholesale: 5, requires_manual_price: false };
  const label = describePricing(product, null, []);
  assert.strictEqual(label, 'Retail: KES 150.00 | Wholesale: KES 100.00 from 5 pcs');
}

// Legacy no-rule product, retail only (no wholesale set)
{
  const product = { retail_price: '150', wholesale_price: null, min_qty_wholesale: null, requires_manual_price: false };
  const label = describePricing(product, null, []);
  assert.strictEqual(label, 'Retail: KES 150.00');
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateCartPricingWithMeta — wholesale eligibility metadata
// ─────────────────────────────────────────────────────────────────────────────

// SKU_THRESHOLD: below threshold → is_wholesale_eligible false
{
  const rule = { id: 5, rule_type: RULE_TYPES.SKU_THRESHOLD, threshold_qty: 3, name: null };
  const product = {
    id: 10,
    retail_price: '121', wholesale_price: '109', min_qty_wholesale: 3,
    requires_manual_price: false,
    _pricingRule: rule,
  };
  const items = [{ product_id: 10, quantity: 2 }];
  const productMap = { 10: product };
  const result = evaluateCartPricingWithMeta(items, productMap, {});
  assert.strictEqual(result[0].is_wholesale_eligible, false, 'should not be wholesale eligible below threshold');
  assert.strictEqual(result[0].threshold_qty, 3);
  assert.strictEqual(result[0].effective_qty, 2);
  assert.strictEqual(result[0].unit_price.toFixed(2), '121.00');
  assert.strictEqual(result[0].retail_price.toFixed(2), '121.00');
  assert.strictEqual(result[0].wholesale_price.toFixed(2), '109.00');
  assert.strictEqual(result[0].rule_type, RULE_TYPES.SKU_THRESHOLD);
  assert.strictEqual(typeof result[0].pricing_label, 'string');
  assert.ok(result[0].pricing_label.includes('Wholesale'));
}

// SKU_THRESHOLD: at threshold → is_wholesale_eligible true
{
  const rule = { id: 5, rule_type: RULE_TYPES.SKU_THRESHOLD, threshold_qty: 3, name: null };
  const product = {
    id: 11,
    retail_price: '121', wholesale_price: '109', min_qty_wholesale: 3,
    requires_manual_price: false,
    _pricingRule: rule,
  };
  const items = [{ product_id: 11, quantity: 3 }];
  const productMap = { 11: product };
  const result = evaluateCartPricingWithMeta(items, productMap, {});
  assert.strictEqual(result[0].is_wholesale_eligible, true, 'should be wholesale eligible at threshold');
  assert.strictEqual(result[0].unit_price.toFixed(2), '109.00');
}

// GROUP_THRESHOLD: group total meets threshold → both eligible, effective_qty is group total
{
  const rule = { id: 6, rule_type: RULE_TYPES.GROUP_THRESHOLD, threshold_qty: 10, name: 'Combo G' };
  const productA = { id: 20, retail_price: '100', wholesale_price: '70', min_qty_wholesale: 10,
    requires_manual_price: false, _pricingRule: rule };
  const productB = { id: 21, retail_price: '80', wholesale_price: '55', min_qty_wholesale: 10,
    requires_manual_price: false, _pricingRule: rule };
  const items = [{ product_id: 20, quantity: 6 }, { product_id: 21, quantity: 5 }];
  const productMap = { 20: productA, 21: productB };
  const result = evaluateCartPricingWithMeta(items, productMap, {});
  assert.strictEqual(result[0].is_wholesale_eligible, true);
  assert.strictEqual(result[0].effective_qty, 11, 'effective_qty should be group total');
  assert.strictEqual(result[0].rule_name, 'Combo G');
  assert.strictEqual(result[1].is_wholesale_eligible, true);
  assert.strictEqual(result[0].unit_price.toFixed(2), '70.00', 'productA should get wholesale price');
  assert.strictEqual(result[1].unit_price.toFixed(2), '55.00', 'productB should get wholesale price');
}

console.log('describePricing and evaluateCartPricingWithMeta tests passed');
