'use strict';

/**
 * pricingRuleEvaluator.test.js
 * ============================
 * Unit tests for evaluateCartPricing().
 * No database required — all tests use in-memory productMap / tiersMap.
 *
 * Run with: node utils/pricingRuleEvaluator.test.js
 */

const assert = require('assert');
const Decimal = require('decimal.js');
const { evaluateCartPricing } = require('./pricingRuleEvaluator');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function makeProduct(overrides = {}) {
  const defaults = {
    id:                    1,
    name:                  'Test Product',
    sku:                   'SKU-001',
    retail_price:          '100.00',
    wholesale_price:       '60.00',
    min_qty_wholesale:     10,
    requires_manual_price: false,
    current_stock:         100,
    pricing_rule:          null,
  };
  // Use explicit Object.assign so that null overrides are respected
  // (the ?? operator would ignore explicit null values)
  return Object.assign({}, defaults, overrides);
}

function makeProductMap(...products) {
  const map = new Map();
  for (const p of products) map.set(p.id, p);
  return map;
}

function makeTiersMap(entries = {}) {
  const map = new Map();
  for (const [productId, tiers] of Object.entries(entries)) {
    map.set(Number(productId), tiers);
  }
  return map;
}

function run(items, productMap, tiersMap = new Map()) {
  return evaluateCartPricing(items, productMap, tiersMap);
}

// ─────────────────────────────────────────────────────────────
// 1. RETAIL FALLBACK (no pricing rule, qty below wholesale threshold)
// ─────────────────────────────────────────────────────────────
{
  const product = makeProduct({ id: 1, min_qty_wholesale: 10 });
  const result  = run(
    [{ product_id: 1, quantity: 3 }],
    makeProductMap(product)
  );

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].price_source, 'retail_fallback');
  assert(result[0].unit_price instanceof Decimal);
  assert.strictEqual(result[0].unit_price.toFixed(2), '100.00');
  assert.strictEqual(result[0].line_total.toFixed(2),  '300.00');
  assert.strictEqual(result[0].pricing_rule_id, null);
  assert.strictEqual(result[0].rule_type, null);
}

// ─────────────────────────────────────────────────────────────
// 2. WHOLESALE via legacy same-SKU threshold (no pricing rule)
//    — product.min_qty_wholesale path
// ─────────────────────────────────────────────────────────────
{
  const product = makeProduct({ id: 1, min_qty_wholesale: 10 });
  const result  = run(
    [{ product_id: 1, quantity: 10 }],
    makeProductMap(product)
  );

  assert.strictEqual(result[0].price_source, 'wholesale');
  assert.strictEqual(result[0].unit_price.toFixed(2), '60.00');
  assert.strictEqual(result[0].line_total.toFixed(2),  '600.00');
}

// Wholesale at qty exactly equal to threshold
{
  const product = makeProduct({ id: 1, min_qty_wholesale: 5 });
  const result  = run(
    [{ product_id: 1, quantity: 5 }],
    makeProductMap(product)
  );
  assert.strictEqual(result[0].price_source, 'wholesale');
}

// Just below wholesale threshold → retail_fallback
{
  const product = makeProduct({ id: 1, min_qty_wholesale: 5 });
  const result  = run(
    [{ product_id: 1, quantity: 4 }],
    makeProductMap(product)
  );
  assert.strictEqual(result[0].price_source, 'retail_fallback');
}

// ─────────────────────────────────────────────────────────────
// 3. TIER pricing in legacy fallback mode (product_price_tiers present)
// ─────────────────────────────────────────────────────────────
{
  const product = makeProduct({ id: 2, retail_price: '100', wholesale_price: '60', min_qty_wholesale: 50 });
  const tiers   = [
    { min_qty: 1,  max_qty: 49, unit_price: '100' },
    { min_qty: 50, max_qty: 99, unit_price: '80'  },
    { min_qty: 100, max_qty: null, unit_price: '60' },
  ];

  const result = run(
    [{ product_id: 2, quantity: 55 }],
    makeProductMap(product),
    makeTiersMap({ 2: tiers })
  );
  assert.strictEqual(result[0].price_source, 'tier');
  assert.strictEqual(result[0].unit_price.toFixed(2), '80.00');
}

