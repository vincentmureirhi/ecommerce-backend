const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

// Get all categories with stock value
const getAllCategories = async (req, res) => {
  try {
    const { search } = req.query;

    let query = `
      SELECT
        c.*,
        COUNT(DISTINCT p.id) as product_count,
        COALESCE(SUM(p.current_stock), 0) as total_stock,
        COALESCE(SUM(p.current_stock * COALESCE(p.retail_price, 0)), 0) as stock_value
      FROM categories c
      LEFT JOIN products p ON c.id = p.category_id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (search) {
      params.push(`%${search}%`);
      query += ` AND c.name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    query += ` GROUP BY c.id ORDER BY c.name ASC`;

    const result = await pool.query(query, params);
    return handleSuccess(res, 200, 'Categories retrieved successfully', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve categories', err);
  }
};

// Get single category
const getCategoryById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT
        c.*,
        COUNT(DISTINCT p.id) as product_count,
        COALESCE(SUM(p.current_stock), 0) as total_stock,
        COALESCE(SUM(p.current_stock * COALESCE(p.retail_price, 0)), 0) as stock_value
      FROM categories c
      LEFT JOIN products p ON c.id = p.category_id
      WHERE c.id = $1
      GROUP BY c.id`,
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Category not found');
    }

    return handleSuccess(res, 200, 'Category retrieved successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve category', err);
  }
};

// Create category
const createCategory = async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return handleError(res, 400, 'name is required');
    }

    const result = await pool.query(
      `INSERT INTO categories (name, description)
       VALUES ($1, $2)
       RETURNING *`,
      [name.trim(), description ? description.trim() : null]
    );

    return handleSuccess(res, 201, 'Category created successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'Category name already exists');
    }
    return handleError(res, 500, 'Failed to create category', err);
  }
};

// Update category
const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const result = await pool.query(
      `UPDATE categories
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [name ? name.trim() : null, description ? description.trim() : null, id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Category not found');
    }

    return handleSuccess(res, 200, 'Category updated successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'Category name already exists');
    }
    return handleError(res, 500, 'Failed to update category', err);
  }
};

// Delete category - WITH VALIDATION
const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if category has products
    const productsResult = await pool.query(
      'SELECT COUNT(*) as count FROM products WHERE category_id = $1',
      [id]
    );

    const productCount = parseInt(productsResult.rows[0].count);

    if (productCount > 0) {
      return handleError(
        res,
        400,
        `Cannot delete category. It has ${productCount} product(s) assigned to it. Please reassign or delete the products first.`
      );
    }

    const result = await pool.query(
      'DELETE FROM categories WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Category not found');
    }

    return handleSuccess(res, 200, 'Category deleted successfully');
  } catch (err) {
    return handleError(res, 500, 'Failed to delete category', err);
  }
};

module.exports = {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
};