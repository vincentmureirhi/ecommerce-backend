'use strict';

const pool = require('../config/database');

const PENDING_TIMEOUT_MINUTES = 15;

async function autoFailStalePendingPayments() {
  try {
    const timeoutDate = new Date(Date.now() - PENDING_TIMEOUT_MINUTES * 60 * 1000);

    const result = await pool.query(
      `UPDATE payments
       SET status = 'failed', 
           failure_reason = 'timeout',
           result_desc = 'Payment pending for more than 15 minutes',
           updated_at = CURRENT_TIMESTAMP
       WHERE status = 'pending' 
       AND created_at < $1
       AND checkout_request_id IS NOT NULL
       RETURNING id, order_id, amount, customer_phone`,
      [timeoutDate]
    );

    if (result.rows.length > 0) {
      console.log(`[AUTO-FAIL] ✅ Failed ${result.rows.length} stale payments:`);
      result.rows.forEach(payment => {
        console.log(`   📍 Payment #${payment.id} | Order: ${payment.order_id} | Amount: KSh ${payment.amount}`);
      });
    }

    return result.rows.length;
  } catch (err) {
    console.error('❌ autoFailStalePendingPayments error:', err.message);
    throw err;
  }
}

module.exports = {
  autoFailStalePendingPayments
};