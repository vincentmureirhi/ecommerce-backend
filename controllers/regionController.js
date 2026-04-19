const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

// Get all regions with location count
const getAllRegions = async (req, res) => {
  try {
    const { search } = req.query;

    let query = `
      SELECT
        r.*,
        COUNT(DISTINCT l.id) AS location_count
      FROM regions r
      LEFT JOIN locations l ON r.id = l.region_id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (search) {
      params.push(`%${search}%`);
      query += ` AND r.name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    query += ` GROUP BY r.id ORDER BY r.name ASC`;

    const result = await pool.query(query, params);
    return handleSuccess(res, 200, 'Regions retrieved successfully', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve regions', err);
  }
};

// Get single region with locations
const getRegionById = async (req, res) => {
  try {
    const { id } = req.params;

    const regionResult = await pool.query(
      `SELECT * FROM regions WHERE id = $1`,
      [id]
    );

    if (regionResult.rows.length === 0) {
      return handleError(res, 404, 'Region not found');
    }

    const locationsResult = await pool.query(
      `SELECT * FROM locations WHERE region_id = $1 ORDER BY name ASC`,
      [id]
    );

    const region = regionResult.rows[0];
    region.locations = locationsResult.rows;

    return handleSuccess(res, 200, 'Region retrieved successfully', region);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve region', err);
  }
};

// Get region dashboard/details
const getRegionDashboard = async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.query;

    const regionResult = await pool.query(
      `
      SELECT
        r.*,
        COUNT(DISTINCT l.id) AS location_count,
        COUNT(DISTINCT c.id) AS customer_count,
        COUNT(DISTINCT CASE WHEN c.is_active = true THEN c.id END) AS active_customer_count
      FROM regions r
      LEFT JOIN locations l ON l.region_id = r.id
      LEFT JOIN customers c ON c.location_id = l.id
      WHERE r.id = $1
      GROUP BY r.id
      `,
      [id]
    );

    if (regionResult.rows.length === 0) {
      return handleError(res, 404, 'Region not found');
    }

    const locationsResult = await pool.query(
      `
      SELECT
        l.*,
        COUNT(DISTINCT c.id) AS customer_count
      FROM locations l
      LEFT JOIN customers c ON c.location_id = l.id
      WHERE l.region_id = $1
      GROUP BY l.id
      ORDER BY l.name ASC
      `,
      [id]
    );

    const customersResult = await pool.query(
      `
      SELECT
        c.id,
        c.name,
        c.email,
        c.phone,
        c.customer_type,
        c.sales_rep_id,
        sr.name AS sales_rep_name,
        c.is_active,
        c.created_at,
        c.updated_at,
        l.name AS location_name
      FROM customers c
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN sales_reps sr ON c.sales_rep_id = sr.id
      WHERE l.region_id = $1
      ORDER BY c.name ASC
      `,
      [id]
    );

    const orderParams = [id];
    let orderDateClause = '';
    let paramIndex = 2;

    if (start_date) {
      orderParams.push(start_date);
      orderDateClause += ` AND o.created_at::date >= $${paramIndex}`;
      paramIndex++;
    }

    if (end_date) {
      orderParams.push(end_date);
      orderDateClause += ` AND o.created_at::date <= $${paramIndex}`;
      paramIndex++;
    }

    const summaryResult = await pool.query(
      `
      SELECT
        COUNT(DISTINCT o.id) AS order_count,
        COALESCE(SUM(o.total_amount), 0) AS total_revenue,
        COUNT(DISTINCT o.customer_id) AS buying_customer_count,
        COUNT(CASE WHEN o.order_status = 'completed' THEN 1 END) AS completed_orders,
        COUNT(CASE WHEN o.order_status = 'pending' THEN 1 END) AS pending_orders,
        COUNT(CASE WHEN o.payment_status = 'completed' THEN 1 END) AS paid_orders
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      JOIN locations l ON c.location_id = l.id
      WHERE l.region_id = $1
      ${orderDateClause}
      `,
      orderParams
    );

    const dailyBreakdownResult = await pool.query(
      `
      SELECT
        o.created_at::date AS order_date,
        COUNT(DISTINCT o.id) AS order_count,
        COALESCE(SUM(o.total_amount), 0) AS total_revenue
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      JOIN locations l ON c.location_id = l.id
      WHERE l.region_id = $1
      ${orderDateClause}
      GROUP BY o.created_at::date
      ORDER BY order_date DESC
      `,
      orderParams
    );

    const salesRepBreakdownResult = await pool.query(
      `
      SELECT
        o.sales_rep_id,
        COALESCE(sr.name, 'Unassigned') AS sales_rep_name,
        COUNT(DISTINCT o.id) AS order_count,
        COUNT(DISTINCT o.customer_id) AS customer_count,
        COALESCE(SUM(o.total_amount), 0) AS total_revenue
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      JOIN locations l ON c.location_id = l.id
      LEFT JOIN sales_reps sr ON o.sales_rep_id = sr.id
      WHERE l.region_id = $1
      ${orderDateClause}
      GROUP BY o.sales_rep_id, sr.name
      ORDER BY total_revenue DESC, order_count DESC
      `,
      orderParams
    );

    const ordersResult = await pool.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.customer_id,
        o.customer_name,
        o.customer_phone,
        o.sales_rep_id,
        sr.name AS sales_rep_name,
        o.total_amount,
        o.payment_status,
        o.order_status,
        o.created_at,
        c.customer_type,
        l.name AS location_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN sales_reps sr ON o.sales_rep_id = sr.id
      WHERE l.region_id = $1
      ${orderDateClause}
      ORDER BY o.created_at DESC
      LIMIT 100
      `,
      orderParams
    );

    const region = regionResult.rows[0];

    const payload = {
      ...region,
      locations: locationsResult.rows,
      customers: customersResult.rows,
      summary: summaryResult.rows[0],
      daily_breakdown: dailyBreakdownResult.rows,
      sales_rep_breakdown: salesRepBreakdownResult.rows,
      orders: ordersResult.rows,
      filters: {
        start_date: start_date || null,
        end_date: end_date || null,
      },
    };

    return handleSuccess(res, 200, 'Region dashboard retrieved successfully', payload);
  } catch (err) {
    console.error('getRegionDashboard error:', err.message);
    return handleError(res, 500, 'Failed to retrieve region dashboard', err);
  }
};

// Create region
const createRegion = async (req, res) => {
  try {
    const { name, description, latitude, longitude } = req.body;

    if (!name) {
      return handleError(res, 400, 'Region name is required');
    }

    const result = await pool.query(
      `INSERT INTO regions (name, description, latitude, longitude)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name.trim(), description ? description.trim() : null, latitude || null, longitude || null]
    );

    return handleSuccess(res, 201, 'Region created successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'Region name already exists');
    }
    return handleError(res, 500, 'Failed to create region', err);
  }
};

// Update region
const updateRegion = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, latitude, longitude } = req.body;

    const result = await pool.query(
      `UPDATE regions
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           latitude = COALESCE($3, latitude),
           longitude = COALESCE($4, longitude),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING *`,
      [name ? name.trim() : null, description ? description.trim() : null, latitude || null, longitude || null, id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Region not found');
    }

    return handleSuccess(res, 200, 'Region updated successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'Region name already exists');
    }
    return handleError(res, 500, 'Failed to update region', err);
  }
};

// Delete region
const deleteRegion = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM regions WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Region not found');
    }

    return handleSuccess(res, 200, 'Region deleted successfully');
  } catch (err) {
    return handleError(res, 500, 'Failed to delete region', err);
  }
};

module.exports = {
  getAllRegions,
  getRegionById,
  getRegionDashboard,
  createRegion,
  updateRegion,
  deleteRegion,
};