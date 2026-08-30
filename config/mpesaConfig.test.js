'use strict';

const assert = require('assert');

const original = { ...process.env };

try {
  process.env.MPESA_ENVIRONMENT = 'production';
  delete process.env.MPESA_CALLBACK_URL;
  process.env.RENDER_EXTERNAL_URL = 'https://xpose-api-test.onrender.com/';
  process.env.MPESA_BUSINESS_SHORTCODE = '4879403';
  process.env.MPESA_TRANSACTION_TYPE = 'CustomerBuyGoodsOnline';

  const { getMpesaConfig } = require('./mpesaConfig');
  const config = getMpesaConfig();

  assert.strictEqual(config.environment, 'production');
  assert.strictEqual(config.baseUrl, 'https://api.safaricom.co.ke');
  assert.strictEqual(config.shortcode, '4879403');
  assert.strictEqual(config.transactionType, 'CustomerBuyGoodsOnline');
  assert.strictEqual(config.callbackUrl, 'https://xpose-api-test.onrender.com/api/payments/callback');

  console.log('mpesaConfig.test.js: all assertions passed');
} finally {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key];
  }
  Object.assign(process.env, original);
}
