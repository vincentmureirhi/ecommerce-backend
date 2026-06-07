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
      rule_name: 'Wholesale at 3',
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
    {
      product_id: 12,
      quantity: 2,
      unit_price: new Decimal('75'),
      original_unit_price: new Decimal('100'),
      is_wholesale_eligible: false,
      threshold_qty: null,
      effective_qty: 2,
      rule_type: 'legacy',
      pricing_label: 'flash sale',
      flash_sale_id: 4,
      flash_sale_name: 'Weekend Flash',
      flash_sale_end_date: '2026-05-25T10:00:00.000Z',
      flash_sale_discount_type: 'percentage',
      flash_sale_discount_value: '25',
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
      rule_name: 'Wholesale at 3',
      pricing_group_id: null,
      pricing_group_name: null,
      pricing_label: 'wholesale (SKU_THRESHOLD)',
      flash_sale_id: null,
      flash_sale_name: null,
      flash_sale_end_date: null,
      flash_sale_discount_type: null,
      flash_sale_discount_value: null,
      original_unit_price: null,
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
      rule_name: null,
      pricing_group_id: null,
      pricing_group_name: null,
      pricing_label: 'manual_price',
      flash_sale_id: null,
      flash_sale_name: null,
      flash_sale_end_date: null,
      flash_sale_discount_type: null,
      flash_sale_discount_value: null,
      original_unit_price: null,
    },
    {
      product_id: 12,
      quantity: 2,
      unit_price: 75,
      line_total: 150,
      wholesale_eligible: false,
      threshold_quantity: null,
      effective_quantity: 2,
      rule_type: 'legacy',
      rule_name: null,
      pricing_group_id: null,
      pricing_group_name: null,
      pricing_label: 'flash sale',
      flash_sale_id: 4,
      flash_sale_name: 'Weekend Flash',
      flash_sale_end_date: '2026-05-25T10:00:00.000Z',
      flash_sale_discount_type: 'percentage',
      flash_sale_discount_value: 25,
      original_unit_price: 100,
    },
  ]
);

console.log('pricingEvaluationApi tests passed');
