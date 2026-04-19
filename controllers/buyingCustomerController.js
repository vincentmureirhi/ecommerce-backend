'use strict';

const pool = require('../config/database');

const getBuyingCustomers = async (req, res) => {
  try {
    const { search } = req.query;

    let query = `
      SELECT
        c.id,
        c.name,
        c.email,
        c.phone,
        c.address,
        c.is_active,
        c.created_at,
        COUNT(DISTINCT o.id) AS orders_count,
        COALESCE(SUM(o.total_amount), 0)::numeric(12,2) AS total_spent,
        COALESCE(SUM(COALESCE(o.amount_paid, 0)), 0)::numeric(12,2) AS total_paid,
        COALESCE(
          SUM(GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)),
          0
        )::numeric(12,2) AS outstanding_balance,
        MAX(o.created_at) AS last_order_date,
        MAX(o.last_payment_date) AS last_payment_date,
        COUNT(CASE WHEN COALESCE(o.payment_status, 'pending') = 'completed' THEN 1 END) AS paid_orders,
        COUNT(CASE WHEN COALESCE(o.payment_status, 'pending') = 'pending' THEN 1 END) AS pending_payment_orders,
        COUNT(
          CASE
            WHEN GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0) > 0
            THEN 1
          END
        ) AS open_balance_orders
      FROM customers c
      LEFT JOIN orders o
        ON o.customer_id = c.id
       AND o.order_type = 'normal'
      WHERE c.customer_type = 'normal'
    `;

    const params = [];
    let paramIndex = 1;

    if (search) {
      params.push(`%${search}%`);
      query += `
        AND (
          c.name ILIKE $${paramIndex}
          OR COALESCE(c.email, '') ILIKE $${paramIndex}
          OR COALESCE(c.phone, '') ILIKE $${paramIndex}
        )
      `;
      paramIndex++;
    }

    query += `
      GROUP BY c.id
      ORDER BY COALESCE(MAX(o.created_at), c.created_at) DESC, c.created_at DESC
    `;

    const result = await pool.query(query, params);

    return res.json({
      success: true,
      data: result.rows,
      message: 'Buying customers retrieved successfully',
    });
  } catch (err) {
    console.error('❌ Error loading buying customers:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to get buying customers',
      error: err.message,
    });
  }
};

const getBuyingCustomerById = async (req, res) => {
  try {
    const { id } = req.params;

    const customerResult = await pool.query(
      `
      SELECT
        c.id,
        c.name,
        c.email,
        c.phone,
        c.address,
        c.is_active,
        c.created_at,
        COUNT(DISTINCT o.id) AS orders_count,
        COALESCE(SUM(o.total_amount), 0)::numeric(12,2) AS total_spent,
        COALESCE(SUM(COALESCE(o.amount_paid, 0)), 0)::numeric(12,2) AS total_paid,
        COALESCE(
          SUM(GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)),
          0
        )::numeric(12,2) AS outstanding_balance,
        MAX(o.created_at) AS last_order_date
      FROM customers c
      LEFT JOIN orders o
        ON o.customer_id = c.id
       AND o.order_type = 'normal'
      WHERE c.id = $1
        AND c.customer_type = 'normal'
      GROUP BY c.id
      `,
      [id]
    );

    if (customerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Buying customer not found',
      });
    }

    return res.json({
      success: true,
      data: customerResult.rows[0],
      message: 'Buying customer retrieved successfully',
    });
  } catch (err) {
    console.error('❌ Error loading buying customer:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to get buying customer',
      error: err.message,
    });
  }
};

const getBuyingCustomerOrders = async (req, res) => {
  try {
    const { id } = req.params;

    const customerCheck = await pool.query(
      `SELECT id, name FROM customers WHERE id = $1 AND customer_type = 'normal'`,
      [id]
    );

    if (customerCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Buying customer not found',
      });
    }

    const ordersResult = await pool.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.order_status,
        o.payment_status,
        o.total_amount,
        COALESCE(o.amount_paid, 0) AS amount_paid,
        GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0) AS balance_due,
        o.notes,
        o.customer_name,
        o.customer_phone,
        o.customer_email,
        o.delivery_address,
        o.is_printed,
        o.printed_at,
        o.created_at,
        o.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id', oi.id,
              'product_id', oi.product_id,
              'product_name', p.name,
              'sku', p.sku,
              'quantity', oi.quantity,
              'unit_price', oi.price_at_purchase,
              'line_total', COALESCE(oi.line_total, oi.quantity * oi.price_at_purchase)
            )
            ORDER BY oi.id ASC
          ) FILTER (WHERE oi.id IS NOT NULL),
          '[]'
        ) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE o.customer_id = $1
        AND o.order_type = 'normal'
      GROUP BY o.id
      ORDER BY o.created_at DESC
      `,
      [id]
    );

    return res.json({
      success: true,
      data: ordersResult.rows,
      message: 'Buying customer orders retrieved successfully',
    });
  } catch (err) {
    console.error('❌ Error loading buying customer orders:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to get buying customer orders',
      error: err.message,
    });
  }
};

module.exports = {
  getBuyingCustomers,
  getBuyingCustomerById,
  getBuyingCustomerOrders,
};