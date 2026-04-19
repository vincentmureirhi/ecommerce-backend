'use strict';

const axios = require('axios');
const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const Decimal = require('decimal.js');
const moment = require('moment');

function asInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be an integer >= 1`);
  return n;
}

function asMoney(v, name) {
  const d = new Decimal(v);
  if (!d.isFinite() || d.lte(0)) throw new Error(`${name} must be a number > 0`);
  return d;
}

const ALLOWED_METHODS = new Set(['cash', 'mpesa', 'bank', 'card', 'other']);

// ============================================
// M-PESA / STK PUSH FUNCTIONS
// ============================================

// Generate access token
async function getAccessToken() {
  try {
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    const url = 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

    const response = await axios.get(url, {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });

    console.log('✅ Access token generated');
    return response.data.access_token;
  } catch (err) {
    console.error('❌ getAccessToken error:', err.message);
    throw new Error('Failed to get M-Pesa access token');
  }
}

// Initiate STK Push
const initiateSTKPush = async (req, res) => {
  try {
    const { phone, amount, order_id } = req.body;

    if (!phone || !amount || !order_id) {
      return handleError(res, 400, 'Missing required fields: phone, amount, order_id');
    }

    // Clean phone number - convert to 254XXXXXXXXX format
    let phoneNumber = phone.replace(/\D/g, '');
    if (phoneNumber.length === 9) {
      phoneNumber = `254${phoneNumber}`;
    } else if (phoneNumber.length === 10 && phoneNumber.startsWith('0')) {
      phoneNumber = `254${phoneNumber.substring(1)}`;
    }

    console.log(`📱 Initiating STK Push for phone: ${phoneNumber}, amount: ${amount}, order: ${order_id}`);

    const accessToken = await getAccessToken();
    const timestamp = moment().format('YYYYMMDDHHmmss');
    const shortCode = process.env.MPESA_BUSINESS_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;

    // Generate password: Base64(BusinessShortCode + Passkey + Timestamp)
    const passwordString = `${shortCode}${passkey}${timestamp}`;
    const password = Buffer.from(passwordString).toString('base64');

    const mpesaRequest = {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: phoneNumber,
      PartyB: shortCode,
      PhoneNumber: phoneNumber,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: `ORD-${order_id}`,
      TransactionDesc: `Payment for Order ${order_id}`,
    };

    console.log('📤 STK Push Request:', JSON.stringify(mpesaRequest, null, 2));

    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      mpesaRequest,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('📥 STK Push Response:', JSON.stringify(response.data, null, 2));

    const checkoutRequestId = response.data.CheckoutRequestID;
    const merchantRequestId = response.data.MerchantRequestID;

    // Save payment request to database
    await pool.query(
      `INSERT INTO payments (order_id, customer_phone, amount, merchant_request_id, checkout_request_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [order_id, phoneNumber, amount, merchantRequestId, checkoutRequestId]
    );

    return handleSuccess(res, 200, 'STK Push sent successfully', {
      CheckoutRequestID: checkoutRequestId,
      MerchantRequestID: merchantRequestId,
      message: 'Please check your phone for M-Pesa prompt',
    });
  } catch (err) {
    console.error('❌ initiateSTKPush error:', err.message);

    // Log detailed error response from Safaricom
    if (err.response) {
      console.error('❌ Safaricom Error Status:', err.response.status);
      console.error('❌ Safaricom Error Data:', JSON.stringify(err.response.data, null, 2));
      console.error('❌ Safaricom Error Headers:', err.response.headers);
    } else if (err.request) {
      console.error('❌ No response received from Safaricom:', err.request);
    } else {
      console.error('❌ Error setting up request:', err.message);
    }

    return handleError(res, 500, 'Failed to initiate STK push', err);
  }
};

