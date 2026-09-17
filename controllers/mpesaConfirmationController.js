'use strict';

const axios = require('axios');
const pool = require('../config/database');
const Decimal = require('decimal.js');
const moment = require('moment');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const { enqueuePaymentConfirmedSms } = require('../services/smsService');
const mpesaConfig = require('../config/mpesa');

function terminalStatus(status) {
  return ['completed', 'manually_resolved', 'failed', 'cancelled', 'timeout'].includes(
    String(status || '').toLowerCase()
  );
}

function failedStatus(resultDesc = '') {
  const text = String(resultDesc).toLowerCase();
  if (text.includes('cancel')) return 'cancelled';
  if (text.includes('timeout')) return 'timeout';
  return 'failed';
}

async function getAccessToken() {
  const key = mpesaConfig.consumerKey();
  const secret = mpesaConfig.consumerSecret();
  if (!key || !secret) throw new Error('M-Pesa consumer credentials are not configured');
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const response = await axios.get(
    `${mpesaConfig.baseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` }, timeout: 10000 }
  );
  return response.data.access_token;
}

async function queryDaraja(checkoutRequestId) {
  const shortcode = mpesaConfig.businessShortcode();
  const passkey = mpesaConfig.passkey();
  if (!shortcode || !passkey) throw new Error('M-Pesa shortcode or passkey is not configured');
  const token = await getAccessToken();
  const timestamp = moment().format('YYYYMMDDHHmmss');
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  const response = await axios.post(
    `${mpesaConfig.baseUrl()}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    }
  );
  return response.data || {};
}

async function loadPayment(client, checkoutRequestId, lock = false) {
  const lockSql = lock ? 'FOR UPDATE' : '';
  const result = await client.query(
    `
      SELECT
        p.*,
        o.order_number,
        o.order_type,
        o.total_amount,
        o.amount_paid AS order_amount_paid,
        o.payment_status AS order_payment_status,
        o.payment_state AS order_payment_state,
        o.order_status,
        o.due_date,
        o.customer_phone AS order_customer_phone
      FROM payments p
      LEFT JOIN orders o ON o.id = p.order_id
      WHERE p.checkout_request_id = $1::text
      ORDER BY p.id DESC
      LIMIT 1
      ${lockSql}
    `,
    [checkoutRequestId]
  );
  return result.rows[0] || null;
}

async function settleOrder(client, orderId) {
  if (!orderId) return null;
  const orderRes = await client.query(
    `
      SELECT
        id,
        order_number,
        order_type,
        total_amount,
        order_status,
        payment_status,
        payment_state,
        amount_paid,
        due_date,
        customer_phone
      FROM orders
      WHERE id = $1::integer
      FOR UPDATE
    `,
    [orderId]
  );
  if (!orderRes.rows.length) return null;

  const order = orderRes.rows[0];
  const aggregateRes = await client.query(
    `
      SELECT COALESCE(
        SUM(
          CASE
            WHEN p.status IN ('completed', 'manually_resolved')
             AND (
               p.status = 'manually_resolved'
               OR COALESCE(p.reconciliation_status, 'matched') <> 'mismatch'
             )
            THEN COALESCE(p.received_amount, p.amount)
            ELSE 0
          END
        ),
        0
      )::numeric(12,2) AS paid_total
      FROM payments p
      WHERE p.order_id = $1::integer
    `,
    [orderId]
  );

  const total = new Decimal(order.total_amount || 0);
  const paid = new Decimal(aggregateRes.rows[0]?.paid_total || 0);
  const fullyPaid = total.gt(0) && paid.gte(total);

  if (order.order_type === 'normal') {
    const paymentStatus = fullyPaid ? 'completed' : 'pending';
    await client.query(
      `
        UPDATE orders
        SET
          amount_paid = $1::numeric,
          payment_status = $2::text,
          order_status = CASE
            WHEN $2::text = 'completed'
             AND COALESCE(order_status, 'pending') = 'pending'
            THEN 'processing'
            ELSE order_status
          END,
          status_changed_at = CASE
            WHEN $2::text = 'completed'
             AND COALESCE(order_status, 'pending') = 'pending'
            THEN CURRENT_TIMESTAMP
            ELSE status_changed_at
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $3::integer
      `,
      [paid.toFixed(2), paymentStatus, orderId]
    );
  } else {
    const paymentState = fullyPaid ? 'paid' : paid.gt(0) ? 'partial' : 'unpaid';
    await client.query(
      `
        UPDATE orders
        SET
          amount_paid = $1::numeric,
          payment_state = $2::text,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $3::integer
      `,
      [paid.toFixed(2), paymentState, orderId]
    );
  }

  return {
    ...order,
    amount_paid: paid.toFixed(2),
    payment_status: fullyPaid ? 'completed' : 'pending',
    payment_state: fullyPaid ? 'paid' : paid.gt(0) ? 'partial' : 'unpaid',
    sms_should_notify_payment_confirmed: fullyPaid,
  };
}

async function markSuccessful(client, payment, result) {
  const items = Array.isArray(result.CallbackMetadata?.Item) ? result.CallbackMetadata.Item : [];
  const value = (name) => items.find((item) => item.Name === name)?.Value;
  const receivedAmount = new Decimal(value('Amount') ?? payment.expected_amount ?? payment.amount ?? 0);
  const expectedAmount = new Decimal(payment.expected_amount ?? payment.amount ?? 0);
  const receipt = value('MpesaReceiptNumber') || payment.mpesa_receipt || null;
  const phone = value('PhoneNumber') ? String(value('PhoneNumber')) : payment.customer_phone;
  const amountMatched = receivedAmount.eq(expectedAmount);

  await client.query(
    `
      UPDATE payments
      SET
        status = 'completed'::text,
        received_amount = $1::numeric,
        customer_phone = $2::text,
        mpesa_receipt = COALESCE($3::text, mpesa_receipt),
        result_code = $4::text,
        result_desc = $5::text,
        callback_data = $6::jsonb,
        reconciliation_status = $7::text,
        failure_reason = NULL,
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8::integer
    `,
    [
      receivedAmount.toFixed(2),
      phone,
      receipt,
      String(result.ResultCode ?? 0),
      String(result.ResultDesc || ''),
      JSON.stringify(result),
      amountMatched ? 'matched' : 'mismatch',
      payment.id,
    ]
  );

  let settledOrder = null;
  if (amountMatched && payment.order_id) {
    settledOrder = await settleOrder(client, payment.order_id);
    if (settledOrder?.sms_should_notify_payment_confirmed) {
      try {
        await enqueuePaymentConfirmedSms(client, settledOrder, { paymentId: payment.id });
      } catch (smsError) {
        console.error('Failed to queue payment confirmation SMS:', smsError.message);
      }
    }
  }

  return { matched: amountMatched, receivedAmount, expectedAmount, receipt, phone, settledOrder };
}

async function applyDarajaResult(client, payment, darajaResult) {
  const resultCode = Number(darajaResult.ResultCode);
  const resultDesc = String(darajaResult.ResultDesc || '');

  if (resultCode === 0) {
    const outcome = await markSuccessful(client, payment, {
      ResultCode: 0,
      ResultDesc: resultDesc,
      CallbackMetadata: { Item: [] },
    });
    return { terminal: true, status: 'completed', ...outcome, resultCode, resultDesc };
  }

  const nextStatus = failedStatus(resultDesc);
  await client.query(
    `
      UPDATE payments
      SET
        status = $1::text,
        result_code = $2::text,
        result_desc = $3::text,
        reconciliation_status = 'manual_review'::text,
        failure_reason = $3::text,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4::integer
    `,
    [nextStatus, String(resultCode), resultDesc, payment.id]
  );

  return {
    terminal: true,
    status: nextStatus,
    resultCode,
    resultDesc,
    receivedAmount: new Decimal(payment.received_amount ?? payment.amount ?? 0),
    expectedAmount: new Decimal(payment.expected_amount ?? payment.amount ?? 0),
    receipt: payment.mpesa_receipt || null,
    phone: payment.customer_phone || null,
    settledOrder: null,
  };
}

function broadcastOutcome(outcome, payment) {
  try {
    const event = require('../websocket');
    const payload = {
      id: payment.id,
      order_id: payment.order_id,
      order_number: outcome.settledOrder?.order_number,
      amount: outcome.receivedAmount?.toFixed(2) || String(payment.amount),
      expected_amount: outcome.expectedAmount?.toFixed(2) || String(payment.expected_amount || payment.amount),
      status: outcome.status,
      reconciliation_status:
        outcome.matched ? 'matched' : outcome.status === 'completed' ? 'mismatch' : 'manual_review',
      mpesa_receipt: outcome.receipt || null,
      customer_phone: outcome.phone || payment.customer_phone || null,
      result_code: outcome.resultCode ?? null,
      result_desc: outcome.resultDesc || null,
      completed_at: outcome.status === 'completed' ? new Date() : null,
    };
    if (outcome.status === 'completed') event.broadcastPaymentCompleted(payload);
    else event.broadcastPaymentFailed(payload);
  } catch (broadcastError) {
    console.error('Payment websocket broadcast failed:', broadcastError.message);
  }
}

async function queryPaymentStatus(req, res) {
  const checkoutRequestId = String(req.params.checkoutRequestId || '').trim();
  if (!checkoutRequestId || checkoutRequestId.length > 100) {
    return handleError(res, 400, 'Invalid checkout request ID');
  }

  const client = await pool.connect();
  try {
    let payment = await loadPayment(client, checkoutRequestId, false);
    if (!payment) return handleError(res, 404, 'Payment not found');

    const status = String(payment.status || '').toLowerCase();
    const ageMs = Date.now() - new Date(payment.created_at).getTime();

    if (status !== 'completed' && status !== 'manually_resolved' && payment.checkout_request_id && ageMs >= 4000) {
      try {
        const darajaResult = await queryDaraja(checkoutRequestId);
        if (darajaResult && (darajaResult.ResultCode !== undefined || darajaResult.ResultDesc)) {
          await client.query('BEGIN');
          payment = await loadPayment(client, checkoutRequestId, true) || payment;
          const outcome = await applyDarajaResult(client, payment, darajaResult);
          await client.query('COMMIT');
          broadcastOutcome(outcome, payment);
        }
      } catch (fallbackError) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.warn('Daraja STK status fallback failed:', fallbackError.message);
      }
    }

    payment = await loadPayment(client, checkoutRequestId, false) || payment;
    return handleSuccess(res, 200, 'Payment status retrieved', payment);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('queryPaymentStatus error:', error.message);
    return handleError(res, 500, 'Failed to query payment status', error);
  } finally {
    client.release();
  }
}

async function mpesaCallback(req, res) {
  const client = await pool.connect();
  try {
    const result = req.body?.Body?.stkCallback;
    if (!result) return handleSuccess(res, 200, 'Callback ignored', { ignored: true });

    const checkoutRequestId = String(result.CheckoutRequestID || '').trim();
    if (!checkoutRequestId) {
      return handleSuccess(res, 200, 'Callback ignored', { ignored: true, reason: 'missing_checkout_request_id' });
    }

    await client.query('BEGIN');
    const payment = await loadPayment(client, checkoutRequestId, true);
    if (!payment) {
      await client.query('COMMIT');
      return handleSuccess(res, 200, 'Callback received but no matching payment found', { matched: false, checkoutRequestId });
    }

    const resultCode = Number(result.ResultCode);
    if (resultCode === 0) {
      const outcome = await markSuccessful(client, payment, result);
      await client.query('COMMIT');
      broadcastOutcome({ ...outcome, status: 'completed', resultCode, resultDesc: String(result.ResultDesc || '') }, payment);
      return handleSuccess(res, 200, outcome.matched ? 'Payment successful' : 'Payment received but amount requires reconciliation', {
        checkoutRequestId,
        resultCode,
        resultDesc: String(result.ResultDesc || ''),
        mpesa_receipt: outcome.receipt,
        payment_id: payment.id,
        reconciliation_status: outcome.matched ? 'matched' : 'mismatch',
      });
    }

    const status = failedStatus(String(result.ResultDesc || ''));
    await client.query(
      `
        UPDATE payments
        SET
          status = $1::text,
          result_code = $2::text,
          result_desc = $3::text,
          callback_data = $4::jsonb,
          reconciliation_status = 'manual_review'::text,
          failure_reason = $3::text,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $5::integer
      `,
      [status, String(resultCode), String(result.ResultDesc || ''), JSON.stringify(result), payment.id]
    );
    await client.query('COMMIT');
    broadcastOutcome({
      status,
      resultCode,
      resultDesc: String(result.ResultDesc || ''),
      receivedAmount: new Decimal(payment.received_amount ?? payment.amount ?? 0),
      expectedAmount: new Decimal(payment.expected_amount ?? payment.amount ?? 0),
      receipt: payment.mpesa_receipt || null,
      phone: payment.customer_phone || null,
      matched: false,
      settledOrder: null,
    }, payment);

    return handleSuccess(res, 200, 'Payment callback processed', {
      checkoutRequestId,
      status,
      resultDesc: String(result.ResultDesc || ''),
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('M-Pesa confirmation callback error:', error.message);
    return handleError(res, 500, 'Failed to process M-Pesa callback', error);
  } finally {
    client.release();
  }
}

module.exports = {
  queryPaymentStatus,
  mpesaCallback,
};
