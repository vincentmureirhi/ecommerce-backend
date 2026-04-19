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
  if (!d.isFinite() || d.lt(0)) throw new Error(`${name} must be a valid non-negative number`);
  return d;
}

function normalizePhone(phone) {
  let phoneNumber = String(phone || '').replace(/\D/g, '');
  if (phoneNumber.length === 9) {
    phoneNumber = `254${phoneNumber}`;
  } else if (phoneNumber.length === 10 && phoneNumber.startsWith('0')) {
    phoneNumber = `254${phoneNumber.substring(1)}`;
  }
  return phoneNumber;
}

function deriveRoutePaymentState(totalAmount, amountPaid, dueDate) {
  const total = new Decimal(totalAmount || 0);
  const paid = new Decimal(amountPaid || 0);
  const balance = Decimal.max(total.minus(paid), 0);

  if (total.gt(0) && balance.lte(0)) return 'paid';

  let state = paid.gt(0) ? 'partial' : 'unpaid';

  if (balance.gt(0) && dueDate) {
    const due = new Date(dueDate);
    const today = new Date();
    due.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    if (due < today) state = 'overdue';
  }

  return state;
}

function inferFailedStatus(resultDesc = '') {
  const text = String(resultDesc || '').toLowerCase();

  if (text.includes('timeout')) return 'timeout';
  if (text.includes('cancel')) return 'cancelled';

  return 'failed';
}

