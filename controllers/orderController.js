'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const generateOrderNumber = require('../utils/generateOrderNumber');

const VALID_ORDER_TYPES = new Set(['normal', 'route']);

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value) {
  return Number(toNumber(value, 0).toFixed(2));
}

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function deriveRoutePaymentState(totalAmount, amountPaid, dueDate) {
  const total = toNumber(totalAmount, 0);
  const paid = Math.max(0, toNumber(amountPaid, 0));
  const balance = Math.max(total - paid, 0);

  if (total > 0 && balance <= 0) {
    return 'paid';
  }

  let state = paid > 0 ? 'partial' : 'unpaid';

  if (balance > 0 && dueDate) {
    const due = new Date(dueDate);
    const today = new Date();

    due.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);

    if (due < today) {
      state = 'overdue';
    }
  }

  return state;
}

function enrichOrder(order) {
  const totalAmount = toNumber(order.total_amount, 0);
  const amountPaid = Math.max(0, toNumber(order.amount_paid, 0));
  const balanceDue = Math.max(totalAmount - amountPaid, 0);

  const derivedPaymentState =
    order.order_type === 'route'
      ? deriveRoutePaymentState(totalAmount, amountPaid, order.due_date)
      : (order.payment_state || 'unpaid');

  return {
    ...order,
    total_amount: roundMoney(totalAmount),
    amount_paid: roundMoney(amountPaid),
    balance_due: roundMoney(balanceDue),
    payment_state: derivedPaymentState,
    settlement_label:
      order.order_type === 'route'
        ? derivedPaymentState
        : (order.payment_status || 'pending'),
  };
}

async function fetchValidatedProduct(client, productId) {
  const result = await client.query(
    `
    SELECT
      id,
      name,
      sku,
      retail_price,
      wholesale_price,
      requires_manual_price,
      current_stock
    FROM products
    WHERE id = $1
    `,
    [productId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Product does not exist: ${productId}`);
  }

  return result.rows[0];
}

// GET ALL ORDERS
const getAllOrders = async (req, res) => {
  try {
    const {
      order_type,
      order_status,
      customer_id,
      sales_rep_id,
      search,
      printed_status,
      payment_state,
    } = req.query;

    let query = `
      SELECT
        o.*,
        COALESCE(o.amount_paid, 0) AS amount_paid,
        sr.name AS sales_rep_name,
        sr.phone_number AS sales_rep_phone,
        l.name AS location_name,
        r.name AS region_name,
        COUNT(DISTINCT oi.id) AS item_count,
        COALESCE(SUM(oi.quantity), 0) AS total_items
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      LEFT JOIN sales_reps sr ON o.sales_rep_id = sr.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (order_type) {
      params.push(order_type);
      query += ` AND o.order_type = $${paramIndex}`;
      paramIndex++;
    }

    if (order_status) {
      params.push(order_status);
      query += ` AND o.order_status = $${paramIndex}`;
      paramIndex++;
    }

    if (customer_id) {
      params.push(customer_id);
      query += ` AND o.customer_id = $${paramIndex}`;
      paramIndex++;
    }

    if (sales_rep_id) {
      params.push(sales_rep_id);
      query += ` AND o.sales_rep_id = $${paramIndex}`;
      paramIndex++;
    }

    if (printed_status === 'printed') {
      query += ` AND COALESCE(o.is_printed, FALSE) = TRUE`;
    }

    if (printed_status === 'not_printed') {
      query += ` AND COALESCE(o.is_printed, FALSE) = FALSE`;
    }

    if (payment_state) {
      if (payment_state === 'paid') {
        query += `
          AND o.order_type = 'route'
          AND GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0) = 0
        `;
      } else if (payment_state === 'partial') {
        query += `
          AND o.order_type = 'route'
          AND COALESCE(o.amount_paid, 0) > 0
          AND GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0) > 0
          AND (o.due_date IS NULL OR o.due_date >= CURRENT_DATE)
        `;
      } else if (payment_state === 'unpaid') {
        query += `
          AND o.order_type = 'route'
          AND COALESCE(o.amount_paid, 0) <= 0
          AND GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0) > 0
          AND (o.due_date IS NULL OR o.due_date >= CURRENT_DATE)
        `;
      } else if (payment_state === 'overdue') {
        query += `
          AND o.order_type = 'route'
          AND GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0) > 0
          AND o.due_date IS NOT NULL
          AND o.due_date < CURRENT_DATE
        `;
      }
    }

    if (search) {
      params.push(`%${search}%`);
      query += `
        AND (
          o.order_number ILIKE $${paramIndex}
          OR o.customer_name ILIKE $${paramIndex}
          OR COALESCE(l.name, '') ILIKE $${paramIndex}
          OR COALESCE(r.name, '') ILIKE $${paramIndex}
          OR COALESCE(sr.name, '') ILIKE $${paramIndex}
        )
      `;
      paramIndex++;
    }

    query += `
      GROUP BY o.id, sr.id, l.id, r.id
      ORDER BY o.created_at DESC
    `;

    const result = await pool.query(query, params);
    const rows = result.rows.map(enrichOrder);

    return handleSuccess(res, 200, 'Orders retrieved successfully', rows);
  } catch (err) {
    console.error('getAllOrders error:', err.message);
    return handleError(res, 500, 'Failed to retrieve orders', err);
  }
};

// GET SINGLE ORDER BY ID
const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query(
      `
      SELECT
        o.*,
        COALESCE(o.amount_paid, 0) AS amount_paid,
        sr.name AS sales_rep_name,
        sr.phone_number AS sales_rep_phone,
        l.name AS location_name,
        r.name AS region_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      LEFT JOIN sales_reps sr ON o.sales_rep_id = sr.id
      WHERE o.id = $1
      `,
      [id]
    );

    if (orderResult.rows.length === 0) {
      return handleError(res, 404, 'Order not found');
    }

    const itemsResult = await pool.query(
      `
      SELECT
        oi.id,
        oi.order_id,
        oi.product_id,
        oi.quantity,
        oi.price_at_purchase,
        COALESCE(oi.line_total, oi.quantity * oi.price_at_purchase) AS line_total,
        oi.price_source,
        oi.pricing_locked_at,
        oi.created_at,
        p.name AS product_name,
        p.sku,
        p.image_url,
        oi.price_at_purchase AS unit_price,
        COALESCE(oi.line_total, oi.quantity * oi.price_at_purchase) AS total_price
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
      ORDER BY oi.id ASC
      `,
      [id]
    );

    const order = enrichOrder(orderResult.rows[0]);
    order.items = itemsResult.rows.map((item) => ({
      ...item,
      price_at_purchase: roundMoney(item.price_at_purchase),
      line_total: roundMoney(item.line_total),
      unit_price: roundMoney(item.unit_price),
      total_price: roundMoney(item.total_price),
    }));

    return handleSuccess(res, 200, 'Order retrieved successfully', order);
  } catch (err) {
    console.error('getOrderById error:', err.message);
    return handleError(res, 500, 'Failed to retrieve order', err);
  }
};