// M-Pesa callback handler
const mpesaCallback = async (req, res) => {
  try {
    const { Body } = req.body;
    const result = Body.stkCallback;

    console.log('🔔 M-Pesa Callback received:', result);

    const checkoutRequestId = result.CheckoutRequestID;
    const resultCode = result.ResultCode;
    const resultDesc = result.ResultDesc;

    if (resultCode === 0) {
      // Payment successful
      console.log('✅ Payment successful!');

      const metadata = result.CallbackMetadata.Item;
      const amount = metadata.find((m) => m.Name === 'Amount')?.Value;
      const mpesaCode = metadata.find((m) => m.Name === 'MpesaReceiptNumber')?.Value;
      const phoneNumber = metadata.find((m) => m.Name === 'PhoneNumber')?.Value;

      // Update payment in database
      await pool.query(
        `UPDATE payments
         SET status = 'completed',
             result_code = $1,
             result_desc = $2,
             mpesa_receipt_number = $3,
             callback_received_at = CURRENT_TIMESTAMP,
             completed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE checkout_request_id = $4`,
        [resultCode, resultDesc, mpesaCode, checkoutRequestId]
      );

      // Get order ID and update order payment status
      const paymentResult = await pool.query(
        `SELECT order_id FROM payments WHERE checkout_request_id = $1`,
        [checkoutRequestId]
      );

      if (paymentResult.rows.length > 0) {
        const orderId = paymentResult.rows[0].order_id;
        await pool.query(
          `UPDATE orders 
           SET payment_status = 'completed', 
               payment_state = 'paid',
               updated_at = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [orderId]
        );
        console.log(`✅ Order ${orderId} payment completed`);
      }
    } else {
      // Payment failed or cancelled
      console.log(`❌ Payment failed: ${resultDesc}`);

      await pool.query(
        `UPDATE payments
         SET status = $1,
             result_code = $2,
             result_desc = $3,
             callback_received_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE checkout_request_id = $4`,
        [resultCode === 1032 ? 'cancelled' : 'failed', resultCode, resultDesc, checkoutRequestId]
      );

      // Update order
      const paymentResult = await pool.query(
        `SELECT order_id FROM payments WHERE checkout_request_id = $1`,
        [checkoutRequestId]
      );

      if (paymentResult.rows.length > 0) {
        const orderId = paymentResult.rows[0].order_id;
        const status = resultCode === 1032 ? 'payment_cancelled' : 'payment_failed';
        await pool.query(
          `UPDATE orders 
           SET payment_state = $1,
               updated_at = CURRENT_TIMESTAMP 
           WHERE id = $2`,
          [status, orderId]
        );
      }
    }

    // Always return 200 to M-Pesa to confirm receipt
    return res.status(200).json({ status: 'success' });
  } catch (err) {
    console.error('❌ mpesaCallback error:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

// Query payment status
const queryPaymentStatus = async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;

    const result = await pool.query(
      `SELECT * FROM payments WHERE checkout_request_id = $1`,
      [checkoutRequestId]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Payment not found');
    }

    return handleSuccess(res, 200, 'Payment status retrieved', result.rows[0]);
  } catch (err) {
    console.error('❌ queryPaymentStatus error:', err.message);
    return handleError(res, 500, 'Failed to query payment status', err);
  }
};

// Get payment for order
const getPaymentForOrder = async (req, res) => {
  try {
    const { order_id } = req.params;

    const result = await pool.query(
      `SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [order_id]
    );

    if (result.rows.length === 0) {
      return handleSuccess(res, 200, 'No payment found', null);
    }

    return handleSuccess(res, 200, 'Payment retrieved', result.rows[0]);
  } catch (err) {
    console.error('❌ getPaymentForOrder error:', err.message);
    return handleError(res, 500, 'Failed to get payment', err);
  }
};

// ============================================
// REGULAR PAYMENT FUNCTIONS (Admin)
// ============================================

// POST /api/payments
const createPayment = async (req, res) => {
  const client = await pool.connect();
  try {
    const order_id = asInt(req.body.order_id, 'order_id');
    const amount = asMoney(req.body.amount, 'amount');
    const method = String(req.body.method || '').toLowerCase().trim();
    const reference = req.body.reference ? String(req.body.reference).trim() : null;
    const notes = req.body.notes ? String(req.body.notes).trim() : null;

    if (!ALLOWED_METHODS.has(method)) {
      return handleError(res, 400, `method must be one of: ${Array.from(ALLOWED_METHODS).join(', ')}`);
    }

    await client.query('BEGIN');

    // lock the order row (prevents race payments)
    const orderRes = await client.query(
      `SELECT id, total_amount::numeric(12,2) AS total_amount
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [order_id]
    );

    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Order not found');
    }

    const orderTotal = new Decimal(orderRes.rows[0].total_amount);

    // current paid total
    const paidRes = await client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS paid
       FROM payments
       WHERE order_id = $1 AND status='completed'`,
      [order_id]
    );
    const paid = new Decimal(paidRes.rows[0].paid);
    const balance = orderTotal.minus(paid);

    // Hard rule: do not allow overpayment (unless you design credit notes later)
    if (amount.gt(balance)) {
      await client.query('ROLLBACK');
      return handleError(res, 400, `Payment exceeds balance. Balance is ${balance.toFixed(2)}`);
    }

    // received_by: best-effort (depends on your auth middleware)
    const receivedBy = (req.user && req.user.id) || req.userId || null;

    const insertRes = await client.query(
      `INSERT INTO payments (order_id, amount, method, reference, received_by_user_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [order_id, amount.toFixed(2), method, reference, receivedBy, notes]
    );

    // update order payment_status based on new totals
    const newPaid = paid.plus(amount);
    let payment_status = 'pending';
    if (newPaid.eq(0)) payment_status = 'pending';
    else if (newPaid.lt(orderTotal)) payment_status = 'pending';
    else payment_status = 'completed';

    await client.query(
      `UPDATE orders
       SET payment_status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [payment_status, order_id]
    );

    await client.query('COMMIT');

    return handleSuccess(res, 201, 'Payment recorded', insertRes.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return handleError(res, 500, 'Failed to record payment', err);
  } finally {
    client.release();
  }
};

// GET /api/payments (admin)
const getPayments = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, o.order_number, o.customer_name
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       ORDER BY p.id DESC
       LIMIT 200`
    );
    return handleSuccess(res, 200, 'Payments retrieved', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to list payments', err);
  }
};

// GET /api/payments/order/:orderId
const getPaymentsByOrder = async (req, res) => {
  try {
    const orderId = asInt(req.params.orderId, 'orderId');

    const result = await pool.query(
      `SELECT *
       FROM payments
       WHERE order_id = $1
       ORDER BY id ASC`,
      [orderId]
    );

    const summary = await pool.query(
      `SELECT * FROM v_order_payment_summary WHERE order_id=$1`,
      [orderId]
    );

    return handleSuccess(res, 200, 'Payments retrieved', {
      payments: result.rows,
      summary: summary.rows[0] || null,
    });
  } catch (err) {
    return handleError(res, 500, 'Failed to fetch payments', err);
  }
};

// GET /api/payments/summary
const getPaymentSummary = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        COUNT(*) as total_payments,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_payments,
        SUM(amount) as total_amount,
        SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as completed_amount
       FROM payments`
    );
    return handleSuccess(res, 200, 'Payment summary retrieved', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to get payment summary', err);
  }
};

// POST /api/payments/:id/reverse (admin)
const reversePayment = async (req, res) => {
  const client = await pool.connect();
  try {
    const id = asInt(req.params.id, 'payment id');

    await client.query('BEGIN');

    const payRes = await client.query(
      `SELECT * FROM payments WHERE id=$1 FOR UPDATE`,
      [id]
    );
    if (payRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Payment not found');
    }

    const payment = payRes.rows[0];
    if (payment.status !== 'completed') {
      await client.query('ROLLBACK');
      return handleError(res, 400, `Only completed payments can be reversed. Current: ${payment.status}`);
    }

    await client.query(
      `UPDATE payments
       SET status='reversed'
       WHERE id=$1`,
      [id]
    );

    // recompute order payment_status
    const orderRes = await client.query(
      `SELECT id, total_amount::numeric(12,2) AS total_amount
       FROM orders
       WHERE id=$1
       FOR UPDATE`,
      [payment.order_id]
    );

    const orderTotal = new Decimal(orderRes.rows[0].total_amount);

    const paidRes = await client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS paid
       FROM payments
       WHERE order_id=$1 AND status='completed'`,
      [payment.order_id]
    );

    const paid = new Decimal(paidRes.rows[0].paid);

    let payment_status = 'pending';
    if (paid.gte(orderTotal)) payment_status = 'completed';

    await client.query(
      `UPDATE orders
       SET payment_status=$1, updated_at=CURRENT_TIMESTAMP
       WHERE id=$2`,
      [payment_status, payment.order_id]
    );

    await client.query('COMMIT');
    return handleSuccess(res, 200, 'Payment reversed', { id, status: 'reversed' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return handleError(res, 500, 'Failed to reverse payment', err);
  } finally {
    client.release();
  }
};

module.exports = {
  // M-Pesa / STK Push
  initiateSTKPush,
  mpesaCallback,
  queryPaymentStatus,
  getPaymentForOrder,
  // Regular Payments (Admin)
  createPayment,
  getPayments,
  getPaymentsByOrder,
  getPaymentSummary,
  reversePayment,
};