// ─────────────────────────────────────────────────────────────
// 4. SKU_THRESHOLD rule — below threshold → retail_fallback
// ─────────────────────────────────────────────────────────────
{
  const rule = { id: 10, name: 'Bulk Discount', rule_type: 'SKU_THRESHOLD', threshold_qty: 6 };
  const product = makeProduct({ id: 3, pricing_rule: rule });
  const result  = run(
    [{ product_id: 3, quantity: 5 }],
    makeProductMap(product)
  );

  assert.strictEqual(result[0].price_source, 'retail_fallback');
  assert.strictEqual(result[0].unit_price.toFixed(2), '100.00');
  assert.strictEqual(result[0].pricing_rule_id, 10);
  assert.strictEqual(result[0].rule_type, 'SKU_THRESHOLD');
}

// SKU_THRESHOLD — at threshold → sku_threshold (wholesale price)
{
  const rule = { id: 10, name: 'Bulk Discount', rule_type: 'SKU_THRESHOLD', threshold_qty: 6 };
  const product = makeProduct({ id: 3, pricing_rule: rule });
  const result  = run(
    [{ product_id: 3, quantity: 6 }],
    makeProductMap(product)
  );

  assert.strictEqual(result[0].price_source, 'sku_threshold');
  assert.strictEqual(result[0].unit_price.toFixed(2), '60.00');
  assert.strictEqual(result[0].line_total.toFixed(2),  '360.00');
}

// SKU_THRESHOLD — above threshold
{
  const rule = { id: 10, name: 'Bulk Discount', rule_type: 'SKU_THRESHOLD', threshold_qty: 6 };
  const product = makeProduct({ id: 3, pricing_rule: rule });
  const result  = run(
    [{ product_id: 3, quantity: 20 }],
    makeProductMap(product)
  );
  assert.strictEqual(result[0].price_source, 'sku_threshold');
}

// SKU_THRESHOLD — two different products each have their own SKU_THRESHOLD rule
// Each is evaluated independently (group totals do not cross-contaminate)
{
  const ruleA = { id: 10, name: 'A Bulk', rule_type: 'SKU_THRESHOLD', threshold_qty: 5 };
  const ruleB = { id: 11, name: 'B Bulk', rule_type: 'SKU_THRESHOLD', threshold_qty: 5 };
  const pA = makeProduct({ id: 1, pricing_rule: ruleA });
  const pB = makeProduct({ id: 2, pricing_rule: ruleB });

  const result = run(
    [{ product_id: 1, quantity: 3 }, { product_id: 2, quantity: 3 }],
    makeProductMap(pA, pB)
  );
  // Neither reaches its own threshold of 5
  assert.strictEqual(result[0].price_source, 'retail_fallback');
  assert.strictEqual(result[1].price_source, 'retail_fallback');
}

// ─────────────────────────────────────────────────────────────
// 5. GROUP_THRESHOLD rule — group total below threshold
// ─────────────────────────────────────────────────────────────
{
  const rule = { id: 20, name: 'Group Wholesale', rule_type: 'GROUP_THRESHOLD', threshold_qty: 10 };
  const pA   = makeProduct({ id: 4, pricing_rule: rule });
  const pB   = makeProduct({ id: 5, pricing_rule: rule });

  const result = run(
    [{ product_id: 4, quantity: 3 }, { product_id: 5, quantity: 4 }],
    makeProductMap(pA, pB)
  );
  // 3 + 4 = 7 < 10 → retail_fallback for both
  assert.strictEqual(result[0].price_source, 'retail_fallback');
  assert.strictEqual(result[1].price_source, 'retail_fallback');
  assert.strictEqual(result[0].pricing_rule_id, 20);
  assert.strictEqual(result[0].rule_type, 'GROUP_THRESHOLD');
}

