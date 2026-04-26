'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

// GET all departments
const getAllDepartments = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM departments ORDER BY name ASC`
    );
    return handleSuccess(res, 200, 'Departments retrieved successfully', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve departments', err);
  }
};

// GET single department
const getDepartmentById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM departments WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return handleError(res, 404, 'Department not found');
    }
    return handleSuccess(res, 200, 'Department retrieved successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve department', err);
  }
};

// CREATE department
const createDepartment = async (req, res) => {
  try {
    const { name } = req.body;
    const rawName = String(name || '').trim();
    if (!rawName) {
      return handleError(res, 400, 'name is required');
    }
    const result = await pool.query(
      `INSERT INTO departments (name) VALUES ($1) RETURNING *`,
      [rawName]
    );
    return handleSuccess(res, 201, 'Department created successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'Department name already exists');
    }
    return handleError(res, 500, 'Failed to create department', err);
  }
};

// UPDATE department
const updateDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const result = await pool.query(
      `UPDATE departments
         SET name = COALESCE($1, name),
             updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [name ? String(name).trim() : null, id]
    );
    if (result.rows.length === 0) {
      return handleError(res, 404, 'Department not found');
    }
    return handleSuccess(res, 200, 'Department updated successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'Department name already exists');
    }
    return handleError(res, 500, 'Failed to update department', err);
  }
};

// DELETE department
const deleteDepartment = async (req, res) => {
  try {
    const { id } = req.params;

    // Guard: do not delete if products are assigned
    const productsResult = await pool.query(
      `SELECT COUNT(*) AS count FROM products WHERE department_id = $1`,
      [id]
    );
    const productCount = parseInt(productsResult.rows[0].count, 10);
    if (productCount > 0) {
      return handleError(
        res,
        400,
        `Cannot delete department. It has ${productCount} product(s) assigned to it. Please reassign or remove the products first.`
      );
    }

    const result = await pool.query(
      `DELETE FROM departments WHERE id = $1 RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return handleError(res, 404, 'Department not found');
    }
    return handleSuccess(res, 200, 'Department deleted successfully');
  } catch (err) {
    return handleError(res, 500, 'Failed to delete department', err);
  }
};

module.exports = {
  getAllDepartments,
  getDepartmentById,
  createDepartment,
  updateDepartment,
  deleteDepartment,
};
