'use strict';

const pool = require('../config/database');

async function fetchCustomerById(id) {
  const result = await pool.query(
    `
    SELECT
      c.*,
      CASE
        WHEN COALESCE(c.is_active, TRUE) = TRUE THEN 'active'
        ELSE 'inactive'
      END AS status,
      l.name AS location_name,
      r.name AS region_name,
      sr.name AS sales_rep_name,
      sr.phone_number AS sales_rep_phone
    FROM customers c
    LEFT JOIN locations l ON c.location_id = l.id
    LEFT JOIN regions r ON l.region_id = r.id
    LEFT JOIN sales_reps sr ON c.sales_rep_id = sr.id
    WHERE c.id = $1
    `,
    [id]
  );

  return result.rows[0] || null;
}

const getAllCustomers = async (req, res) => {
  try {
    const {
      search,
      customer_type,
      status,
      location_id,
      sales_rep_id,
      region_id,
    } = req.query;

    let query = `
      SELECT
        c.*,
        CASE
          WHEN COALESCE(c.is_active, TRUE) = TRUE THEN 'active'
          ELSE 'inactive'
        END AS status,
        l.name AS location_name,
        r.name AS region_name,
        sr.name AS sales_rep_name,
        COUNT(DISTINCT o.id) AS orders_count,
        COALESCE(SUM(o.total_amount), 0)::numeric(12,2) AS total_spent,
        COALESCE(SUM(COALESCE(o.amount_paid, 0)), 0)::numeric(12,2) AS total_paid,
        COALESCE(
          SUM(GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)),
          0
        )::numeric(12,2) AS outstanding_balance,
        MAX(o.created_at) AS last_order_date
      FROM customers c
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      LEFT JOIN sales_reps sr ON c.sales_rep_id = sr.id
      LEFT JOIN orders o ON o.customer_id = c.id
      WHERE 1=1
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

    if (customer_type) {
      params.push(customer_type);
      query += ` AND c.customer_type = $${paramIndex}`;
      paramIndex++;
    }

    if (status) {
      if (status === 'active') {
        query += ` AND COALESCE(c.is_active, TRUE) = TRUE`;
      } else if (status === 'inactive') {
        query += ` AND COALESCE(c.is_active, TRUE) = FALSE`;
      }
    }

    if (location_id) {
      params.push(location_id);
      query += ` AND c.location_id = $${paramIndex}`;
      paramIndex++;
    }

    if (sales_rep_id) {
      params.push(sales_rep_id);
      query += ` AND c.sales_rep_id = $${paramIndex}`;
      paramIndex++;
    }

    if (region_id) {
      params.push(region_id);
      query += ` AND l.region_id = $${paramIndex}`;
      paramIndex++;
    }

    query += `
      GROUP BY c.id, l.id, r.id, sr.id
      ORDER BY c.created_at DESC
    `;

    const result = await pool.query(query, params);

    return res.json({
      success: true,
      data: result.rows,
      message: 'Customers retrieved successfully',
    });
  } catch (err) {
    console.error('❌ getAllCustomers error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to get customers',
      error: err.message,
    });
  }
};

const getCustomerById = async (req, res) => {
  try {
    const { id } = req.params;
    const customer = await fetchCustomerById(id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    return res.json({
      success: true,
      data: customer,
      message: 'Customer retrieved successfully',
    });
  } catch (err) {
    console.error('❌ getCustomerById error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to get customer',
      error: err.message,
    });
  }
};

const createCustomer = async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      customer_type,
      location_id,
      sales_rep_id,
      is_active,
    } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Customer name is required',
      });
    }

    const result = await pool.query(
      `
      INSERT INTO customers
      (
        name,
        email,
        phone,
        customer_type,
        location_id,
        sales_rep_id,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
      `,
      [
        String(name).trim(),
        email ? String(email).trim() : null,
        phone ? String(phone).trim() : null,
        customer_type ? String(customer_type).trim() : 'normal',
        location_id || null,
        sales_rep_id || null,
        is_active === undefined ? true : Boolean(is_active),
      ]
    );

    const customer = await fetchCustomerById(result.rows[0].id);

    return res.status(201).json({
      success: true,
      data: customer,
      message: 'Customer created successfully',
    });
  } catch (err) {
    console.error('❌ createCustomer error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to create customer',
      error: err.message,
    });
  }
};

const updateCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      email,
      phone,
      customer_type,
      location_id,
      sales_rep_id,
      is_active,
    } = req.body;

    const exists = await fetchCustomerById(id);
    if (!exists) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    await pool.query(
      `
      UPDATE customers
      SET
        name = COALESCE($1, name),
        email = $2,
        phone = $3,
        customer_type = COALESCE($4, customer_type),
        location_id = $5,
        sales_rep_id = $6,
        is_active = COALESCE($7, is_active),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      `,
      [
        name ? String(name).trim() : null,
        email === undefined ? exists.email : (email ? String(email).trim() : null),
        phone === undefined ? exists.phone : (phone ? String(phone).trim() : null),
        customer_type ? String(customer_type).trim() : null,
        location_id === undefined ? exists.location_id : (location_id || null),
        sales_rep_id === undefined ? exists.sales_rep_id : (sales_rep_id || null),
        is_active === undefined ? null : Boolean(is_active),
        id,
      ]
    );

    const customer = await fetchCustomerById(id);

    return res.json({
      success: true,
      data: customer,
      message: 'Customer updated successfully',
    });
  } catch (err) {
    console.error('❌ updateCustomer error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to update customer',
      error: err.message,
    });
  }
};

const deleteCustomer = async (req, res) => {
  try {
    const { id } = req.params;

    const customer = await fetchCustomerById(id);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    const orderCheck = await pool.query(
      `
      SELECT COUNT(*)::int AS order_count
      FROM orders
      WHERE customer_id = $1
      `,
      [id]
    );

    if (orderCheck.rows[0].order_count > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete customer with existing orders',
      });
    }

    await pool.query(`DELETE FROM customers WHERE id = $1`, [id]);

    return res.json({
      success: true,
      message: 'Customer deleted successfully',
    });
  } catch (err) {
    console.error('❌ deleteCustomer error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete customer',
      error: err.message,
    });
  }
};

const getCustomerSummary = async (req, res) => {
  try {
    const { id } = req.params;

    const customerResult = await pool.query(
      `
      SELECT
        c.*,
        CASE
          WHEN COALESCE(c.is_active, TRUE) = TRUE THEN 'active'
          ELSE 'inactive'
        END AS status,
        l.name AS location_name,
        r.name AS region_name,
        sr.name AS sales_rep_name
      FROM customers c
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      LEFT JOIN sales_reps sr ON c.sales_rep_id = sr.id
      WHERE c.id = $1
      `,
      [id]
    );

    if (customerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    const summaryResult = await pool.query(
      `
      WITH order_agg AS (
        SELECT
          COUNT(*) AS total_orders,
          COALESCE(SUM(o.total_amount), 0)::numeric(12,2) AS total_spent,
          COALESCE(SUM(COALESCE(o.amount_paid, 0)), 0)::numeric(12,2) AS total_paid,
          COALESCE(
            SUM(GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)),
            0
          )::numeric(12,2) AS outstanding_balance,
          COUNT(CASE WHEN o.order_status = 'completed' THEN 1 END) AS completed_orders,
          COUNT(CASE WHEN o.order_status = 'pending' THEN 1 END) AS pending_orders,
          MAX(o.created_at) AS last_order_date
        FROM orders o
        WHERE o.customer_id = $1
      ),
      payment_agg AS (
        SELECT
          COUNT(*) AS total_payments,
          COUNT(CASE WHEN p.status IN ('completed', 'manually_resolved') THEN 1 END) AS successful_payments,
          COUNT(CASE WHEN p.status IN ('failed', 'cancelled', 'timeout') THEN 1 END) AS failed_payments,
          MAX(p.created_at) FILTER (
            WHERE p.status IN ('completed', 'manually_resolved')
          ) AS last_payment_date
        FROM payments p
        INNER JOIN orders o ON p.order_id = o.id
        WHERE o.customer_id = $1
      )
      SELECT *
      FROM order_agg, payment_agg
      `,
      [id]
    );

    return res.json({
      success: true,
      data: {
        customer: customerResult.rows[0],
        summary: summaryResult.rows[0],
      },
      message: 'Customer summary retrieved successfully',
    });
  } catch (err) {
    console.error('❌ getCustomerSummary error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to get customer summary',
      error: err.message,
    });
  }
};

const getCustomerOrders = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.order_type,
        o.total_amount,
        COALESCE(o.amount_paid, 0)::numeric(12,2) AS amount_paid,
        GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)::numeric(12,2) AS balance_due,
        o.order_status,
        o.payment_status,
        o.payment_state,
        o.is_printed,
        o.printed_at,
        o.due_date,
        o.created_at,
        sr.name AS sales_rep_name,
        COUNT(DISTINCT oi.id) AS item_count,
        COALESCE(SUM(oi.quantity), 0) AS total_items,
        CASE
          WHEN o.order_type = 'route' THEN
            CASE
              WHEN GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0) = 0
                   AND COALESCE(o.total_amount, 0) > 0 THEN 'paid'
              WHEN GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0) > 0
                   AND o.due_date IS NOT NULL
                   AND o.due_date < CURRENT_DATE THEN 'overdue'
              WHEN COALESCE(o.amount_paid, 0) > 0 THEN 'partial'
              ELSE 'unpaid'
            END
          ELSE COALESCE(o.payment_status, 'pending')
        END AS settlement_label
      FROM orders o
      LEFT JOIN sales_reps sr ON o.sales_rep_id = sr.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.customer_id = $1
      GROUP BY o.id, sr.name
      ORDER BY o.created_at DESC
      `,
      [id]
    );

    return res.json({
      success: true,
      data: result.rows,
      message: 'Customer orders retrieved successfully',
    });
  } catch (err) {
    console.error('❌ getCustomerOrders error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to get customer orders',
      error: err.message,
    });
  }
};

const getCustomerPayments = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        p.*,
        o.order_number,
        o.order_type
      FROM payments p
      INNER JOIN orders o ON p.order_id = o.id
      WHERE o.customer_id = $1
      ORDER BY p.created_at DESC
      `,
      [id]
    );

    return res.json({
      success: true,
      data: result.rows,
      message: 'Customer payments retrieved successfully',
    });
  } catch (err) {
    console.error('❌ getCustomerPayments error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to get customer payments',
      error: err.message,
    });
  }
};

module.exports = {
  getAllCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerSummary,
  getCustomerOrders,
  getCustomerPayments,
};