// GROUP_THRESHOLD — total at threshold
{
  const rule = { id: 20, name: 'Group Wholesale', rule_type: 'GROUP_THRESHOLD', threshold_qty: 10 };
  const pA   = makeProduct({ id: 4, pricing_rule: rule });
  const pB   = makeProduct({ id: 5, pricing_rule: rule });

  const result = run(
    [{ product_id: 4, quantity: 6 }, { product_id: 5, quantity: 4 }],
    makeProductMap(pA, pB)
  );
  // 6 + 4 = 10 >= 10 → group_threshold for both
  assert.strictEqual(result[0].price_source, 'group_threshold');
  assert.strictEqual(result[0].unit_price.toFixed(2), '60.00');
  assert.strictEqual(result[1].price_source, 'group_threshold');
}

// GROUP_THRESHOLD — products with different rules are NOT grouped together
{
  const ruleX = { id: 30, name: 'X Group', rule_type: 'GROUP_THRESHOLD', threshold_qty: 5 };
  const ruleY = { id: 31, name: 'Y Group', rule_type: 'GROUP_THRESHOLD', threshold_qty: 5 };
  const pX = makeProduct({ id: 6, pricing_rule: ruleX });
  const pY = makeProduct({ id: 7, pricing_rule: ruleY });

  const result = run(
    [{ product_id: 6, quantity: 3 }, { product_id: 7, quantity: 3 }],
    makeProductMap(pX, pY)
  );
  // Each group total is 3, below threshold 5
  assert.strictEqual(result[0].price_source, 'retail_fallback');
  assert.strictEqual(result[1].price_source, 'retail_fallback');
}

// GROUP_THRESHOLD — only products sharing the same rule_id are grouped
{
  const ruleX = { id: 30, name: 'X Group', rule_type: 'GROUP_THRESHOLD', threshold_qty: 5 };
  const pX1 = makeProduct({ id: 8,  pricing_rule: ruleX });
  const pX2 = makeProduct({ id: 9,  pricing_rule: ruleX });
  const pX3 = makeProduct({ id: 10, pricing_rule: ruleX });

  const result = run(
    [
      { product_id: 8,  quantity: 2 },
      { product_id: 9,  quantity: 2 },
      { product_id: 10, quantity: 1 },
    ],
    makeProductMap(pX1, pX2, pX3)
  );
  // 2+2+1=5 >= 5 → all unlock group_threshold
  assert.strictEqual(result[0].price_source, 'group_threshold');
  assert.strictEqual(result[1].price_source, 'group_threshold');
  assert.strictEqual(result[2].price_source, 'group_threshold');
}

// ─────────────────────────────────────────────────────────────
// 6. TIERED rule — uses product_price_tiers
// ─────────────────────────────────────────────────────────────
{
  const rule    = { id: 40, name: 'Volume Pricing', rule_type: 'TIERED', threshold_qty: null };
  const product = makeProduct({ id: 11, pricing_rule: rule });
  const tiers   = [
    { min_qty: 1,   max_qty: 49,  unit_price: '100' },
    { min_qty: 50,  max_qty: 99,  unit_price: '85'  },
    { min_qty: 100, max_qty: null, unit_price: '70'  },
  ];

  // Tier 1
  let result = run(
    [{ product_id: 11, quantity: 30 }],
    makeProductMap(product),
    makeTiersMap({ 11: tiers })
  );
  assert.strictEqual(result[0].price_source, 'tiered');
  assert.strictEqual(result[0].unit_price.toFixed(2), '100.00');

  // Tier 2
  result = run(
    [{ product_id: 11, quantity: 60 }],
    makeProductMap(product),
    makeTiersMap({ 11: tiers })
  );
  assert.strictEqual(result[0].price_source, 'tiered');
  assert.strictEqual(result[0].unit_price.toFixed(2), '85.00');
  assert.strictEqual(result[0].line_total.toFixed(2),  '5100.00');

  // Tier 3 (open-ended)
  result = run(
    [{ product_id: 11, quantity: 100 }],
    makeProductMap(product),
    makeTiersMap({ 11: tiers })
  );
  assert.strictEqual(result[0].price_source, 'tiered');
  assert.strictEqual(result[0].unit_price.toFixed(2), '70.00');
}

