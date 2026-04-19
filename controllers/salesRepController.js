const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

function normalizeNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Get all sales reps with actual performance metrics + latest location
const getAllSalesReps = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        sr.id,
        sr.name,
        sr.phone_number,
        sr.email,
        sr.status,
        sr.created_at,
        sr.updated_at,
        COUNT(DISTINCT o.id) AS order_count,
        COUNT(DISTINCT CASE WHEN o.customer_id IS NOT NULL THEN o.customer_id END) AS customer_count,
        COALESCE(SUM(o.total_amount), 0) AS total_sales,
        COALESCE(AVG(o.total_amount), 0) AS avg_order_value,
        MAX(o.created_at) AS last_order_date,
        loc.latitude AS latest_latitude,
        loc.longitude AS latest_longitude,
        loc.accuracy_meters AS latest_accuracy_meters,
        loc.recorded_at AS latest_location_recorded_at,
        loc.source AS latest_location_source
      FROM sales_reps sr
      LEFT JOIN orders o ON o.sales_rep_id = sr.id
      LEFT JOIN LATERAL (
        SELECT
          srl.latitude,
          srl.longitude,
          srl.accuracy_meters,
          srl.recorded_at,
          srl.source
        FROM sales_rep_locations srl
        WHERE srl.sales_rep_id = sr.id
        ORDER BY srl.recorded_at DESC
        LIMIT 1
      ) loc ON TRUE
      GROUP BY
        sr.id,
        loc.latitude,
        loc.longitude,
        loc.accuracy_meters,
        loc.recorded_at,
        loc.source
      ORDER BY sr.name ASC
    `);

    return handleSuccess(res, 200, 'Sales reps retrieved successfully', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve sales reps', err);
  }
};

// Get single sales rep with real served customers, orders, and latest location
const getSalesRepById = async (req, res) => {
  try {
    const { id } = req.params;

    const repResult = await pool.query(
      `
      SELECT
        sr.*,
        COUNT(DISTINCT o.id) AS order_count,
        COUNT(DISTINCT CASE WHEN o.customer_id IS NOT NULL THEN o.customer_id END) AS ordering_customer_count,
        COALESCE(SUM(o.total_amount), 0) AS total_sales,
        COALESCE(AVG(o.total_amount), 0) AS avg_order_value,
        MAX(o.created_at) AS last_order_date,
        COUNT(CASE WHEN o.order_status = 'completed' THEN 1 END) AS completed_orders,
        COUNT(CASE WHEN o.order_status = 'pending' THEN 1 END) AS pending_orders,
        loc.latitude AS latest_latitude,
        loc.longitude AS latest_longitude,
        loc.accuracy_meters AS latest_accuracy_meters,
        loc.speed_kph AS latest_speed_kph,
        loc.heading_degrees AS latest_heading_degrees,
        loc.battery_level AS latest_battery_level,
        loc.source AS latest_location_source,
        loc.recorded_at AS latest_location_recorded_at
      FROM sales_reps sr
      LEFT JOIN orders o ON o.sales_rep_id = sr.id
      LEFT JOIN LATERAL (
        SELECT
          srl.latitude,
          srl.longitude,
          srl.accuracy_meters,
          srl.speed_kph,
          srl.heading_degrees,
          srl.battery_level,
          srl.source,
          srl.recorded_at
        FROM sales_rep_locations srl
        WHERE srl.sales_rep_id = sr.id
        ORDER BY srl.recorded_at DESC
        LIMIT 1
      ) loc ON TRUE
      WHERE sr.id = $1
      GROUP BY
        sr.id,
        loc.latitude,
        loc.longitude,
        loc.accuracy_meters,
        loc.speed_kph,
        loc.heading_degrees,
        loc.battery_level,
        loc.source,
        loc.recorded_at
      `,
      [id]
    );

    if (repResult.rows.length === 0) {
      return handleError(res, 404, 'Sales rep not found');
    }

    const customersResult = await pool.query(
      `
      SELECT DISTINCT
        c.id,
        c.name,
        c.phone,
        c.email,
        c.customer_type,
        c.is_active,
        l.name AS location_name,
        r.name AS region_name
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      WHERE o.sales_rep_id = $1
      ORDER BY c.name ASC
      `,
      [id]
    );

    const ordersResult = await pool.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.customer_id,
        o.customer_name,
        o.total_amount,
        o.order_status,
        o.payment_status,
        o.created_at,
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
      [id]
    );

    const data = {
      ...repResult.rows[0],
      customers: customersResult.rows,
      orders: ordersResult.rows,
    };

    return handleSuccess(res, 200, 'Sales rep retrieved successfully', data);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve sales rep', err);
  }
};

// Save latest location ping for a sales rep
const saveSalesRepLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      latitude,
      longitude,
      accuracy_meters,
      speed_kph,
      heading_degrees,
      battery_level,
      source,
      recorded_at,
    } = req.body;

    const lat = normalizeNumber(latitude);
    const lng = normalizeNumber(longitude);

    if (lat === null || lng === null) {
      return handleError(res, 400, 'latitude and longitude are required');
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return handleError(res, 400, 'Invalid latitude/longitude range');
    }

    const repCheck = await pool.query(
      'SELECT id FROM sales_reps WHERE id = $1',
      [id]
    );

    if (repCheck.rows.length === 0) {
      return handleError(res, 404, 'Sales rep not found');
    }

    const result = await pool.query(
      `
      INSERT INTO sales_rep_locations
      (
        sales_rep_id,
        latitude,
        longitude,
        accuracy_meters,
        speed_kph,
        heading_degrees,
        battery_level,
        source,
        recorded_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()))
      RETURNING *
      `,
      [
        id,
        lat,
        lng,
        normalizeNumber(accuracy_meters),
        normalizeNumber(speed_kph),
        normalizeNumber(heading_degrees),
        normalizeNumber(battery_level),
        source || 'web',
        recorded_at || null,
      ]
    );

    return handleSuccess(res, 201, 'Sales rep location saved successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to save sales rep location', err);
  }
};

// Get latest location for one sales rep
const getLatestSalesRepLocation = async (req, res) => {
  try {
    const { id } = req.params;

    const repCheck = await pool.query(
      'SELECT id, name FROM sales_reps WHERE id = $1',
      [id]
    );

    if (repCheck.rows.length === 0) {
      return handleError(res, 404, 'Sales rep not found');
    }

    const result = await pool.query(
      `
      SELECT
        srl.*,
        sr.name AS sales_rep_name
      FROM sales_rep_locations srl
      JOIN sales_reps sr ON sr.id = srl.sales_rep_id
      WHERE srl.sales_rep_id = $1
      ORDER BY srl.recorded_at DESC
      LIMIT 1
      `,
      [id]
    );

    return handleSuccess(
      res,
      200,
      'Latest sales rep location retrieved successfully',
      result.rows[0] || null
    );
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve latest sales rep location', err);
  }
};

// Get latest location for all reps
const getLatestSalesRepLocations = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        sr.id AS sales_rep_id,
        sr.name AS sales_rep_name,
        sr.phone_number,
        sr.status,
        loc.id,
        loc.latitude,
        loc.longitude,
        loc.accuracy_meters,
        loc.speed_kph,
        loc.heading_degrees,
        loc.battery_level,
        loc.source,
        loc.recorded_at
      FROM sales_reps sr
      LEFT JOIN LATERAL (
        SELECT *
        FROM sales_rep_locations srl
        WHERE srl.sales_rep_id = sr.id
        ORDER BY srl.recorded_at DESC
        LIMIT 1
      ) loc ON TRUE
      ORDER BY sr.name ASC
    `);

    return handleSuccess(
      res,
      200,
      'Latest locations for all sales reps retrieved successfully',
      result.rows
    );
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve latest sales rep locations', err);
  }
};