async function getAccessToken(retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const consumerKey = process.env.MPESA_CONSUMER_KEY;
      const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

      const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
      const url = 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

      const response = await axios.get(url, {
        headers: { Authorization: `Basic ${auth}` },
        timeout: 10000,
      });

      return response.data.access_token;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function fetchPaymentWithOrder(db, paymentId) {
  const result = await db.query(
    `
    SELECT
      p.*,
      o.order_number,
      o.customer_name,
      o.customer_phone AS order_customer_phone,
      o.order_type,
      o.total_amount,
      o.amount_paid AS order_amount_paid,
      o.due_date AS order_due_date,
      o.payment_status AS order_payment_status,
      o.payment_state AS order_payment_state,
      GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)::numeric(12,2) AS order_balance_due
    FROM payments p
    LEFT JOIN orders o ON o.id = p.order_id
    WHERE p.id = $1
    `,
    [paymentId]
  );

  return result.rows[0] || null;
}

async function syncOrderSettlement(client, orderId) {
  const orderRes = await client.query(
    `
    SELECT
      id,
      order_type,
      total_amount,
      due_date,
      payment_status,
      payment_state
    FROM orders
    WHERE id = $1
    FOR UPDATE
    `,
    [orderId]
  );

  if (orderRes.rows.length === 0) return null;

  const order = orderRes.rows[0];
  const totalAmount = new Decimal(order.total_amount || 0);

  const paymentAgg = await client.query(
    `
    SELECT
      COALESCE(SUM(COALESCE(received_amount, amount)), 0)::numeric(12,2) AS paid_total,
      MAX(COALESCE(completed_at, updated_at, created_at)) AS last_payment_date
    FROM payments
    WHERE order_id = $1
      AND status IN ('completed', 'manually_resolved')
    `,
    [orderId]
  );

  const paidTotal = new Decimal(paymentAgg.rows[0]?.paid_total || 0);
  const lastPaymentDate = paymentAgg.rows[0]?.last_payment_date || null;

  let paymentStatus = order.payment_status || 'pending';
  let paymentState = order.payment_state || 'unpaid';

  if (order.order_type === 'normal') {
    paymentStatus = paidTotal.gte(totalAmount) && totalAmount.gt(0) ? 'completed' : 'pending';
  } else {
    paymentState = deriveRoutePaymentState(totalAmount, paidTotal, order.due_date);
  }

  const updateRes = await client.query(
    `
    UPDATE orders
    SET
      amount_paid = $1,
      last_payment_date = $2,
      payment_status = $3,
      payment_state = $4,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $5
    RETURNING *
    `,
    [
      paidTotal.toFixed(2),
      lastPaymentDate,
      paymentStatus,
      paymentState,
      orderId,
    ]
  );

  return updateRes.rows[0];
}

const initiateSTKPush = async (req, res) => {
  const client = await pool.connect();

  try {
    const { phone, amount, order_id } = req.body;

    if (!phone || !amount || !order_id) {
      return handleError(res, 400, 'Missing required fields: phone, amount, order_id');
    }

    const orderId = asInt(order_id, 'order_id');
    const amountValue = asMoney(amount, 'amount');
    const phoneNumber = normalizePhone(phone);

    if (!phoneNumber || phoneNumber.length < 12) {
      return handleError(res, 400, 'Invalid phone number');
    }

    await client.query('BEGIN');

    const orderRes = await client.query(
      `
      SELECT
        id,
        order_type,
        total_amount,
        amount_paid,
        customer_phone,
        payment_status,
        payment_state
      FROM orders
      WHERE id = $1
      FOR UPDATE
      `,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Order not found');
    }

    const order = orderRes.rows[0];
    const total = new Decimal(order.total_amount || 0);
    const alreadyPaid = new Decimal(order.amount_paid || 0);
    const balance = Decimal.max(total.minus(alreadyPaid), 0);

    if (balance.lte(0)) {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'Order is already fully paid');
    }

    if (amountValue.gt(balance)) {
      await client.query('ROLLBACK');
      return handleError(res, 400, `Payment exceeds outstanding balance. Balance is ${balance.toFixed(2)}`);
    }

    const insertRes = await client.query(
      `
      INSERT INTO payments
      (
        order_id,
        customer_phone,
        amount,
        expected_amount,
        method,
        source,
        status,
        reconciliation_status
      )
      VALUES ($1, $2, $3, $4, 'mpesa', 'mpesa_auto', 'initiated', 'awaiting_callback')
      RETURNING *
      `,
      [orderId, phoneNumber, amountValue.toFixed(2), amountValue.toFixed(2)]
    );

    const payment = insertRes.rows[0];

    let accessToken;
    let stkResponse;

    try {
      accessToken = await getAccessToken(3);

      const timestamp = moment().format('YYYYMMDDHHmmss');
      const shortCode = process.env.MPESA_BUSINESS_SHORTCODE;
      const passkey = process.env.MPESA_PASSKEY;
      const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');

      const mpesaRequest = {
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(Number(amountValue.toFixed(2))),
        PartyA: phoneNumber,
        PartyB: shortCode,
        PhoneNumber: phoneNumber,
        CallBackURL: process.env.MPESA_CALLBACK_URL,
        AccountReference: `ORD-${orderId}`,
        TransactionDesc: `Payment for Order ${orderId}`,
      };

      stkResponse = await axios.post(
        'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
        mpesaRequest,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      await client.query(
        `
        UPDATE payments
        SET
          status = 'pending',
          merchant_request_id = $1,
          checkout_request_id = $2,
          result_desc = $3,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        `,
        [
          stkResponse.data.MerchantRequestID || null,
          stkResponse.data.CheckoutRequestID || null,
          stkResponse.data.CustomerMessage || 'STK sent',
          payment.id,
        ]
      );

      await client.query('COMMIT');

      return handleSuccess(res, 200, 'STK Push sent successfully', {
        payment_id: payment.id,
        CheckoutRequestID: stkResponse.data.CheckoutRequestID,
        MerchantRequestID: stkResponse.data.MerchantRequestID,
        message: stkResponse.data.CustomerMessage || 'Please check your phone for M-Pesa prompt',
      });
    } catch (err) {
      const status = err.response?.status;
      const errorCode = err.response?.data?.errorCode || err.code || 'UNKNOWN';
      const errorMessage = err.response?.data?.errorMessage || err.message || 'Unknown STK error';

      const failedStatus =
        err.code === 'ECONNABORTED'
          ? 'timeout'
          : inferFailedStatus(errorMessage);

      await client.query(
        `
        UPDATE payments
        SET
          status = $1,
          reconciliation_status = 'manual_review',
          failure_reason = $2,
          result_code = $3,
          result_desc = $4,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $5
        `,
        [
          failedStatus,
          errorMessage,
          String(errorCode),
          errorMessage,
          payment.id,
        ]
      );

      await client.query('COMMIT');

      return handleError(res, status || 500, 'Failed to initiate STK push. Sandbox failure is expected until real credentials are live.', {
        payment_id: payment.id,
        code: errorCode,
        errorMessage,
        status: failedStatus,
      });
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    return handleError(res, 500, 'Failed to initiate STK push', err);
  } finally {
    client.release();
  }
};

const mpesaCallback = async (req, res) => {
  const client = await pool.connect();

  try {
    const result = req.body?.Body?.stkCallback;

    if (!result) {
      return handleSuccess(res, 200, 'Callback ignored', { ignored: true });
    }

    const checkoutRequestId = result.CheckoutRequestID;
    const resultCode = Number(result.ResultCode);
    const resultDesc = result.ResultDesc || '';

    await client.query('BEGIN');

    const paymentRes = await client.query(
      `
      SELECT *
      FROM payments
      WHERE checkout_request_id = $1
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
      `,
      [checkoutRequestId]
    );

    if (paymentRes.rows.length === 0) {
      await client.query('COMMIT');
      return handleSuccess(res, 200, 'Callback received but no matching payment found', {
        checkoutRequestId,
        matched: false,
      });
    }

    const payment = paymentRes.rows[0];

    if (resultCode === 0) {
      const metadata = Array.isArray(result.CallbackMetadata?.Item)
        ? result.CallbackMetadata.Item
        : [];

      const amount = metadata.find((m) => m.Name === 'Amount')?.Value;
      const mpesaCode = metadata.find((m) => m.Name === 'MpesaReceiptNumber')?.Value;
      const phoneNumber = metadata.find((m) => m.Name === 'PhoneNumber')?.Value;

      const receivedAmount = new Decimal(amount || payment.amount || 0);
      const expectedAmount = new Decimal(payment.expected_amount || payment.amount || 0);
      const reconciliationStatus = receivedAmount.equals(expectedAmount) ? 'matched' : 'mismatch';

      await client.query(
        `
        UPDATE payments
        SET
          status = 'completed',
          received_amount = $1,
          customer_phone = COALESCE($2, customer_phone),
          mpesa_receipt = $3,
          result_code = $4,
          result_desc = $5,
          callback_data = $6,
          reconciliation_status = $7,
          failure_reason = NULL,
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $8
        `,
        [
          receivedAmount.toFixed(2),
          phoneNumber ? String(phoneNumber) : null,
          mpesaCode || null,
          String(resultCode),
          resultDesc,
          JSON.stringify(result),
          reconciliationStatus,
          payment.id,
        ]
      );

      if (payment.order_id) {
        await syncOrderSettlement(client, payment.order_id);
      }

      await client.query('COMMIT');

      try {
        const { broadcastPaymentCompleted } = require('../websocket');
        broadcastPaymentCompleted({
          id: payment.id,
          order_id: payment.order_id,
          amount: receivedAmount.toFixed(2),
          status: 'completed',
          mpesa_receipt: mpesaCode,
          customer_phone: phoneNumber,
          completed_at: new Date(),
        });
      } catch (_) {}

      return handleSuccess(res, 200, 'Payment successful', {
        checkoutRequestId,
        resultCode,
        resultDesc,
      });
    }

    const failedStatus = inferFailedStatus(resultDesc);

    await client.query(
      `
      UPDATE payments
      SET
        status = $1,
        result_code = $2,
        result_desc = $3,
        callback_data = $4,
        reconciliation_status = 'manual_review',
        failure_reason = $5,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      `,
      [
        failedStatus,
        String(resultCode),
        resultDesc,
        JSON.stringify(result),
        resultDesc,
        payment.id,
      ]
    );

    if (payment.order_id) {
      await syncOrderSettlement(client, payment.order_id);
    }

    await client.query('COMMIT');

    try {
      const { broadcastPaymentFailed } = require('../websocket');
      broadcastPaymentFailed({
        id: payment.id,
        order_id: payment.order_id,
        amount: payment.amount,
        status: failedStatus,
        result_code: resultCode,
        result_desc: resultDesc,
        customer_phone: payment.customer_phone,
        failure_reason: resultDesc,
      });
    } catch (_) {}

    return handleSuccess(res, 200, 'Payment callback processed', {
      checkoutRequestId,
      status: failedStatus,
      resultDesc,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    return handleError(res, 500, 'Failed to process M-Pesa callback', err);
  } finally {
    client.release();
  }
};

const queryPaymentStatus = async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM payments
      WHERE checkout_request_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [checkoutRequestId]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Payment not found');
    }

    return handleSuccess(res, 200, 'Payment status retrieved', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to query payment status', err);
  }
};

const getPaymentForOrder = async (req, res) => {
  try {
    const orderId = asInt(req.params.order_id, 'order_id');

    const result = await pool.query(
      `
      SELECT
        p.*,
        o.order_number,
        o.customer_name,
        o.customer_phone AS order_customer_phone,
        o.order_type,
        o.total_amount,
        o.amount_paid AS order_amount_paid,
        GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)::numeric(12,2) AS order_balance_due
      FROM payments p
      LEFT JOIN orders o ON o.id = p.order_id
      WHERE p.order_id = $1
      ORDER BY p.created_at DESC
      LIMIT 1
      `,
      [orderId]
    );

    if (result.rows.length === 0) {
      return handleSuccess(res, 200, 'No payment found', null);
    }

    return handleSuccess(res, 200, 'Payment retrieved', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to get payment', err);
  }
};

const createPayment = async (req, res) => {
  const client = await pool.connect();

  try {
    const orderId = asInt(req.body.order_id, 'order_id');
    const amount = asMoney(req.body.amount, 'amount');
    const method = String(req.body.method || '').toLowerCase().trim();
    const reference = req.body.reference ? String(req.body.reference).trim() : null;
    const notes = req.body.notes ? String(req.body.notes).trim() : null;
    const customerPhone = req.body.customer_phone ? normalizePhone(req.body.customer_phone) : null;

    const allowedMethods = new Set(['cash', 'mpesa', 'bank', 'card', 'other']);
    if (!allowedMethods.has(method)) {
      return handleError(res, 400, `method must be one of: ${Array.from(allowedMethods).join(', ')}`);
    }

    await client.query('BEGIN');

    const orderRes = await client.query(
      `
      SELECT
        id,
        order_type,
        total_amount,
        amount_paid,
        customer_phone,
        due_date
      FROM orders
      WHERE id = $1
      FOR UPDATE
      `,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Order not found');
    }

    const order = orderRes.rows[0];
    const total = new Decimal(order.total_amount || 0);
    const paid = new Decimal(order.amount_paid || 0);
    const balance = Decimal.max(total.minus(paid), 0);

    if (amount.gt(balance)) {
      await client.query('ROLLBACK');
      return handleError(res, 400, `Payment exceeds order balance. Balance is ${balance.toFixed(2)}`);
    }

    const source = order.order_type === 'route' ? 'route_settlement' : 'manual';
    const reconciliationStatus = 'manual_override';
    const resolvedByUserId = req.user?.id || null;

    const insertRes = await client.query(
      `
      INSERT INTO payments
      (
        order_id,
        customer_phone,
        amount,
        expected_amount,
        received_amount,
        method,
        reference,
        notes,
        source,
        status,
        reconciliation_status,
        completed_at,
        reconciled_at,
        manual_notes,
        resolved_by_user_id
      )
      VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'completed', $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $11, $12)
      RETURNING *
      `,
      [
        orderId,
        customerPhone || order.customer_phone || null,
        amount.toFixed(2),
        balance.toFixed(2),
        amount.toFixed(2),
        method,
        reference,
        notes,
        source,
        reconciliationStatus,
        notes,
        resolvedByUserId,
      ]
    );

    await syncOrderSettlement(client, orderId);
    await client.query('COMMIT');

    const payment = await fetchPaymentWithOrder(client, insertRes.rows[0].id);
    return handleSuccess(res, 201, 'Payment recorded', payment);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    return handleError(res, 500, 'Failed to record payment', err);
  } finally {
    client.release();
  }
};

const getPayments = async (req, res) => {
  try {
    const { status, method, search, date_from, date_to } = req.query;

    let query = `
      SELECT
        p.*,
        o.order_number,
        o.customer_name,
        o.customer_phone AS order_customer_phone,
        o.order_type,
        o.total_amount,
        o.amount_paid AS order_amount_paid,
        o.due_date AS order_due_date,
        o.payment_status AS order_payment_status,
        o.payment_state AS order_payment_state,
        GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)::numeric(12,2) AS order_balance_due
      FROM payments p
      LEFT JOIN orders o ON o.id = p.order_id
      WHERE 1=1
    `;

    const params = [];
    let i = 1;

    if (status) {
      params.push(status);
      query += ` AND p.status = $${i++}`;
    }

    if (method) {
      params.push(method);
      query += ` AND LOWER(COALESCE(p.method, '')) = LOWER($${i++})`;
    }

    if (date_from) {
      params.push(date_from);
      query += ` AND DATE(p.created_at) >= $${i++}`;
    }

    if (date_to) {
      params.push(date_to);
      query += ` AND DATE(p.created_at) <= $${i++}`;
    }

    if (search) {
      params.push(`%${search}%`);
      query += `
        AND (
          p.id::text ILIKE $${i}
          OR COALESCE(o.order_number, '') ILIKE $${i}
          OR COALESCE(o.customer_name, '') ILIKE $${i}
          OR COALESCE(p.customer_phone, '') ILIKE $${i}
          OR COALESCE(p.mpesa_receipt, '') ILIKE $${i}
          OR COALESCE(p.reference, '') ILIKE $${i}
        )
      `;
      i++;
    }

    query += ` ORDER BY p.created_at DESC LIMIT 500`;

    const result = await pool.query(query, params);
    return handleSuccess(res, 200, 'Payments retrieved', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to list payments', err);
  }
};

const getPaymentById = async (req, res) => {
  try {
    const paymentId = asInt(req.params.id, 'payment id');
    const payment = await fetchPaymentWithOrder(pool, paymentId);

    if (!payment) {
      return handleError(res, 404, 'Payment not found');
    }

    return handleSuccess(res, 200, 'Payment retrieved', payment);
  } catch (err) {
    return handleError(res, 500, 'Failed to fetch payment', err);
  }
};

const reconcilePayment = async (req, res) => {
  const client = await pool.connect();

  try {
    const paymentId = asInt(req.params.id, 'payment id');
    const {
      status,
      received_amount,
      mpesa_receipt,
      reference,
      failure_reason,
      manual_notes,
      reconciliation_status,
    } = req.body;

    await client.query('BEGIN');

    const paymentRes = await client.query(
      `SELECT * FROM payments WHERE id = $1 FOR UPDATE`,
      [paymentId]
    );

    if (paymentRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Payment not found');
    }

    const payment = paymentRes.rows[0];
    const nextStatus = status ? String(status).trim() : payment.status;
    const allowedStatuses = new Set([
      'initiated',
      'pending',
      'completed',
      'failed',
      'cancelled',
      'timeout',
      'reversed',
      'manually_resolved',
    ]);

    if (!allowedStatuses.has(nextStatus)) {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'Invalid payment status');
    }

    let nextReceivedAmount = payment.received_amount;
    if (received_amount !== undefined && received_amount !== null && received_amount !== '') {
      nextReceivedAmount = asMoney(received_amount, 'received_amount').toFixed(2);
    }

    if ((nextStatus === 'completed' || nextStatus === 'manually_resolved') && !nextReceivedAmount) {
      nextReceivedAmount = new Decimal(payment.amount || 0).toFixed(2);
    }

    const nextReconciliationStatus =
      reconciliation_status ||
      (nextStatus === 'completed' || nextStatus === 'manually_resolved'
        ? 'manual_override'
        : payment.reconciliation_status || 'manual_review');

    const completedAt =
      nextStatus === 'completed' || nextStatus === 'manually_resolved'
        ? (payment.completed_at || new Date().toISOString())
        : null;

    await client.query(
      `
      UPDATE payments
      SET
        status = $1,
        received_amount = $2,
        mpesa_receipt = COALESCE($3, mpesa_receipt),
        reference = COALESCE($4, reference),
        failure_reason = $5,
        manual_notes = COALESCE($6, manual_notes),
        reconciliation_status = $7,
        completed_at = $8,
        reconciled_at = CURRENT_TIMESTAMP,
        resolved_by_user_id = $9,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      `,
      [
        nextStatus,
        nextReceivedAmount,
        mpesa_receipt || null,
        reference || null,
        failure_reason || null,
        manual_notes || null,
        nextReconciliationStatus,
        completedAt,
        req.user?.id || null,
        paymentId,
      ]
    );

    if (payment.order_id) {
      await syncOrderSettlement(client, payment.order_id);
    }

    await client.query('COMMIT');

    const updatedPayment = await fetchPaymentWithOrder(client, paymentId);
    return handleSuccess(res, 200, 'Payment reconciled successfully', updatedPayment);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    return handleError(res, 500, 'Failed to reconcile payment', err);
  } finally {
    client.release();
  }
};

const getPaymentSummary = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('completed', 'manually_resolved') THEN COALESCE(received_amount, amount) ELSE 0 END), 0)::numeric(12,2) AS total_collected,
        COUNT(*) FILTER (WHERE status IN ('completed', 'manually_resolved')) AS completed_count,
        COUNT(*) FILTER (WHERE status IN ('initiated', 'pending')) AS pending_count,
        COUNT(*) FILTER (WHERE status IN ('failed', 'cancelled', 'timeout')) AS failed_count,
        COUNT(*) FILTER (WHERE status = 'reversed') AS reversed_count,
        COUNT(*) FILTER (WHERE reconciliation_status IN ('mismatch', 'manual_review')) AS needs_review_count,
        COUNT(*) FILTER (WHERE status = 'timeout') AS timeout_count,
        COUNT(*) FILTER (WHERE source = 'mpesa_auto') AS stk_total_count,
        COUNT(*) FILTER (WHERE source = 'mpesa_auto' AND status IN ('completed', 'manually_resolved')) AS stk_success_count,
        COUNT(*) FILTER (WHERE source = 'route_settlement') AS route_settlement_count
      FROM payments
      `
    );

    const row = result.rows[0] || {};
    const stkTotal = Number(row.stk_total_count || 0);
    const stkSuccess = Number(row.stk_success_count || 0);

    return handleSuccess(res, 200, 'Payment summary retrieved', {
      ...row,
      stk_success_rate: stkTotal > 0 ? Number(((stkSuccess / stkTotal) * 100).toFixed(1)) : 0,
    });
  } catch (err) {
    return handleError(res, 500, 'Failed to get payment summary', err);
  }
};

module.exports = {
  initiateSTKPush,
  mpesaCallback,
  queryPaymentStatus,
  getPaymentForOrder,
  createPayment,
  getPayments,
  getPaymentById,
  getPaymentSummary,
  reconcilePayment,
};