'use strict';

const assert = require('assert');
const { validateCouponForOrder } = require('./marketingCouponService');

function createMockClient() {
  return {
    async query(sql) {
      const statement = String(sql);

      if (statement.includes('FROM coupons c')) {
        return {
          rows: [{
            id: 1,
            code: 'XPOSE10',
            name: '10% Launch Discount',
            status: 'active',
            discount_type: 'percentage',
            discount_value: 10,
            max_discount_amount: 1000,
            min_order_amount: 500,
            customer_scope: 'normal',
            applies_to: 'all',
            max_total_uses: null,
            uses_count: 0,
            max_uses_per_customer: null,
            max_uses_per_phone: null,
            starts_at: null,
            ends_at: null,
            campaign_id: null,
          }],
        };
      }

      if (
        statement.includes('marketing_campaign_products') ||
        statement.includes('marketing_campaign_categories') ||
        statement.includes('marketing_campaign_regions')
      ) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in coupon test: ${statement}`);
    },
  };
}

async function run() {
  const result = await validateCouponForOrder(
    createMockClient(),
    {
      couponCode: 'XPOSE10',
      orderType: 'normal',
      subtotalAmount: 585,
      items: [
        { product_id: 101, quantity: 6, unit_price: 65 },
        { product_id: 102, quantity: 3, unit_price: 65 },
      ],
    },
    { lock: false }
  );

  assert.strictEqual(result.eligible_subtotal_amount, 585);
  assert.strictEqual(result.discount_amount, 58.5);
  assert.strictEqual(result.final_total_amount, 526.5);
  console.log('marketingCouponService tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});