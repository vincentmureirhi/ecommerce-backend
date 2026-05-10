'use strict';

const assert = require('assert');
const Decimal = require('decimal.js');
const {
  PricingEvaluationValidationError,
  normalizeEvaluationItems,
  mapPricingEvaluationItems,
} = require('./pricingEvaluationApi');

assert.deepStrictEqual(
  normalizeEvaluationItems([
    { product_id: '12', quantity: 3 },
    { product_id: 7, quantity: 1 },
  ]),
  [
    { product_id: 12, quantity: 3 },
    { product_id: 7, quantity: 1 },
  ]
);

assert.throws(
  () => normalizeEvaluationItems([]),
  (err) => err instanceof PricingEvaluationValidationError && err.message === 'items must be a non-empty array'
);

assert.throws(
  () => normalizeEvaluationItems([{ product_id: 'abc', quantity: 1 }]),
  (err) => err instanceof PricingEvaluationValidationError && err.message === 'items[0].product_id must be a positive integer'
);

assert.throws(
  () => normalizeEvaluationItems([{ product_id: 9, quantity: 0 }]),
  (err) => err instanceof PricingEvaluationValidationError && err.message === 'items[0].quantity must be a positive integer'
);

assert.deepStrictEqual(
  mapPricingEvaluationItems([
    {
      product_id: 5,
      quantity: 3,
      unit_price: new Decimal('70'),
      is_wholesale_eligible: true,
      threshold_qty: 3,
      effective_qty: 3,
      rule_type: 'SKU_THRESHOLD',
      pricing_label: 'wholesale (SKU_THRESHOLD)',
    },
    {
      product_id: 8,
      quantity: 2,
      unit_price: null,
      is_wholesale_eligible: false,
      threshold_qty: null,
      effective_qty: 2,
      rule_type: 'legacy',
      pricing_label: 'manual_price',
    },
  ]),
  [
    {
      product_id: 5,
      quantity: 3,
      unit_price: 70,
      line_total: 210,
      wholesale_eligible: true,
      threshold_quantity: 3,
      effective_quantity: 3,
      rule_type: 'SKU_THRESHOLD',
      pricing_label: 'wholesale (SKU_THRESHOLD)',
    },
    {
      product_id: 8,
      quantity: 2,
      unit_price: null,
      line_total: null,
      wholesale_eligible: false,
      threshold_quantity: null,
      effective_quantity: 2,
      rule_type: 'legacy',
      pricing_label: 'manual_price',
    },
  ]
);

console.log('pricingEvaluationApi tests passed');
