const assert = require('assert');
const Decimal = require('decimal.js');
const { resolveProductUnitPrice, applyCategoryComboDiscounts } = require('./pricingEngine');

// Tier wins over wholesale/retail
{
  const price = resolveProductUnitPrice(
    { retail_price: '100', wholesale_price: '60', min_qty_wholesale: 10, requires_manual_price: false },
    55,
    [
      { min_qty: 1, max_qty: 49, unit_price: '100' },
      { min_qty: 50, max_qty: 99, unit_price: '47' },
      { min_qty: 100, max_qty: null, unit_price: '45' },
    ]
  );
  assert(price instanceof Decimal);
  assert.strictEqual(price.toFixed(2), '47.00');
}

// Wholesale fallback
{
  const price = resolveProductUnitPrice(
    { retail_price: '100', wholesale_price: '60', min_qty_wholesale: 10, requires_manual_price: false },
    12,
    []
  );
  assert.strictEqual(price.toFixed(2), '60.00');
}

// Manual quote returns null
{
  const price = resolveProductUnitPrice(
    { retail_price: null, wholesale_price: null, min_qty_wholesale: null, requires_manual_price: true },
    1,
    []
  );
  assert.strictEqual(price, null);
}

// Category combo CAP reduces price only
{
  const discounted = applyCategoryComboDiscounts(
    [
      { product_id: 1, category_id: 10, qty: 3, unit_price: new Decimal('100'), price_source: 'retail' },
      { product_id: 2, category_id: 10, qty: 3, unit_price: new Decimal('100'), price_source: 'retail' },
      { product_id: 3, category_id: 11, qty: 1, unit_price: new Decimal('100'), price_source: 'retail' },
    ],
    [
      { id: 10, combo_discount_qty: 6, combo_discount_price: '80' },
      { id: 11, combo_discount_qty: 2, combo_discount_price: '70' },
    ]
  );

  assert.strictEqual(discounted[0].unit_price.toFixed(2), '80.00');
  assert.strictEqual(discounted[1].unit_price.toFixed(2), '80.00');
  assert.strictEqual(discounted[2].unit_price.toFixed(2), '100.00');
}

// Category combo does NOT increase price (cap behavior)
{
  const discounted = applyCategoryComboDiscounts(
    [{ product_id: 1, category_id: 10, qty: 6, unit_price: new Decimal('47'), price_source: 'tier' }],
    [{ id: 10, combo_discount_qty: 6, combo_discount_price: '80' }]
  );

  assert.strictEqual(discounted[0].unit_price.toFixed(2), '47.00');
}

console.log('pricingEngine tests passed');