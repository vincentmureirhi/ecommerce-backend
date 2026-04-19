const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

// Get all locations
const getAllLocations = async (req, res) => {
  try {
    const { region_id, search } = req.query;

    let query = `
      SELECT
        l.*,
        r.name as region_name,
        COUNT(DISTINCT c.id) as customer_count
      FROM locations l
      JOIN regions r ON l.region_id = r.id
      LEFT JOIN customers c ON l.id = c.location_id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (region_id) {
      params.push(region_id);
      query += ` AND l.region_id = $${paramIndex}`;
      paramIndex++;
    }

    if (search) {
      params.push(`%${search}%`);
      query += ` AND l.name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    query += ` GROUP BY l.id, r.id ORDER BY l.name ASC`;

    const result = await pool.query(query, params);
    return handleSuccess(res, 200, 'Locations retrieved successfully', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve locations', err);
  }
};

// Get single location
const getLocationById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT
        l.*,
        r.name as region_name,
        COUNT(DISTINCT c.id) as customer_count
      FROM locations l
      JOIN regions r ON l.region_id = r.id
      LEFT JOIN customers c ON l.id = c.location_id
      WHERE l.id = $1
      GROUP BY l.id, r.id`,
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Location not found');
    }

    return handleSuccess(res, 200, 'Location retrieved successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve location', err);
  }
};

// Create location
const createLocation = async (req, res) => {
  try {
    const { name, region_id, latitude, longitude } = req.body;

    if (!name || !region_id) {
      return handleError(res, 400, 'Location name and region are required');
    }

    // Check if region exists
    const regionCheck = await pool.query('SELECT id FROM regions WHERE id = $1', [region_id]);
    if (regionCheck.rows.length === 0) {
      return handleError(res, 404, 'Region not found');
    }

    const result = await pool.query(
      `INSERT INTO locations (name, region_id, latitude, longitude)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name.trim(), region_id, latitude || null, longitude || null]
    );

    return handleSuccess(res, 201, 'Location created successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'Location name already exists in this region');
    }
    return handleError(res, 500, 'Failed to create location', err);
  }
};

// Update location
const updateLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, region_id, latitude, longitude } = req.body;

    const result = await pool.query(
      `UPDATE locations
       SET name = COALESCE($1, name),
           region_id = COALESCE($2, region_id),
           latitude = COALESCE($3, latitude),
           longitude = COALESCE($4, longitude),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING *`,
      [name ? name.trim() : null, region_id || null, latitude || null, longitude || null, id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Location not found');
    }

    return handleSuccess(res, 200, 'Location updated successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'Location name already exists in this region');
    }
    return handleError(res, 500, 'Failed to update location', err);
  }
};

// Delete location
const deleteLocation = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if location has customers
    const customerCheck = await pool.query(
      'SELECT COUNT(*) as count FROM customers WHERE location_id = $1',
      [id]
    );

    if (parseInt(customerCheck.rows[0].count) > 0) {
      return handleError(
        res,
        400,
        'Cannot delete location. It has customers assigned to it.'
      );
    }

    const result = await pool.query(
      'DELETE FROM locations WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Location not found');
    }

    return handleSuccess(res, 200, 'Location deleted successfully');
  } catch (err) {
    return handleError(res, 500, 'Failed to delete location', err);
  }
};

module.exports = {
  getAllLocations,
  getLocationById,
  createLocation,
  updateLocation,
  deleteLocation,
};