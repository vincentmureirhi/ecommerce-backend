'use strict';

const pool = require('../config/database');
const { handleError } = require('../utils/errorHandler');

/**
 * Prevents accidental double STK prompts for the same order while an earlier
 * request is still active. Failed/timeout/cancelled payments are not blocked.
 */
async function preventDuplicateActiveStk(req, res, next) {
  const orderId = Number(req.body?.order_id);

  if (!Number.isInteger(orderId) || orderId < 1) {
    return next();
  }

  try {
    const result = await pool.query(
      `
        SELECT id, status, checkout_request_id, created_at
        FROM payments
        WHERE order_id = $1
          AND status IN ('initiated', 'pending')
          AND created_at > CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        ORDER BY id DESC
        LIMIT 1
      `,
      [orderId]
    );

    const activePayment = result.rows[0];
    if (activePayment) {
      return handleError(
        res,
        409,
        'An M-Pesa payment prompt is already active for this order. Complete it or wait for it to expire before trying again.',
        {
          payment_id: activePayment.id,
          status: activePayment.status,
          checkout_request_id: activePayment.checkout_request_id,
          created_at: activePayment.created_at,
        }
      );
    }

    return next();
  } catch (error) {
    console.error('Duplicate STK guard failed:', error.message);
    return handleError(res, 500, 'Unable to verify active payment attempt', error);
  }
}

module.exports = { preventDuplicateActiveStk };
