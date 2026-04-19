const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

// Get all routes
const getAllRoutes = async (req, res) => {
  try {
    const { sales_rep_id } = req.query;

    let query = `
      SELECT
        r.*,
        sr.name as sales_rep_name,
        COUNT(DISTINCT c.id) as customer_count,
        COUNT(DISTINCT cl.id) as location_count
      FROM routes r
      LEFT JOIN sales_reps sr ON r.sales_rep_id = sr.id
      LEFT JOIN customers c ON c.route_id = r.id
      LEFT JOIN customer_locations cl ON cl.route_id = r.id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (sales_rep_id) {
      params.push(sales_rep_id);
      query += ` AND r.sales_rep_id = $${paramIndex}`;
      paramIndex++;
    }

    query += ` GROUP BY r.id, sr.id ORDER BY r.name ASC`;

    const result = await pool.query(query, params);
    return handleSuccess(res, 200, 'Routes retrieved successfully', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve routes', err);
  }
};

// Get route with customers and locations
const getRouteById = async (req, res) => {
  try {
    const { id } = req.params;

    const routeResult = await pool.query(
      `SELECT r.*, sr.name as sales_rep_name FROM routes r
       LEFT JOIN sales_reps sr ON r.sales_rep_id = sr.id
       WHERE r.id = $1`,
      [id]
    );

    if (routeResult.rows.length === 0) {
      return handleError(res, 404, 'Route not found');
    }

    const customersResult = await pool.query(
      `SELECT c.*, cl.name as location_name FROM customers c
       LEFT JOIN customer_locations cl ON c.location_id = cl.id
       WHERE c.route_id = $1
       ORDER BY c.name ASC`,
      [id]
    );

    const locationsResult = await pool.query(
      'SELECT * FROM customer_locations WHERE route_id = $1 ORDER BY name ASC',
      [id]
    );

    const data = {
      ...routeResult.rows[0],
      customers: customersResult.rows,
      locations: locationsResult.rows,
    };

    return handleSuccess(res, 200, 'Route retrieved successfully', data);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve route', err);
  }
};

// Create route
const createRoute = async (req, res) => {
  try {
    const { name, description, sales_rep_id, status } = req.body;

    if (!name || !sales_rep_id) {
      return handleError(res, 400, 'name and sales_rep_id are required');
    }

    // Verify sales rep exists
    const repCheck = await pool.query('SELECT id FROM sales_reps WHERE id = $1', [sales_rep_id]);
    if (repCheck.rows.length === 0) {
      return handleError(res, 400, 'Sales rep does not exist');
    }

    const result = await pool.query(
      `INSERT INTO routes (name, description, sales_rep_id, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, description || null, sales_rep_id, status || 'active']
    );

    return handleSuccess(res, 201, 'Route created successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to create route', err);
  }
};

// Update route
const updateRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, sales_rep_id, status } = req.body;

    const result = await pool.query(
      `UPDATE routes
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           sales_rep_id = COALESCE($3, sales_rep_id),
           status = COALESCE($4, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING *`,
      [name || null, description || null, sales_rep_id || null, status || null, id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Route not found');
    }

    return handleSuccess(res, 200, 'Route updated successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to update route', err);
  }
};

// Delete route
const deleteRoute = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM routes WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Route not found');
    }

    return handleSuccess(res, 200, 'Route deleted successfully');
  } catch (err) {
    return handleError(res, 500, 'Failed to delete route', err);
  }
};

module.exports = {
  getAllRoutes,
  getRouteById,
  createRoute,
  updateRoute,
  deleteRoute
};