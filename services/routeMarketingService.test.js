'use strict';

const assert = require('assert');
const { awardRouteOrderPoints } = require('./routeMarketingService');

async function run() {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO route_customer_reward_ledger')) return { rows: [{ id: 1 }] };
      if (String(sql).includes('INSERT INTO route_customer_reward_accounts')) {
        return { rows: [{ customer_id: 22, points_balance: 5, lifetime_points: 5, tier: 'starter' }] };
      }
      if (String(sql).includes('UPDATE orders SET route_reward_points')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const result = await awardRouteOrderPoints(db, {
    customerId: 22,
    orderId: 91,
    orderAmount: 585,
    salesRepId: 4,
  });

  assert.strictEqual(result.awarded, true);
  assert.strictEqual(result.points, 5);
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(calls[2].params, [5, 91]);

  const duplicate = await awardRouteOrderPoints({
    async query(sql) {
      if (String(sql).includes('INSERT INTO route_customer_reward_ledger')) return { rows: [] };
      throw new Error('Duplicate reward should stop after ledger check');
    },
  }, { customerId: 22, orderId: 91, orderAmount: 585 });

  assert.strictEqual(duplicate.awarded, false);
  assert.strictEqual(duplicate.reason, 'already_awarded');
  console.log('routeMarketingService tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});