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

module.exports = {
  getBuyingCustomers,
};