// ─────────────────────────────────────────────────────────────
// 7. CONSTANT rule — always retail price regardless of qty
// ─────────────────────────────────────────────────────────────
{
  const rule    = { id: 50, name: 'Fixed Price', rule_type: 'CONSTANT', threshold_qty: null };
  const product = makeProduct({ id: 12, pricing_rule: rule });

  // Low quantity
  let result = run(
    [{ product_id: 12, quantity: 1 }],
    makeProductMap(product)
  );
  assert.strictEqual(result[0].price_source, 'constant');
  assert.strictEqual(result[0].unit_price.toFixed(2), '100.00');

  // High quantity — price does NOT change to wholesale
  result = run(
    [{ product_id: 12, quantity: 500 }],
    makeProductMap(product)
  );
  assert.strictEqual(result[0].price_source, 'constant');
  assert.strictEqual(result[0].unit_price.toFixed(2), '100.00');
}

// ─────────────────────────────────────────────────────────────
// 8. requires_manual_price — always returns null price
// ─────────────────────────────────────────────────────────────
{
  const product = makeProduct({ id: 13, requires_manual_price: true });
  const result  = run(
    [{ product_id: 13, quantity: 1 }],
    makeProductMap(product)
  );
  assert.strictEqual(result[0].price_source, 'manual_price');
  assert.strictEqual(result[0].unit_price, null);
  assert.strictEqual(result[0].line_total, null);
}

// ─────────────────────────────────────────────────────────────
// 9. Mixed cart — different rule types in the same order
// ─────────────────────────────────────────────────────────────
{
  const noRule    = makeProduct({ id: 1 });                                             // legacy fallback
  const skuRule   = makeProduct({ id: 2, pricing_rule: { id: 10, rule_type: 'SKU_THRESHOLD', threshold_qty: 5 } });
  const grpRule   = makeProduct({ id: 3, pricing_rule: { id: 20, rule_type: 'GROUP_THRESHOLD', threshold_qty: 8 } });
  const grpRule2  = makeProduct({ id: 4, pricing_rule: { id: 20, rule_type: 'GROUP_THRESHOLD', threshold_qty: 8 } });
  const constRule = makeProduct({ id: 5, pricing_rule: { id: 30, rule_type: 'CONSTANT', threshold_qty: null } });

  const items = [
    { product_id: 1, quantity: 2  },  // retail_fallback (qty 2 < min_qty_wholesale 10)
    { product_id: 2, quantity: 5  },  // sku_threshold  (qty 5 >= threshold 5)
    { product_id: 3, quantity: 5  },  // group total for rule 20 = 5+3 = 8 >= 8 → group_threshold
    { product_id: 4, quantity: 3  },  // group total for rule 20 = 8 >= 8 → group_threshold
    { product_id: 5, quantity: 100},  // constant (always retail)
  ];

  const result = run(items, makeProductMap(noRule, skuRule, grpRule, grpRule2, constRule));

  assert.strictEqual(result[0].price_source, 'retail_fallback');
  assert.strictEqual(result[1].price_source, 'sku_threshold');
  assert.strictEqual(result[2].price_source, 'group_threshold');
  assert.strictEqual(result[3].price_source, 'group_threshold');
  assert.strictEqual(result[4].price_source, 'constant');
}

