'use strict';

const axios = require('axios');
const pool = require('../config/database');
const Decimal = require('decimal.js');
const moment = require('moment');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const { enqueuePaymentConfirmedSms } = require('../services/smsService');
const mpesaConfig = require('../config/mpesa');

function failedStatus(desc = '') {
  const text = String(desc).toLowerCase();
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

async function darajaStatus(checkoutRequestId) {
  const shortcode = mpesaConfig.businessShortcode();
  const passkey = mpesaConfig.passkey();
  if (!shortcode || !passkey) throw new Error('M-Pesa shortcode or passkey is not configured');

  const token = await getAccessToken();
  const timestamp = moment().format('YYYYMMDDHHmmss');
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  const response = await axios.post(
    `${mpesaConfig.baseUrl()}/mpesa/stkpushquery/v1/query`,
    { BusinessShortCode: shortcode, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutRequestId },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
  );
  return response.data || {};
}

async function findPayment(client, checkoutRequestId, lock = false) {
  const idSql = `
    SELECT id
    FROM payments
    WHERE checkout_request_id = $1::text
    ORDER BY id DESC
    LIMIT 1${lock ? ' FOR UPDATE' : ''}
  `;
  const idRes = await client.query(idSql, [checkoutRequestId]);
  if (!idRes.rows.length) return null;

  const result = await client.query(
    `
      SELECT
        p.id, p.order_id, p.status, p.amount, p.expected_amount, p.received_amount,
        p.customer_phone, p.mpesa_receipt, p.result_code, p.result_desc,
        p.reconciliation_status, p.failure_reason, p.checkout_request_id,
        p.created_at, p.updated_at, p.completed_at,
        o.order_number, o.order_type, o.total_amount, o.amount_paid AS order_amount_paid,
        o.payment_status AS order_payment_status, o.payment_state AS order_payment_state,
        o.order_status, o.customer_phone AS order_customer_phone
      FROM payments p
      LEFT JOIN orders o ON o.id = p.order_id
      WHERE p.id = $1::integer
      LIMIT 1
    `,
    [idRes.rows[0].id]
  );
  return result.rows[0] || null;
}

async function settleOrder(client, orderId) {
  if (!orderId) return null;

  const orderRes = await client.query(
    `
      SELECT id, order_number, order_type, total_amount, order_status,
             payment_status, payment_state, amount_paid, customer_phone
      FROM orders
      WHERE id = $1::integer
      FOR UPDATE
    `,
    [orderId]
  );
  if (!orderRes.rows.length) return null;

  const order = orderRes.rows[0];
  const paidRes = await client.query(
    `
      SELECT COALESCE(
        SUM(
          CASE
            WHEN p.status IN ('completed', 'manually_resolved')
             AND (p.status = 'manually_resolved' OR COALESCE(p.reconciliation_status, 'matched') <> 'mismatch')
            THEN COALESCE(p.received_amount, p.amount)
            ELSE 0
          END
        ), 0
      )::numeric(12,2) AS paid_total
      FROM payments p
      WHERE p.order_id = $1::integer
    `,
    [orderId]
  );

  const total = new Decimal(order.total_amount || 0);
  const paid = new Decimal(paidRes.rows[0]?.paid_total || 0);
  const fullyPaid = total.gt(0) && paid.gte(total);

  if (order.order_type === 'normal') {
    await client.query(
      fullyPaid
        ? `UPDATE orders
           SET amount_paid=$1::numeric, payment_status='completed',
               order_status=CASE WHEN COALESCE(order_status,'pending')='pending' THEN 'processing' ELSE order_status END,
               status_changed_at=CASE WHEN COALESCE(order_status,'pending')='pending' THEN CURRENT_TIMESTAMP ELSE status_changed_at END,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$2::integer`
        : `UPDATE orders
           SET amount_paid=$1::numeric, payment_status='pending', updated_at=CURRENT_TIMESTAMP
           WHERE id=$2::integer`,
      [paid.toFixed(2), orderId]
    );
  } else {
    const state = fullyPaid ? 'paid' : paid.gt(0) ? 'partial' : 'unpaid';
    await client.query(
      `UPDATE orders SET amount_paid=$1::numeric, payment_state=$2::text, updated_at=CURRENT_TIMESTAMP WHERE id=$3::integer`,
      [paid.toFixed(2), state, orderId]
    );
  }

  return { ...order, amount_paid: paid.toFixed(2), fullyPaid };
}

async function markCompleted(client, payment, result, fromQuery = false) {
  const items = Array.isArray(result.CallbackMetadata?.Item) ? result.CallbackMetadata.Item : [];
  const value = (name) => items.find((item) => item.Name === name)?.Value;
  const receivedAmount = new Decimal(value('Amount') ?? payment.expected_amount ?? payment.amount ?? 0);
  const expectedAmount = new Decimal(payment.expected_amount ?? payment.amount ?? 0);
  const receipt = value('MpesaReceiptNumber') || payment.mpesa_receipt || null;
  const phone = value('PhoneNumber') ? String(value('PhoneNumber')) : payment.customer_phone || payment.order_customer_phone;
  const matched = receivedAmount.eq(expectedAmount);

  await client.query(
    `
      UPDATE payments
      SET status='completed', received_amount=$1::numeric, customer_phone=$2::text,
          mpesa_receipt=COALESCE($3::text, mpesa_receipt), result_code=$4,
          result_desc=$5::text, callback_data=$6::jsonb, reconciliation_status=$7::text,
          failure_reason=NULL, completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP),
          updated_at=CURRENT_TIMESTAMP
      WHERE id=$8::integer
    `,
    [
      receivedAmount.toFixed(2),
      phone,
      receipt,
      Number(result.ResultCode ?? 0),
      String(result.ResultDesc || ''),
      JSON.stringify(result),
      matched ? 'matched' : 'mismatch',
      payment.id,
    ]
  );

  const settledOrder = matched && payment.order_id ? await settleOrder(client, payment.order_id) : null;
  if (settledOrder?.fullyPaid) {
    try {
      await enqueuePaymentConfirmedSms(client, settledOrder, { paymentId: payment.id });
    } catch (smsError) {
      console.error('Failed to queue payment confirmation SMS:', smsError.message);
    }
  }

  if (fromQuery) console.log(`[MPESA] Daraja query confirmed success for payment #${payment.id}; callback may still arrive later.`);
  return { matched, receivedAmount, expectedAmount, receipt, phone, settledOrder };
}

function emitCompleted(payment, outcome, status = 'completed') {
  try {
    const ws = require('../websocket');
    ws.broadcastPaymentCompleted({
      id: payment.id,
      order_id: payment.order_id,
      order_number: outcome.settledOrder?.order_number,
      amount: outcome.receivedAmount.toFixed(2),
      expected_amount: outcome.expectedAmount.toFixed(2),
      status,
      reconciliation_status: outcome.matched ? 'matched' : 'mismatch',
      mpesa_receipt: outcome.receipt || null,
      customer_phone: outcome.phone || payment.customer_phone || null,
      completed_at: new Date(),
    });
  } catch (error) {
    console.error('Payment websocket broadcast failed:', error.message);
  }
}

async function queryPaymentStatus(req, res) {
  const checkoutRequestId = String(req.params.checkoutRequestId || '').trim();
  if (!checkoutRequestId || checkoutRequestId.length > 100) return handleError(res, 400, 'Invalid checkout request ID');

  const client = await pool.connect();
  try {
    let payment = await findPayment(client, checkoutRequestId, false);
    if (!payment) return handleError(res, 404, 'Payment not found');

    const status = String(payment.status || '').toLowerCase();
    const ageMs = Date.now() - new Date(payment.created_at).getTime();

    if (!['completed', 'manually_resolved'].includes(status) && ageMs >= 4000) {
      try {
        const darajaResult = await darajaStatus(checkoutRequestId);
        const code = Number(darajaResult.ResultCode);

        if (code === 0) {
          await client.query('BEGIN');
          payment = await findPayment(client, checkoutRequestId, true) || payment;
          const outcome = await markCompleted(client, payment, {
            ResultCode: 0,
            ResultDesc: String(darajaResult.ResultDesc || ''),
            CallbackMetadata: { Item: [] },
          }, true);
          await client.query('COMMIT');
          emitCompleted(payment, outcome);
        } else {
          // Daraja STK Query is not authoritative for a customer's final payment state.
          // It can report a transient/non-terminal result before the asynchronous callback arrives.
          // Keep the payment pending and let /callback perform the definitive state transition.
          console.log(
            `[MPESA] Daraja status query non-success for ${checkoutRequestId}: code=${code}, desc=${String(darajaResult.ResultDesc || '')}. Keeping current DB status until callback.`
          );
        }
      } catch (fallbackError) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.warn('Daraja STK status fallback failed:', fallbackError.message);
      }
    }

    payment = await findPayment(client, checkoutRequestId, false) || payment;
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
    if (!checkoutRequestId) return handleSuccess(res, 200, 'Callback ignored', { ignored: true, reason: 'missing_checkout_request_id' });

    await client.query('BEGIN');
    const payment = await findPayment(client, checkoutRequestId, true);
    if (!payment) {
      await client.query('COMMIT');
      return handleSuccess(res, 200, 'Callback received but no matching payment found', { matched: false, checkoutRequestId });
    }

    const resultCode = Number(result.ResultCode);
    const resultDesc = String(result.ResultDesc || '');

    if (resultCode === 0) {
      const outcome = await markCompleted(client, payment, result, false);
      await client.query('COMMIT');
      emitCompleted(payment, outcome);
      return handleSuccess(res, 200, outcome.matched ? 'Payment successful' : 'Payment received but amount requires reconciliation', {
        checkoutRequestId,
        resultCode,
        resultDesc,
        mpesa_receipt: outcome.receipt,
        payment_id: payment.id,
        reconciliation_status: outcome.matched ? 'matched' : 'mismatch',
      });
    }

    const nextStatus = failedStatus(resultDesc);
    await client.query(
      `UPDATE payments
       SET status=$1::text, result_code=$2, result_desc=$3::text, callback_data=$4::jsonb,
           reconciliation_status='manual_review', failure_reason=$3::text, updated_at=CURRENT_TIMESTAMP
       WHERE id=$5::integer`,
      [nextStatus, resultCode, resultDesc, JSON.stringify(result), payment.id]
    );
    await client.query('COMMIT');

    try {
      const ws = require('../websocket');
      if (ws.broadcastPaymentFailed) {
        ws.broadcastPaymentFailed({
          id: payment.id,
          order_id: payment.order_id,
          amount: payment.amount,
          status: nextStatus,
          result_code: resultCode,
          result_desc: resultDesc,
          customer_phone: payment.customer_phone,
          failure_reason: resultDesc,
        });
      }
    } catch (broadcastError) {
      console.error('Payment websocket broadcast failed:', broadcastError.message);
    }

    return handleSuccess(res, 200, 'Payment callback processed', {
      checkoutRequestId,
      status: nextStatus,
      resultDesc,
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('M-Pesa confirmation callback error:', error.message);
    return handleError(res, 500, 'Failed to process M-Pesa callback', error);
  } finally {
    client.release();
  }
}

module.exports = { queryPaymentStatus, mpesaCallback };
