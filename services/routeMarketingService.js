'use strict';

function envPositiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function rewardTier(lifetimePoints) {
  if (lifetimePoints >= 10000) return 'platinum';
  if (lifetimePoints >= 5000) return 'gold';
  if (lifetimePoints >= 1500) return 'silver';
  return 'starter';
}

async function awardRouteOrderPoints(db, input = {}) {
  const customerId = Number(input.customerId);
  const orderId = Number(input.orderId);
  const orderAmount = Number(input.orderAmount || 0);
  if (!Number.isInteger(customerId) || customerId <= 0 || !Number.isInteger(orderId) || orderId <= 0 || orderAmount <= 0) {
    return { awarded: false, points: 0, reason: 'invalid_route_reward_input' };
  }

  const kesPerPoint = envPositiveInt('ROUTE_REWARD_KES_PER_POINT', 100);
  const points = Math.max(1, Math.floor(orderAmount / kesPerPoint));
  const ledger = await db.query(
    `
    INSERT INTO route_customer_reward_ledger
      (customer_id, order_id, points, entry_type, description, metadata, created_at)
    VALUES ($1, $2, $3, 'order_earned', $4, $5::jsonb, NOW())
    ON CONFLICT (customer_id, order_id, entry_type) DO NOTHING
    RETURNING id
    `,
    [
      customerId,
      orderId,
      points,
      `Route order reward: ${points} point${points === 1 ? '' : 's'}`,
      JSON.stringify({ order_amount: orderAmount, kes_per_point: kesPerPoint, sales_rep_id: input.salesRepId || null }),
    ]
  );

  if (!ledger.rows[0]) {
    return { awarded: false, points: 0, reason: 'already_awarded' };
  }

  const account = await db.query(
    `
    INSERT INTO route_customer_reward_accounts
      (customer_id, points_balance, lifetime_points, tier, last_earned_at, updated_at)
    VALUES ($1, $2, $2, $3, NOW(), NOW())
    ON CONFLICT (customer_id) DO UPDATE SET
      points_balance = route_customer_reward_accounts.points_balance + EXCLUDED.points_balance,
      lifetime_points = route_customer_reward_accounts.lifetime_points + EXCLUDED.lifetime_points,
      tier = CASE
        WHEN route_customer_reward_accounts.lifetime_points + EXCLUDED.lifetime_points >= 10000 THEN 'platinum'
        WHEN route_customer_reward_accounts.lifetime_points + EXCLUDED.lifetime_points >= 5000 THEN 'gold'
        WHEN route_customer_reward_accounts.lifetime_points + EXCLUDED.lifetime_points >= 1500 THEN 'silver'
        ELSE 'starter'
      END,
      last_earned_at = NOW(),
      updated_at = NOW()
    RETURNING *
    `,
    [customerId, points, rewardTier(points)]
  );

  await db.query('UPDATE orders SET route_reward_points = $1 WHERE id = $2', [points, orderId]);
  return { awarded: true, points, account: account.rows[0] };
}

async function resolveSalesRepReferralCode(db, value) {
  const code = String(value || '').trim().toUpperCase();
  if (!code) return null;
  const result = await db.query(
    `
    SELECT rc.*, sr.name AS sales_rep_name
    FROM sales_rep_referral_codes rc
    INNER JOIN sales_reps sr ON sr.id = rc.sales_rep_id
    WHERE UPPER(rc.code) = $1 AND rc.is_active = TRUE
    LIMIT 1
    `,
    [code]
  );
  return result.rows[0] || null;
}

async function recordRouteApplicationReferral(db, input = {}) {
  const referral = await resolveSalesRepReferralCode(db, input.referralCode);
  if (!referral) return null;

  await db.query(
    `
    UPDATE route_customer_applications
    SET referral_code = $1,
        referred_by_sales_rep_id = $2,
        updated_at = NOW()
    WHERE id = $3
    `,
    [referral.code, referral.sales_rep_id, input.applicationId]
  );

  const result = await db.query(
    `
    INSERT INTO route_customer_referrals
      (referral_code_id, application_id, status, reward_points, created_at, updated_at)
    VALUES ($1, $2, 'applied', $3, NOW(), NOW())
    ON CONFLICT (application_id) DO UPDATE SET
      referral_code_id = EXCLUDED.referral_code_id,
      reward_points = EXCLUDED.reward_points,
      updated_at = NOW()
    RETURNING *
    `,
    [referral.id, input.applicationId, referral.reward_points]
  );

  return { ...result.rows[0], code: referral.code, sales_rep_id: referral.sales_rep_id, sales_rep_name: referral.sales_rep_name };
}

module.exports = {
  awardRouteOrderPoints,
  resolveSalesRepReferralCode,
  recordRouteApplicationReferral,
  rewardTier,
};