// GUEST CHECKOUT — public endpoint, no auth required
const guestCheckout = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      customer_name,
      customer_phone,
      customer_email,
      delivery_address,
      notes,
      items,
    } = req.body;

    const normalizedName = normalizeText(customer_name);
    const normalizedPhone = normalizeText(customer_phone);
    const normalizedEmail = normalizeText(customer_email);
    const normalizedAddress = normalizeText(delivery_address);
    const normalizedNotes = normalizeText(notes);

    if (!normalizedName) {
      return handleError(res, 400, 'customer_name is required');
    }
    if (!normalizedPhone) {
      return handleError(res, 400, 'customer_phone is required');
    }
    if (!Array.isArray(items) || items.length === 0) {
      return handleError(res, 400, 'At least one order item is required');
    }

    await client.query('BEGIN');

    // Find or create a buying customer record (customer_type = 'normal')
    let customerId;
    const existingCustomer = await client.query(
      `SELECT id FROM customers
       WHERE phone = $1 AND customer_type = 'normal'
       LIMIT 1`,
      [normalizedPhone]
    );

    if (existingCustomer.rows.length > 0) {
      customerId = existingCustomer.rows[0].id;
      // Update name/email/address if provided
      await client.query(
        `UPDATE customers
         SET name = $1,
             email = COALESCE($2, email),
             address = COALESCE($3, address),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [normalizedName, normalizedEmail, normalizedAddress, customerId]
      );
    } else {
      const newCustomer = await client.query(
        `INSERT INTO customers
         (name, phone, email, address, customer_type, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'normal', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id`,
        [normalizedName, normalizedPhone, normalizedEmail, normalizedAddress]
      );
      customerId = newCustomer.rows[0].id;
    }

    // Validate and prepare order items
    const preparedItems = [];
    let computedTotalAmount = 0;

    for (const rawItem of items) {
      const productId = Number(rawItem.product_id);
      const quantity = Number(rawItem.quantity || 0);

      if (!Number.isInteger(productId) || productId <= 0) {
        throw new Error('Invalid product_id in order items');
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(`Invalid quantity for product ${productId}`);
      }

      const product = await fetchValidatedProduct(client, productId);

      let priceAtPurchase = rawItem.unit_price ?? rawItem.price_at_purchase ?? null;
      if (priceAtPurchase === null || priceAtPurchase === undefined || priceAtPurchase === '') {
        priceAtPurchase = product.retail_price;
      }
      priceAtPurchase = toNumber(priceAtPurchase, NaN);

      if (!Number.isFinite(priceAtPurchase) || priceAtPurchase < 0) {
        throw new Error(`Invalid price for product ${productId}`);
      }

      const lineTotal = roundMoney(quantity * priceAtPurchase);
      computedTotalAmount += lineTotal;

      preparedItems.push({
        product_id: productId,
        quantity,
        price_at_purchase: roundMoney(priceAtPurchase),
        line_total: lineTotal,
        product_name: product.name,
      });
    }

    computedTotalAmount = roundMoney(computedTotalAmount);
    const orderNum = generateOrderNumber();

    const orderResult = await client.query(
      `
      INSERT INTO orders
      (
        order_number,
        order_type,
        customer_id,
        customer_name,
        customer_phone,
        customer_email,
        delivery_address,
        total_amount,
        amount_paid,
        notes,
        payment_status,
        payment_state,
        is_printed
      )
      VALUES ($1, 'normal', $2, $3, $4, $5, $6, $7, 0, $8, 'pending', 'unpaid', FALSE)
      RETURNING *
      `,
      [
        orderNum,
        customerId,
        normalizedName,
        normalizedPhone,
        normalizedEmail,
        normalizedAddress,
        computedTotalAmount,
        normalizedNotes,
      ]
    );

    const orderId = orderResult.rows[0].id;

    for (const item of preparedItems) {
      await client.query(
        `
        INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, line_total)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [orderId, item.product_id, item.quantity, item.price_at_purchase, item.line_total]
      );
    }

    await client.query('COMMIT');

    const createdOrder = enrichOrder(orderResult.rows[0]);
    createdOrder.items = preparedItems.map((item) => ({
      ...item,
      unit_price: item.price_at_purchase,
      total_price: item.line_total,
    }));

    return handleSuccess(res, 201, 'Order placed successfully', createdOrder);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('guestCheckout error:', err.message);
    return handleError(res, 500, 'Failed to place order', err);
  } finally {
    client.release();
  }
};