// Create sales rep
const createSalesRep = async (req, res) => {
  try {
    const { name, phone_number, email, status } = req.body;

    if (!name) {
      return handleError(res, 400, 'name is required');
    }

    const result = await pool.query(
      `INSERT INTO sales_reps (name, phone_number, email, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, phone_number || null, email || null, status || 'active']
    );

    return handleSuccess(res, 201, 'Sales rep created successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to create sales rep', err);
  }
};

// Update sales rep
const updateSalesRep = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone_number, email, status } = req.body;

    const result = await pool.query(
      `UPDATE sales_reps
       SET name = COALESCE($1, name),
           phone_number = COALESCE($2, phone_number),
           email = COALESCE($3, email),
           status = COALESCE($4, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING *`,
      [name || null, phone_number || null, email || null, status || null, id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Sales rep not found');
    }

    return handleSuccess(res, 200, 'Sales rep updated successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to update sales rep', err);
  }
};

// Delete sales rep
const deleteSalesRep = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM sales_reps WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Sales rep not found');
    }

    return handleSuccess(res, 200, 'Sales rep deleted successfully');
  } catch (err) {
    return handleError(res, 500, 'Failed to delete sales rep', err);
  }
};

module.exports = {
  getAllSalesReps,
  getSalesRepById,
  saveSalesRepLocation,
  getLatestSalesRepLocation,
  getLatestSalesRepLocations,
  createSalesRep,
  updateSalesRep,
  deleteSalesRep
};