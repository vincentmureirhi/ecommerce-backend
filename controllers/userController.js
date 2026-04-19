const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

// Get all users (admin only)
const getAllUsers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, role, phone_number, is_active, created_at
       FROM users
       WHERE is_active = true
       ORDER BY created_at DESC`
    );

    return handleSuccess(res, 200, 'Users retrieved successfully', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve users', err);
  }
};

// Get all sales reps
const getAllSalesReps = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, phone_number, created_at
       FROM users
       WHERE role = 'sales_rep' AND is_active = true
       ORDER BY first_name ASC`
    );

    return handleSuccess(res, 200, 'Sales representatives retrieved successfully', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve sales representatives', err);
  }
};

// Get user by ID
const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT id, email, first_name, last_name, role, phone_number, is_active, created_at
       FROM users
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'User not found');
    }

    return handleSuccess(res, 200, 'User retrieved successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve user', err);
  }
};

// Update user
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { phone_number, is_active } = req.body;

    const result = await pool.query(
      `UPDATE users
       SET phone_number = COALESCE($1, phone_number),
           is_active = COALESCE($2, is_active),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING id, email, first_name, last_name, role, phone_number, is_active`,
      [phone_number || null, is_active !== undefined ? is_active : null, id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'User not found');
    }

    return handleSuccess(res, 200, 'User updated successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to update user', err);
  }
};

module.exports = {
  getAllUsers,
  getAllSalesReps,
  getUserById,
  updateUser
};