// CREATE ORDER
const createOrder = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      order_type,
      customer_id,
      customer_name,
      customer_phone,
      sales_rep_id,
      total_amount,
      notes,
      items,
      amount_paid,
      due_date,
    } = req.body;

    const normalizedOrderType = String(order_type || '').trim().toLowerCase();

    if (!VALID_ORDER_TYPES.has(normalizedOrderType)) {
      return handleError(res, 400, 'order_type must be either normal or route');
    }

    const normalizedCustomerName = normalizeText(customer_name);
    const normalizedCustomerPhone = normalizeText(customer_phone);
    const normalizedNotes = normalizeText(notes);
    const normalizedDueDate = due_date && due_date !== '' ? due_date : null;

    if (!normalizedCustomerName || !normalizedCustomerPhone) {
      return handleError(res, 400, 'customer_name and customer_phone are required');
    }

    if (!Array.isArray(items) || items.length === 0) {
      return handleError(res, 400, 'At least one order item is required');
    }

    if (normalizedOrderType === 'route' && !sales_rep_id) {
      return handleError(res, 400, 'sales_rep_id is required for route orders');
    }

    const submittedAmountPaid =
      amount_paid === undefined || amount_paid === null || amount_paid === ''
        ? 0
        : toNumber(amount_paid, NaN);

    if (!Number.isFinite(submittedAmountPaid) || submittedAmountPaid < 0) {
      return handleError(res, 400, 'amount_paid must be a valid non-negative number');
    }

    if (customer_id) {
      const customerCheck = await client.query(
        'SELECT id FROM customers WHERE id = $1',
        [customer_id]
      );

      if (customerCheck.rows.length === 0) {
        return handleError(res, 400, 'Customer does not exist');
      }
    }

    if (sales_rep_id) {
      const repCheck = await client.query(
        'SELECT id FROM sales_reps WHERE id = $1',
        [sales_rep_id]
      );

      if (repCheck.rows.length === 0) {
        return handleError(res, 400, 'Sales rep does not exist');
      }
    }

    await client.query('BEGIN');

    const preparedItems = [];
    let computedTotalAmount = 0;

    for (const rawItem of items) {
      const productId = Number(rawItem.product_id);
      const quantity = Number(rawItem.quantity || 0);

      if (!Number.isInteger(productId) || productId <= 0) {
        throw new Error('Invalid product_id in order items');
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(`Invalid quantity for product ${productId}`);
      }

      const product = await fetchValidatedProduct(client, productId);

      let priceAtPurchase = rawItem.unit_price ?? rawItem.price_at_purchase ?? null;
      if (priceAtPurchase === null || priceAtPurchase === undefined || priceAtPurchase === '') {
        priceAtPurchase = product.retail_price;
      }

      priceAtPurchase = toNumber(priceAtPurchase, NaN);

      if (!Number.isFinite(priceAtPurchase) || priceAtPurchase < 0) {
        throw new Error(`Invalid price for product ${productId}`);
      }

      if ((product.retail_price === null || product.retail_price === undefined) && priceAtPurchase === null) {
        throw new Error(`No valid price available for product ${productId}`);
      }

      const lineTotal = roundMoney(quantity * priceAtPurchase);
      computedTotalAmount += lineTotal;

      preparedItems.push({
        product_id: productId,
        quantity,
        price_at_purchase: roundMoney(priceAtPurchase),
        line_total: lineTotal,
        product_name: product.name,
      });
    }

    computedTotalAmount = roundMoney(computedTotalAmount);

    const submittedTotalAmount = toNumber(total_amount, computedTotalAmount);
    if (!Number.isFinite(submittedTotalAmount) || submittedTotalAmount < 0) {
      throw new Error('total_amount must be a valid non-negative number');
    }

    const finalTotalAmount = computedTotalAmount;

    const initialPaymentStatus =
      normalizedOrderType === 'normal' &&
      submittedAmountPaid >= finalTotalAmount &&
      finalTotalAmount > 0
        ? 'completed'
        : 'pending';

    const initialPaymentState =
      normalizedOrderType === 'route'
        ? deriveRoutePaymentState(finalTotalAmount, submittedAmountPaid, normalizedDueDate)
        : 'unpaid';

    const initialLastPaymentDate =
      submittedAmountPaid > 0 ? new Date().toISOString() : null;

    const orderNum = generateOrderNumber();

    const orderResult = await client.query(
      `
      INSERT INTO orders
      (
        order_number,
        order_type,
        customer_id,
        customer_name,
        customer_phone,
        sales_rep_id,
        total_amount,
        amount_paid,
        due_date,
        last_payment_date,
        notes,
        payment_status,
        payment_state,
        is_printed
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, FALSE)
      RETURNING *
      `,
      [
        orderNum,
        normalizedOrderType,
        customer_id || null,
        normalizedCustomerName,
        normalizedCustomerPhone,
        sales_rep_id || null,
        finalTotalAmount,
        roundMoney(submittedAmountPaid),
        normalizedDueDate,
        initialLastPaymentDate,
        normalizedNotes,
        initialPaymentStatus,
        initialPaymentState,
      ]
    );

    const orderId = orderResult.rows[0].id;

    for (const item of preparedItems) {
      await client.query(
        `
        INSERT INTO order_items
        (
          order_id,
          product_id,
          quantity,
          price_at_purchase,
          line_total
        )
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
          orderId,
          item.product_id,
          item.quantity,
          item.price_at_purchase,
          item.line_total,
        ]
      );
    }

    await client.query('COMMIT');

    const createdOrder = enrichOrder(orderResult.rows[0]);
    createdOrder.items = preparedItems.map((item) => ({
      ...item,
      unit_price: item.price_at_purchase,
      total_price: item.line_total,
    }));

    return handleSuccess(res, 201, 'Order created successfully', createdOrder);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('createOrder error:', err.message);
    return handleError(res, 500, 'Failed to create order', err);
  } finally {
    client.release();
  }
};

// UPDATE ORDER STATUS / SETTLEMENT
const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      order_status,
      payment_status,
      amount_paid,
      due_date,
      notes,
    } = req.body;

    const currentResult = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      `,
      [id]
    );

    if (currentResult.rows.length === 0) {
      return handleError(res, 404, 'Order not found');
    }

    const current = currentResult.rows[0];
    const totalAmount = toNumber(current.total_amount, 0);
    const currentAmountPaid = toNumber(current.amount_paid, 0);

    let nextAmountPaid = currentAmountPaid;
    if (amount_paid !== undefined && amount_paid !== null && amount_paid !== '') {
      const parsedAmountPaid = toNumber(amount_paid, NaN);
      if (!Number.isFinite(parsedAmountPaid) || parsedAmountPaid < 0) {
        return handleError(res, 400, 'amount_paid must be a valid non-negative number');
      }
      nextAmountPaid = parsedAmountPaid;
    }

    let nextDueDate = current.due_date;
    if (due_date !== undefined) {
      nextDueDate = due_date === '' ? null : due_date;
    }

    let nextPaymentStatus = payment_status || current.payment_status || 'pending';

    if (current.order_type === 'normal') {
      if (nextPaymentStatus === 'completed' && amount_paid === undefined) {
        nextAmountPaid = totalAmount;
      }

      if (nextAmountPaid >= totalAmount && totalAmount > 0) {
        nextPaymentStatus = 'completed';
      } else if (nextPaymentStatus === 'completed' && nextAmountPaid < totalAmount) {
        nextPaymentStatus = 'pending';
      }
    }

    const nextPaymentState =
      current.order_type === 'route'
        ? deriveRoutePaymentState(totalAmount, nextAmountPaid, nextDueDate)
        : current.payment_state || 'unpaid';

    const nextLastPaymentDate =
      nextAmountPaid > currentAmountPaid
        ? new Date().toISOString()
        : current.last_payment_date;

    const result = await pool.query(
      `
      UPDATE orders
      SET order_status = COALESCE($1, order_status),
          payment_status = $2,
          payment_state = $3,
          amount_paid = $4,
          due_date = $5,
          last_payment_date = $6,
          notes = COALESCE($7, notes),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
      `,
      [
        order_status || null,
        nextPaymentStatus,
        nextPaymentState,
        roundMoney(nextAmountPaid),
        nextDueDate,
        nextLastPaymentDate,
        notes ? notes.trim() : null,
        id,
      ]
    );

    return handleSuccess(res, 200, 'Order updated successfully', enrichOrder(result.rows[0]));
  } catch (err) {
    console.error('updateOrderStatus error:', err.message);
    return handleError(res, 500, 'Failed to update order', err);
  }
};

