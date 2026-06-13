'use strict';

const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_tracking_secret';
process.env.STOREFRONT_URL = 'https://example.test';
process.env.ORDER_TRACKING_TOKEN_TTL_DAYS = '30';

const {
  attachOrderTrackingLink,
  buildOrderTrackingToken,
  buildOrderTrackingUrl,
  verifyOrderTrackingToken,
} = require('./orderTrackingToken');

const order = { id: 42, order_number: 'ORD-TRACK-42' };

const token = buildOrderTrackingToken(order);
assert.ok(token, 'token should be generated');

const decoded = verifyOrderTrackingToken(token);
assert.strictEqual(decoded.order_id, 42);
assert.strictEqual(decoded.order_number, 'ORD-TRACK-42');

const url = buildOrderTrackingUrl(order);
assert.ok(url.startsWith('https://example.test/track-order?t='));

const enriched = attachOrderTrackingLink(order);
assert.strictEqual(enriched.tracking_token_ttl_days, 30);
assert.ok(enriched.tracking_token);
assert.ok(enriched.tracking_url.includes('/track-order?t='));

assert.strictEqual(verifyOrderTrackingToken('bad-token'), null);

console.log('orderTrackingToken tests passed');
