const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

// Get all locations
const getAllLocations = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM customer_locations ORDER BY name ASC'
    );

    return handleSuccess(res, 200, 'Locations retrieved successfully', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve locations', err);
  }
};

// Get location by ID
const getLocationById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM customer_locations WHERE id = $1',
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
    const { name, description } = req.body;

    if (!name) {
      return handleError(res, 400, 'Location name is required');
    }

    const result = await pool.query(
      `INSERT INTO customer_locations (name, description)
       VALUES ($1, $2)
       RETURNING *`,
      [name, description || null]
    );

    return handleSuccess(res, 201, 'Location created successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'Location name already exists');
    }
    return handleError(res, 500, 'Failed to create location', err);
  }
};

// Update location
const updateLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const result = await pool.query(
      `UPDATE customer_locations
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [name || null, description || null, id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Location not found');
    }

    return handleSuccess(res, 200, 'Location updated successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to update location', err);
  }
};

// Delete location
const deleteLocation = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if location has customers
    const checkCustomers = await pool.query(
      'SELECT COUNT(*) as count FROM customers WHERE location_id = $1',
      [id]
    );

    if (parseInt(checkCustomers.rows[0].count) > 0) {
      return handleError(res, 400, 'Cannot delete location with customers. Delete or reassign customers first.');
    }

    const result = await pool.query(
      'DELETE FROM customer_locations WHERE id = $1 RETURNING *',
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
  deleteLocation
};