// ─────────────────────────────────────────────────────────────
// 10. Guest checkout pricing integrity
//     — verifies all non-manual products receive a non-null price
//     — verifies price_source is consistently written
// ─────────────────────────────────────────────────────────────
{
  const products = [
    makeProduct({ id: 1 }),                                                              // retail_fallback
    makeProduct({ id: 2, min_qty_wholesale: 5 }),                                        // wholesale at qty 5
    makeProduct({ id: 3, pricing_rule: { id: 10, rule_type: 'SKU_THRESHOLD', threshold_qty: 3 } }), // sku_threshold
  ];

  const items = [
    { product_id: 1, quantity: 1  },
    { product_id: 2, quantity: 5  },
    { product_id: 3, quantity: 3  },
  ];

  const result = run(items, makeProductMap(...products));

  for (const r of result) {
    // All prices are non-null (no manual-price products in this scenario)
    assert.notStrictEqual(r.unit_price, null, `unit_price should not be null for product ${r.product_id}`);
    assert.notStrictEqual(r.price_source, null, `price_source must be set for product ${r.product_id}`);
    assert.notStrictEqual(r.price_source, '', `price_source must not be empty`);
  }

  assert.strictEqual(result[0].price_source, 'retail_fallback');
  assert.strictEqual(result[1].price_source, 'wholesale');
  assert.strictEqual(result[2].price_source, 'sku_threshold');
}

// ─────────────────────────────────────────────────────────────
// 11. Order creation price_source population
//     — every resolved item has pricing_rule_id and rule_type set
//       when a rule is applied
// ─────────────────────────────────────────────────────────────
{
  const rule    = { id: 10, rule_type: 'SKU_THRESHOLD', threshold_qty: 5 };
  const product = makeProduct({ id: 1, pricing_rule: rule });
  const result  = run([{ product_id: 1, quantity: 5 }], makeProductMap(product));

  assert.strictEqual(result[0].pricing_rule_id, 10);
  assert.strictEqual(result[0].rule_type, 'SKU_THRESHOLD');
}

// Legacy fallback products have null pricing_rule_id and null rule_type
{
  const product = makeProduct({ id: 1 });
  const result  = run([{ product_id: 1, quantity: 1 }], makeProductMap(product));

  assert.strictEqual(result[0].pricing_rule_id, null);
  assert.strictEqual(result[0].rule_type, null);
}

// ─────────────────────────────────────────────────────────────
// 12. Flash sale — NOT applied at order time (documented behaviour)
//     price_source is never 'flash_sale'
//     Flash sale discounts are display-only in the products API.
//     See docs/pricing-precedence.md §Flash Sales.
// ─────────────────────────────────────────────────────────────
{
  // Even if the product object contains flash sale data (as returned by
  // productController), the evaluator ignores it.
  const product = {
    ...makeProduct({ id: 1 }),
    flash_sale_id:   99,
    discount_type:  'percentage',
    discount_value: '20',
    discounted_price: '80.00',
  };

  const result = run([{ product_id: 1, quantity: 1 }], makeProductMap(product));

  assert.notStrictEqual(result[0].price_source, 'flash_sale');
  // Price is standard retail, not the discounted_price
  assert.strictEqual(result[0].unit_price.toFixed(2), '100.00');
  assert.strictEqual(result[0].price_source, 'retail_fallback');
}

// ─────────────────────────────────────────────────────────────
// 13. Edge cases
// ─────────────────────────────────────────────────────────────

// Empty cart
{
  const result = run([], new Map());
  assert.deepStrictEqual(result, []);
}

// Product not in map throws
{
  let threw = false;
  try {
    run([{ product_id: 999, quantity: 1 }], new Map());
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes('999'));
  }
  assert.ok(threw, 'Expected error for missing product in map');
}

// Product with no retail_price and no rule → null unit_price, retail_fallback
{
  const product = makeProduct({ id: 1, retail_price: null, wholesale_price: null, min_qty_wholesale: null });
  const result  = run([{ product_id: 1, quantity: 1 }], makeProductMap(product));
  assert.strictEqual(result[0].unit_price, null);
  assert.strictEqual(result[0].price_source, 'retail_fallback');
}

console.log('pricingRuleEvaluator tests passed ✓');
