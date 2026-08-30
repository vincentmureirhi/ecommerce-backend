'use strict';

const assert = require('assert');

process.env.MPESA_ENVIRONMENT = 'production';
process.env.MPESA_CONSUMER_KEY = 'test-key';
process.env.MPESA_CONSUMER_SECRET = 'test-secret';
process.env.MPESA_PASSKEY = 'test-passkey';
process.env.MPESA_BUSINESS_SHORTCODE = '4879403';
process.env.RENDER_EXTERNAL_URL = 'https://xpose-backend.onrender.com';

delete process.env.MPESA_CALLBACK_URL;

delete require.cache[require.resolve('./mpesa')];
const config = require('./mpesa');

assert.strictEqual(config.isProduction(), true);
assert.strictEqual(config.baseUrl(), 'https://api.safaricom.co.ke');
assert.strictEqual(config.consumerKey(), 'test-key');
assert.strictEqual(config.consumerSecret(), 'test-secret');
assert.strictEqual(config.passkey(), 'test-passkey');
assert.strictEqual(config.businessShortcode(), '4879403');
assert.strictEqual(config.transactionType(), 'CustomerBuyGoodsOnline');
assert.strictEqual(config.callbackUrl(), 'https://xpose-backend.onrender.com/api/payments/callback');

console.log('M-Pesa configuration test passed');
