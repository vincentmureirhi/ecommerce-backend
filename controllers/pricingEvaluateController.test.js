'use strict';

const assert = require('assert');
const path = require('path');

const controllerPath = path.resolve(__dirname, './pricingEvaluateController.js');
const dbPath = path.resolve(__dirname, '../config/database.js');
const orderControllerPath = path.resolve(__dirname, './orderController.js');

function loadController({ productMap, tiersMap }) {
  delete require.cache[controllerPath];
  delete require.cache[dbPath];
  delete require.cache[orderControllerPath];

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      connect: async () => ({
        release() {},
      }),
    },
  };

  require.cache[orderControllerPath] = {
    id: orderControllerPath,
    filename: orderControllerPath,
    loaded: true,
    exports: {
      loadPricingContext: async () => ({ productMap, tiersMap }),
    },
  };

  return require(controllerPath);
}

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

(async () => {
  {
    const { evaluatePricing } = loadController({ productMap: {}, tiersMap: {} });
    const res = createRes();
    await evaluatePricing({ body: { items: [] } }, res);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, {
      success: false,
      error: 'items must be a non-empty array',
    });
  }

  {
    const { evaluatePricing } = loadController({ productMap: {}, tiersMap: {} });
    const res = createRes();
    await evaluatePricing({ body: { items: [{ product_id: 999, quantity: 2 }] } }, res);

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, {
      success: false,
      error: 'Product not found: 999',
    });
  }

  {
    const { evaluatePricing } = loadController({
      productMap: {
        101: {
          id: 101,
          retail_price: '100',
          wholesale_price: '70',
          min_qty_wholesale: 3,
          requires_manual_price: false,
          _pricingRule: {
            id: 1,
            rule_type: 'SKU_THRESHOLD',
            threshold_qty: 3,
            name: 'Wholesale at 3',
          },
        },
      },
      tiersMap: {},
    });
    const res = createRes();
    await evaluatePricing({ body: { items: [{ product_id: 101, quantity: 3 }] } }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, {
      success: true,
      message: 'Pricing evaluated successfully',
      data: [
        {
          product_id: 101,
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
        },
      ],
    });
  }

  console.log('pricingEvaluateController tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
