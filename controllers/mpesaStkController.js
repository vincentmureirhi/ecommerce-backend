'use strict';

const axios = require('axios');
const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const Decimal = require('decimal.js');
const moment = require('moment');
const { enqueuePaymentConfirmedSms } = require('../services/smsService');
const mpesaConfig = require('../config/mpesa');

function normalizePhone(phone) {
  let value = String(phone || '').replace(/\D/g, '');
  if (value.length === 9 && /^[17]/.test(value)) value = `254${value}`;
  if (value.length === 10 && value.startsWith('0')) value = `254${value.slice(1)}`;
  return value;
}

function money(value) {
  const amount = new Decimal(value);
  if (!amount.isFinite() || amount.lte(0)) throw new Error('Amount must be greater than zero');
  return amount;
}

function mpesaBaseUrl() {
  return mpesaConfig.baseUrl();
}

function transactionType() {
  return mpesaConfig.transactionType();
}

async function getAccessToken() {
  const key = mpesaConfig.consumerKey();
  const secret = mpesaConfig.consumerSecret();
  if (!key || !secret) throw new Error('M-Pesa consumer credentials are not configured');

  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const response = await axios.get(`${mpesaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
    timeout: 10000,
  });
  return response.data.access_token;
}

async function findOrder(client, reference) {
  const value = String(reference || '').trim();
  if (!value) return null;
  const result = await client.query(
    `
      SELECT id, order_number, order_type, total_amount, amount_paid, customer_phone,
             payment_status, payment_state, order_status, due_date
      FROM orders
      WHERE order_number = $1
         OR ($1 ~ '^[0-9]+$' AND id = $1::integer)
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
    `,
    [value]
  );
  return result.rows[0] || null;
}

async function syncOrderPayment(client, orderId) {
  const result = await client.query(
    `
      SELECT
        o.id, o.order_number, o.order_type, o.total_amount, o.order_status,
        o.payment_status, o.payment_state,
        COALESCE(SUM(CASE WHEN p.status IN ('completed','manually_resolved')
          THEN COALESCE(p.received_amount, p.amount) ELSE 0 END), 0)::numeric(12,2) AS paid_total
      FROM orders o
      LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id
      FOR UPDATE OF o
    `,
    [orderId]
  );

  if (!result.rows.length) return null;
  const row = result.rows[0];
  const total = new Decimal(row.total_amount || 0);
  const paid = new Decimal(row.paid_total || 0);
  const fullyPaid = total.gt(0) && paid.gte(total);

  if (row.order_type === 'normal') {
    await client.query(
      `UPDATE orders
       SET amount_paid = $1,
           payment_status = $2,
           order_status = CASE WHEN $2 = 'completed' AND COALESCE(order_status,'pending') = 'pending'
                               THEN 'processing' ELSE order_status END,
           status_changed_at = CASE WHEN $2 = 'completed' AND COALESCE(order_status,'pending') = 'pending'
                                    THEN CURRENT_TIMESTAMP ELSE status_changed_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [paid.toFixed(2), fullyPaid ? 'completed' : 'pending', orderId]
    );
  } else {
    await client.query(
      `UPDATE orders
       SET amount_paid = $1,
           payment_state = CASE WHEN $2 THEN 'paid'
                                 WHEN $1::numeric > 0 THEN 'partial'
                                 ELSE 'unpaid' END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [paid.toFixed(2), fullyPaid, orderId]
    );
  }

  return {
    ...row,
    amount_paid: paid.toFixed(2),
    payment_status: fullyPaid ? 'completed' : 'pending',
    sms_should_notify_payment_confirmed: fullyPaid,
  };
}

async function initiateSTKPush(req, res) {
  const client = await pool.connect();
  try {
    const { phone, amount, order_id } = req.body || {};
    if (!order_id || amount === undefined || amount === null) {
      return handleError(res, 400, 'Missing required fields: amount, order_id');
    }

    const amountValue = money(amount);
    await client.query('BEGIN');
    const order = await findOrder(client, order_id);
    if (!order) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Order not found');
    }

    const balance = Decimal.max(new Decimal(order.total_amount || 0).minus(order.amount_paid || 0), 0);
    if (balance.lte(0)) {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'Order is already fully paid');
    }
    if (amountValue.gt(balance)) {
      await client.query('ROLLBACK');
      return handleError(res, 400, `Payment exceeds outstanding balance. Balance is ${balance.toFixed(2)}`);
    }

    const phoneNumber = normalizePhone(phone || order.customer_phone);
    if (!/^254[17]\d{8}$/.test(phoneNumber)) {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'Order does not have a valid Kenyan customer phone number');
    }

    const insert = await client.query(
      `INSERT INTO payments
        (order_id, customer_phone, amount, expected_amount, method, source, status, reconciliation_status)
       VALUES ($1,$2,$3,$4,'mpesa','mpesa_auto','initiated','awaiting_callback')
       RETURNING id`,
      [order.id, phoneNumber, amountValue.toFixed(2), amountValue.toFixed(2)]
    );
    const paymentId = insert.rows[0].id;

    try {
      const token = await getAccessToken();
      const timestamp = moment().format('YYYYMMDDHHmmss');
      const shortcode = mpesaConfig.businessShortcode();
      const passkey = mpesaConfig.passkey();
      const callback = mpesaConfig.callbackUrl();
      if (!shortcode || !passkey || !callback) throw new Error('M-Pesa shortcode, passkey, or callback URL is not configured');

      const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
      const payload = {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: transactionType(),
        Amount: Math.round(Number(amountValue.toFixed(2))),
        PartyA: phoneNumber,
        PartyB: shortcode,
        PhoneNumber: phoneNumber,
        CallBackURL: callback,
        AccountReference: `ORD-${order.order_number || order.id}`.slice(0, 20),
        TransactionDesc: `XPOSE order ${order.order_number || order.id}`.slice(0, 50),
      };

      const response = await axios.post(
        `${mpesaBaseUrl()}/mpesa/stkpush/v1/processrequest`,
        payload,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );

      await client.query(
        `UPDATE payments
         SET status='pending', merchant_request_id=$1, checkout_request_id=$2,
             result_desc=$3, updated_at=CURRENT_TIMESTAMP
         WHERE id=$4`,
        [response.data.MerchantRequestID || null, response.data.CheckoutRequestID || null,
         response.data.CustomerMessage || 'STK Push sent', paymentId]
      );
      await client.query('COMMIT');

      return handleSuccess(res, 200, 'STK Push sent successfully', {
        payment_id: paymentId,
        checkout_request_id: response.data.CheckoutRequestID,
        merchant_request_id: response.data.MerchantRequestID,
        message: response.data.CustomerMessage || 'Please enter your M-Pesa PIN on your phone',
      });
    } catch (error) {
      const message = error.response?.data?.errorMessage || error.response?.data?.ResultDesc || error.message || 'M-Pesa STK Push failed';
      await client.query(
        `UPDATE payments SET status=$1, reconciliation_status='manual_review', failure_reason=$2,
         result_code=$3, result_desc=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$4`,
        [error.code === 'ECONNABORTED' ? 'timeout' : 'failed', message,
         String(error.response?.data?.errorCode || error.code || 'UNKNOWN'), paymentId]
      );
      await client.query('COMMIT');
      return handleError(res, error.response?.status || 502, 'Failed to initiate M-Pesa STK Push', {
        payment_id: paymentId,
        errorMessage: message,
      });
    }
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return handleError(res, 500, 'Failed to initiate M-Pesa STK Push', error);
  } finally {
    client.release();
  }
}

async function mpesaCallback(req, res) {
  const client = await pool.connect();
  try {
    const result = req.body?.Body?.stkCallback;
    if (!result) return handleSuccess(res, 200, 'Callback ignored', { ignored: true });

    const checkoutRequestId = result.CheckoutRequestID;
    await client.query('BEGIN');
    const paymentRes = await client.query(
      `SELECT * FROM payments WHERE checkout_request_id=$1 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [checkoutRequestId]
    );
    if (!paymentRes.rows.length) {
      await client.query('COMMIT');
      return handleSuccess(res, 200, 'Callback received but no matching payment found', { matched: false, checkoutRequestId });
    }

    const payment = paymentRes.rows[0];
    const resultCode = Number(result.ResultCode);
    const resultDesc = String(result.ResultDesc || '');

    if (resultCode === 0) {
      const items = Array.isArray(result.CallbackMetadata?.Item) ? result.CallbackMetadata.Item : [];
      const value = (name) => items.find((item) => item.Name === name)?.Value;
      const receivedAmount = new Decimal(value('Amount') ?? payment.amount ?? 0);
      const expectedAmount = new Decimal(payment.expected_amount ?? payment.amount ?? 0);
      const receipt = value('MpesaReceiptNumber') || null;
      const phone = value('PhoneNumber') ? String(value('PhoneNumber')) : payment.customer_phone;

      await client.query(
        `UPDATE payments SET status='completed', received_amount=$1, customer_phone=$2,
         mpesa_receipt=$3, result_code=$4, result_desc=$5, callback_data=$6,
         reconciliation_status=$7, failure_reason=NULL, completed_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP WHERE id=$8`,
        [receivedAmount.toFixed(2), phone, receipt, String(resultCode), resultDesc,
         JSON.stringify(result), receivedAmount.eq(expectedAmount) ? 'matched' : 'mismatch', payment.id]
      );

      let settledOrder = null;
      if (payment.order_id) settledOrder = await syncOrderPayment(client, payment.order_id);

      if (settledOrder?.sms_should_notify_payment_confirmed) {
        try {
          await enqueuePaymentConfirmedSms(client, settledOrder, { paymentId: payment.id });
        } catch (smsError) {
          console.error('Failed to queue payment confirmation SMS:', smsError.message);
        }
      }

      await client.query('COMMIT');

      try {
        const { broadcastPaymentCompleted } = require('../websocket');
        broadcastPaymentCompleted({
          id: payment.id,
          order_id: payment.order_id,
          order_number: settledOrder?.order_number,
          amount: receivedAmount.toFixed(2),
          status: 'completed',
          mpesa_receipt: receipt,
          customer_phone: phone,
          completed_at: new Date(),
        });
      } catch (broadcastError) {
        console.error('Payment websocket broadcast failed:', broadcastError.message);
      }

      return handleSuccess(res, 200, 'Payment successful', { checkoutRequestId, resultCode, resultDesc, mpesa_receipt: receipt });
    }

    const failedStatus = /cancel/i.test(resultDesc) ? 'cancelled' : /timeout/i.test(resultDesc) ? 'timeout' : 'failed';
    await client.query(
      `UPDATE payments SET status=$1, result_code=$2, result_desc=$3, callback_data=$4,
       reconciliation_status='manual_review', failure_reason=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$5`,
      [failedStatus, String(resultCode), resultDesc, JSON.stringify(result), payment.id]
    );
    await client.query('COMMIT');

    try {
      const { broadcastPaymentFailed } = require('../websocket');
      broadcastPaymentFailed({ id: payment.id, order_id: payment.order_id, amount: payment.amount, status: failedStatus, result_code: resultCode, result_desc: resultDesc, customer_phone: payment.customer_phone, failure_reason: resultDesc });
    } catch (broadcastError) {
      console.error('Payment websocket broadcast failed:', broadcastError.message);
    }

    return handleSuccess(res, 200, 'Payment callback processed', { checkoutRequestId, status: failedStatus, resultDesc });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return handleError(res, 500, 'Failed to process M-Pesa callback', error);
  } finally {
    client.release();
  }
}

async function queryPaymentStatus(req, res) {
  try {
    const checkoutRequestId = String(req.params.checkoutRequestId || '').trim();
    const result = await pool.query(
      `SELECT p.*, o.order_number, o.total_amount, o.amount_paid AS order_amount_paid,
              o.payment_status AS order_payment_status, o.payment_state AS order_payment_state,
              GREATEST(COALESCE(o.total_amount,0)-COALESCE(o.amount_paid,0),0)::numeric(12,2) AS order_balance_due
       FROM payments p LEFT JOIN orders o ON o.id=p.order_id
       WHERE p.checkout_request_id=$1 ORDER BY p.id DESC LIMIT 1`,
      [checkoutRequestId]
    );
    if (!result.rows.length) return handleError(res, 404, 'Payment not found');
    return handleSuccess(res, 200, 'Payment status retrieved', result.rows[0]);
  } catch (error) {
    return handleError(res, 500, 'Failed to query payment status', error);
  }
}

module.exports = { initiateSTKPush, mpesaCallback, queryPaymentStatus };