// GET ORDERS BY SALES REP
const getOrdersBySalesRep = async (req, res) => {
  try {
    const { sales_rep_id } = req.params;

    const result = await pool.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.total_amount,
        COALESCE(o.amount_paid, 0) AS amount_paid,
        o.due_date,
        o.last_payment_date,
        o.order_status,
        o.payment_status,
        o.payment_state,
        o.is_printed,
        o.printed_at,
        o.created_at,
        o.customer_name,
        o.order_type,
        l.name AS location_name,
        r.name AS region_name,
        COUNT(DISTINCT oi.id) AS item_count
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.sales_rep_id = $1
      GROUP BY o.id, l.id, r.id
      ORDER BY o.created_at DESC
      `,
      [sales_rep_id]
    );

    return handleSuccess(
      res,
      200,
      'Orders retrieved successfully',
      result.rows.map(enrichOrder)
    );
  } catch (err) {
    console.error('getOrdersBySalesRep error:', err.message);
    return handleError(res, 500, 'Failed to retrieve orders', err);
  }
};

// GET ORDER FOR PRINT AND MARK AS PRINTED
const getOrderForPrint = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const format = String(req.query.format || '').trim().toLowerCase();

    await client.query('BEGIN');

    const orderResult = await client.query(
      `
      SELECT
        o.*,
        COALESCE(o.amount_paid, 0) AS amount_paid,
        sr.name AS sales_rep_name,
        sr.phone_number AS sales_rep_phone,
        l.name AS location_name,
        r.name AS region_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      LEFT JOIN sales_reps sr ON o.sales_rep_id = sr.id
      WHERE o.id = $1
      `,
      [id]
    );

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Order not found');
    }

    const itemsResult = await client.query(
      `
      SELECT
        oi.id,
        oi.order_id,
        oi.product_id,
        oi.quantity,
        oi.price_at_purchase,
        COALESCE(oi.line_total, oi.quantity * oi.price_at_purchase) AS line_total,
        oi.price_source,
        oi.pricing_locked_at,
        oi.created_at,
        p.name AS product_name,
        p.sku,
        oi.price_at_purchase AS unit_price,
        COALESCE(oi.line_total, oi.quantity * oi.price_at_purchase) AS total_price
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
      ORDER BY oi.id ASC
      `,
      [id]
    );

    const printUpdate = await client.query(
      `
      UPDATE orders
      SET is_printed = TRUE,
          printed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING is_printed, printed_at
      `,
      [id]
    );

    await client.query('COMMIT');

    const mergedOrder = {
      ...orderResult.rows[0],
      is_printed: printUpdate.rows[0]?.is_printed ?? true,
      printed_at: printUpdate.rows[0]?.printed_at ?? new Date().toISOString(),
    };

    const order = enrichOrder(mergedOrder);
    const items = itemsResult.rows.map((item) => ({
      ...item,
      price_at_purchase: roundMoney(item.price_at_purchase),
      line_total: roundMoney(item.line_total),
      unit_price: roundMoney(item.unit_price),
      total_price: roundMoney(item.total_price),
    }));

    const totalQuantity = items.reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0
    );

    const settlementText =
      order.order_type === 'route'
        ? (order.payment_state || 'unpaid').toUpperCase()
        : (order.payment_status || 'pending').toUpperCase();

    const itemsHtml = items.length
      ? items
          .map((item, index) => {
            const productName = escapeHtml(item.product_name || 'Unnamed Product');
            const qty = Number(item.quantity || 0);
            const unitPrice = Number(item.unit_price || 0);
            const lineTotal = Number(item.total_price || 0);

            return `
              <div class="item-block">
                <div class="item-title-row">
                  <div class="item-index">${index + 1}.</div>
                  <div class="item-title">${productName}</div>
                </div>

                <div class="item-meta-row">
                  <div class="item-meta-left">Qty: ${qty}</div>
                  <div class="item-meta-center">Unit: KES ${unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                  <div class="item-meta-right">KES ${lineTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                </div>

                ${item.sku ? `<div class="item-sku">SKU: ${escapeHtml(item.sku)}</div>` : ''}
              </div>
            `;
          })
          .join('')
      : `
        <div class="empty-items">
          No product lines were found for this order.
        </div>
      `;

    const receiptHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8" />
        <title>Order Sheet ${escapeHtml(order.order_number)}</title>
        <style>
          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }

          body {
            width: 80mm;
            font-family: Arial, Helvetica, sans-serif;
            font-size: 10px;
            color: #000;
            background: #fff;
            padding: 4mm;
          }

          .sheet {
            width: 100%;
          }

          .center {
            text-align: center;
          }

          .title {
            font-size: 14px;
            font-weight: 800;
            margin-bottom: 4px;
            letter-spacing: 0.4px;
          }

          .sub {
            font-size: 10px;
            margin-bottom: 8px;
          }

          .line {
            border-top: 1px dashed #000;
            margin: 6px 0;
          }

          .section-title {
            font-size: 10px;
            font-weight: 800;
            margin-bottom: 4px;
            text-transform: uppercase;
          }

          .meta-row {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 2px;
            font-size: 10px;
          }

          .meta-label {
            font-weight: 700;
            min-width: 22mm;
          }

          .meta-value {
            flex: 1;
            text-align: right;
            word-break: break-word;
          }

          .items-section {
            margin-top: 4px;
          }

          .items-header {
            display: flex;
            justify-content: space-between;
            font-size: 9px;
            font-weight: 800;
            border-top: 1px solid #000;
            border-bottom: 1px solid #000;
            padding: 4px 0;
            margin-bottom: 4px;
          }

          .item-block {
            padding: 4px 0;
            border-bottom: 1px dotted #999;
          }

          .item-title-row {
            display: flex;
            gap: 4px;
            align-items: flex-start;
            margin-bottom: 2px;
          }

          .item-index {
            width: 6mm;
            font-weight: 700;
            font-size: 10px;
          }

          .item-title {
            flex: 1;
            font-size: 10px;
            font-weight: 700;
            line-height: 1.25;
            word-break: break-word;
          }

          .item-meta-row {
            display: flex;
            justify-content: space-between;
            gap: 4px;
            font-size: 9px;
            line-height: 1.25;
          }

          .item-meta-left {
            width: 16mm;
          }

          .item-meta-center {
            flex: 1;
            text-align: center;
          }

          .item-meta-right {
            width: 20mm;
            text-align: right;
            font-weight: 700;
          }

          .item-sku {
            margin-top: 2px;
            font-size: 8px;
            color: #555;
          }

          .empty-items {
            padding: 8px 0;
            font-size: 10px;
            text-align: center;
            border-bottom: 1px dotted #999;
          }

          .totals {
            margin-top: 8px;
          }

          .total-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 3px;
            font-size: 10px;
          }

          .grand-total {
            font-size: 13px;
            font-weight: 800;
            border-top: 1px solid #000;
            padding-top: 5px;
            margin-top: 5px;
          }

          .note {
            margin-top: 6px;
            font-size: 9px;
            line-height: 1.35;
          }

          .footer {
            margin-top: 10px;
            text-align: center;
            font-size: 9px;
          }

          @media print {
            body {
              width: 80mm;
            }
          }
        </style>
      </head>
      <body>
        <div class="sheet">
          <div class="center">
            <div class="title">XPOSE DISTRIBUTORS</div>
            <div class="sub">ORDER RECEIPT</div>
          </div>

          <div class="line"></div>

          <div class="section-title">Order Info</div>
          <div class="meta-row">
            <div class="meta-label">Order No</div>
            <div class="meta-value">${escapeHtml(order.order_number)}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Date</div>
            <div class="meta-value">${new Date(order.created_at).toLocaleString('en-US', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Printed</div>
            <div class="meta-value">${order.printed_at ? new Date(order.printed_at).toLocaleString('en-US', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            }) : '-'}</div>
          </div>

          <div class="line"></div>

          <div class="section-title">Sales Rep</div>
          <div class="meta-row">
            <div class="meta-label">Name</div>
            <div class="meta-value">${escapeHtml(order.sales_rep_name || 'Unassigned')}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Phone</div>
            <div class="meta-value">${escapeHtml(order.sales_rep_phone || '-')}</div>
          </div>

          <div class="line"></div>

          <div class="section-title">Customer</div>
          <div class="meta-row">
            <div class="meta-label">Name</div>
            <div class="meta-value">${escapeHtml(order.customer_name)}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Phone</div>
            <div class="meta-value">${escapeHtml(order.customer_phone)}</div>
          </div>
          ${order.customer_email ? `
          <div class="meta-row">
            <div class="meta-label">Email</div>
            <div class="meta-value">${escapeHtml(order.customer_email)}</div>
          </div>` : ''}
          ${order.delivery_address ? `
          <div class="meta-row">
            <div class="meta-label">Address</div>
            <div class="meta-value">${escapeHtml(order.delivery_address)}</div>
          </div>` : `
          <div class="meta-row">
            <div class="meta-label">Location</div>
            <div class="meta-value">${escapeHtml(order.location_name || '-')}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Region</div>
            <div class="meta-value">${escapeHtml(order.region_name || '-')}</div>
          </div>`}
          <div class="meta-row">
            <div class="meta-label">Settlement</div>
            <div class="meta-value">${escapeHtml(settlementText)}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Paid</div>
            <div class="meta-value">KES ${Number(order.amount_paid || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Balance</div>
            <div class="meta-value">KES ${Number(order.balance_due || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Due Date</div>
            <div class="meta-value">${escapeHtml(order.due_date || '-')}</div>
          </div>

          <div class="line"></div>

          <div class="section-title">Products</div>
          <div class="items-section">
            <div class="items-header">
              <span>Product Details</span>
              <span>Line Total</span>
            </div>
            ${itemsHtml}
          </div>

          <div class="totals">
            <div class="total-row">
              <span>Total Product Lines</span>
              <span>${items.length}</span>
            </div>
            <div class="total-row">
              <span>Total Quantity</span>
              <span>${totalQuantity}</span>
            </div>
            <div class="total-row grand-total">
              <span>Total Amount</span>
              <span>KES ${Number(order.total_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
            </div>
          </div>

          ${
            order.notes
              ? `
            <div class="line"></div>
            <div class="section-title">Notes</div>
            <div class="note">${escapeHtml(order.notes)}</div>
          `
              : ''
          }

          <div class="line"></div>

          <div class="footer">
            <div>Thank you for shopping with us!</div>
            <div>XPOSE DISTRIBUTORS</div>
            <div>${new Date().toLocaleString('en-US', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}</div>
          </div>
        </div>

        <script>
          window.print();
        </script>
      </body>
      </html>
    `;

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(receiptHtml);
    }

    return handleSuccess(res, 200, 'Order print sheet retrieved successfully', {
      html: receiptHtml,
      order,
      items,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('getOrderForPrint error:', err.message);
    return handleError(res, 500, 'Failed to generate order print sheet', err);
  } finally {
    client.release();
  }
};

// GET ORDER STATISTICS
const getOrderStatistics = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let query = `
      SELECT
        COUNT(*) AS total_orders,
        COUNT(CASE WHEN order_status = 'completed' THEN 1 END) AS completed_orders,
        COUNT(CASE WHEN order_status = 'pending' THEN 1 END) AS pending_orders,
        COUNT(CASE WHEN payment_status = 'completed' THEN 1 END) AS paid_orders,
        COUNT(CASE WHEN COALESCE(is_printed, FALSE) = TRUE THEN 1 END) AS printed_orders,
        COUNT(CASE WHEN COALESCE(is_printed, FALSE) = FALSE THEN 1 END) AS not_printed_orders,
        COUNT(
          CASE
            WHEN order_type = 'route'
             AND GREATEST(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0) > 0
            THEN 1
          END
        ) AS route_credit_open,
        COUNT(
          CASE
            WHEN order_type = 'route'
             AND GREATEST(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0) > 0
             AND due_date IS NOT NULL
             AND due_date < CURRENT_DATE
            THEN 1
          END
        ) AS overdue_route_orders,
        COALESCE(SUM(total_amount), 0) AS total_revenue,
        COALESCE(SUM(COALESCE(amount_paid, 0)), 0) AS total_paid_amount,
        COALESCE(SUM(GREATEST(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0)), 0) AS total_outstanding_balance,
        AVG(total_amount) AS avg_order_value,
        COUNT(DISTINCT customer_id) AS unique_customers
      FROM orders
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (start_date) {
      params.push(start_date);
      query += ` AND created_at >= $${paramIndex}`;
      paramIndex++;
    }

    if (end_date) {
      params.push(end_date);
      query += ` AND created_at <= $${paramIndex}`;
      paramIndex++;
    }

    const result = await pool.query(query, params);

    return handleSuccess(res, 200, 'Statistics retrieved successfully', result.rows[0]);
  } catch (err) {
    console.error('getOrderStatistics error:', err.message);
    return handleError(res, 500, 'Failed to retrieve statistics', err);
  }
};

const trackPublicOrder = async (req, res) => {
  try {
    const orderNumber = String(req.query.order_number || '').trim();
    const phoneDigits = String(req.query.customer_phone || '').replace(/\D/g, '');

    if (!orderNumber || !phoneDigits) {
      return handleError(res, 400, 'order_number and customer_phone are required');
    }

    const orderResult = await pool.query(
      `
      SELECT
        o.*,
        COALESCE(o.amount_paid, 0) AS amount_paid,
        COUNT(DISTINCT oi.id) AS item_count,
        COALESCE(SUM(oi.quantity), 0) AS total_items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_number = $1
        AND regexp_replace(COALESCE(o.customer_phone, ''), '\D', '', 'g') = $2
      GROUP BY o.id
      ORDER BY o.id DESC
      LIMIT 1
      `,
      [orderNumber, phoneDigits]
    );

    if (orderResult.rows.length === 0) {
      return handleError(res, 404, 'Order not found for the provided details');
    }

    const order = enrichOrder(orderResult.rows[0]);

    const itemsResult = await pool.query(
      `
      SELECT
        oi.product_id,
        oi.quantity,
        oi.price_at_purchase,
        COALESCE(oi.line_total, oi.quantity * oi.price_at_purchase) AS line_total,
        p.name AS product_name,
        p.sku
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id ASC
      `,
      [order.id]
    );

    order.items = itemsResult.rows.map((item) => ({
      ...item,
      price_at_purchase: roundMoney(item.price_at_purchase),
      line_total: roundMoney(item.line_total),
      unit_price: roundMoney(item.price_at_purchase),
      total_price: roundMoney(item.line_total),
    }));

    return handleSuccess(res, 200, 'Order tracking retrieved successfully', order);
  } catch (err) {
    console.error('trackPublicOrder error:', err.message);
    return handleError(res, 500, 'Failed to track order', err);
  }
};

module.exports = {
  getAllOrders,
  getOrderById,
  guestCheckout,
  createOrder,
  updateOrderStatus,
  getOrdersBySalesRep,
  getOrderForPrint,
  getOrderStatistics,
  trackPublicOrder,
};