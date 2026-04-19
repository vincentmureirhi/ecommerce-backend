'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const Decimal = require('decimal.js');

function toInt(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) return null;
  return n;
}

function toMoneyOrNull(v) {
  if (v == null || v === '') return null;
  const d = new Decimal(v);
  if (!d.isFinite()) return null;
  return d.toDecimalPlaces(2);
}

function requireNonEmptyString(v, field) {
  const s = String(v || '').trim();
  if (!s) throw new Error(`${field} is required`);
  return s;
}

// GET /api/products (public)
const getAllProducts = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.sku,
        p.category_id,
        c.name AS category_name,
        p.department_id,
        d.name AS department_name,
        p.current_stock,
        p.retail_price,
        p.wholesale_price,
        p.min_qty_wholesale,
        p.requires_manual_price,
        p.image_url,
        p.cost_price,
        p.created_at,
        p.updated_at
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN departments d ON d.id = p.department_id
      ORDER BY p.id DESC
    `);

    return handleSuccess(res, 200, 'Products retrieved', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve products', err);
  }
};

// GET /api/products/:id (public)
const getProductById = async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return handleError(res, 400, 'Invalid product id');

    const result = await pool.query(
      `
      SELECT
        p.id,
        p.name,
        p.sku,
        p.category_id,
        c.name AS category_name,
        p.department_id,
        d.name AS department_name,
        p.current_stock,
        p.retail_price,
        p.wholesale_price,
        p.min_qty_wholesale,
        p.requires_manual_price,
        p.image_url,
        p.cost_price,
        p.created_at,
        p.updated_at
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN departments d ON d.id = p.department_id
      WHERE p.id = $1
      `,
      [id]
    );

    if (result.rowCount === 0) return handleError(res, 404, 'Product not found');
    return handleSuccess(res, 200, 'Product retrieved', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve product', err);
  }
};

// POST /api/products (admin)
const createProduct = async (req, res) => {
  try {
    const name = requireNonEmptyString(req.body.name, 'name');
    const sku = requireNonEmptyString(req.body.sku, 'sku');

    const category_id = toInt(req.body.category_id);
    if (!category_id) return handleError(res, 400, 'category_id is required');

    const department_id = toInt(req.body.department_id); // optional

    const current_stock = toInt(req.body.current_stock) ?? 0;
    if (current_stock < 0) return handleError(res, 400, 'current_stock must be >= 0');

    const requires_manual_price = Boolean(req.body.requires_manual_price);
    const image_url = req.body.image_url ? String(req.body.image_url).trim() : null;

    const cost_price = toMoneyOrNull(req.body.cost_price);

    // pricing fields
    let retail_price = toMoneyOrNull(req.body.retail_price);
    let wholesale_price = toMoneyOrNull(req.body.wholesale_price);
    let min_qty_wholesale = toInt(req.body.min_qty_wholesale);

    if (requires_manual_price) {
      retail_price = null;
      wholesale_price = null;
      min_qty_wholesale = null;
    } else {
      if (retail_price == null) return handleError(res, 400, 'retail_price is required for non-manual products');
      if (retail_price.lte(0)) return handleError(res, 400, 'retail_price must be > 0');
      if (wholesale_price != null && wholesale_price.lte(0)) return handleError(res, 400, 'wholesale_price must be > 0');
      if (min_qty_wholesale != null && min_qty_wholesale < 1) return handleError(res, 400, 'min_qty_wholesale must be >= 1');
    }

    const result = await pool.query(
      `
      INSERT INTO products (
        name, sku, category_id, department_id,
        current_stock,
        retail_price, wholesale_price, min_qty_wholesale,
        requires_manual_price,
        image_url,
        cost_price
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `,
      [
        name,
        sku,
        category_id,
        department_id || null,
        current_stock,
        retail_price ? retail_price.toFixed(2) : null,
        wholesale_price ? wholesale_price.toFixed(2) : null,
        min_qty_wholesale || null,
        requires_manual_price,
        image_url,
        cost_price ? cost_price.toFixed(2) : null,
      ]
    );

    return handleSuccess(res, 201, 'Product created', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to create product', err);
  }
};

// PUT /api/products/:id (admin)
const updateProduct = async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return handleError(res, 400, 'Invalid product id');

    const name = requireNonEmptyString(req.body.name, 'name');
    const sku = requireNonEmptyString(req.body.sku, 'sku');

    const category_id = toInt(req.body.category_id);
    if (!category_id) return handleError(res, 400, 'category_id is required');

    const department_id = toInt(req.body.department_id); // optional

    const current_stock = toInt(req.body.current_stock) ?? 0;
    if (current_stock < 0) return handleError(res, 400, 'current_stock must be >= 0');

    const requires_manual_price = Boolean(req.body.requires_manual_price);
    const image_url = req.body.image_url ? String(req.body.image_url).trim() : null;

    const cost_price = toMoneyOrNull(req.body.cost_price);

    let retail_price = toMoneyOrNull(req.body.retail_price);
    let wholesale_price = toMoneyOrNull(req.body.wholesale_price);
    let min_qty_wholesale = toInt(req.body.min_qty_wholesale);

    if (requires_manual_price) {
      retail_price = null;
      wholesale_price = null;
      min_qty_wholesale = null;
    } else {
      if (retail_price == null) return handleError(res, 400, 'retail_price is required for non-manual products');
      if (retail_price.lte(0)) return handleError(res, 400, 'retail_price must be > 0');
      if (wholesale_price != null && wholesale_price.lte(0)) return handleError(res, 400, 'wholesale_price must be > 0');
      if (min_qty_wholesale != null && min_qty_wholesale < 1) return handleError(res, 400, 'min_qty_wholesale must be >= 1');
    }

    const result = await pool.query(
      `
      UPDATE products
      SET
        name=$1,
        sku=$2,
        category_id=$3,
        department_id=$4,
        current_stock=$5,
        retail_price=$6,
        wholesale_price=$7,
        min_qty_wholesale=$8,
        requires_manual_price=$9,
        image_url=$10,
        cost_price=$11,
        updated_at=now()
      WHERE id=$12
      RETURNING *
      `,
      [
        name,
        sku,
        category_id,
        department_id || null,
        current_stock,
        retail_price ? retail_price.toFixed(2) : null,
        wholesale_price ? wholesale_price.toFixed(2) : null,
        min_qty_wholesale || null,
        requires_manual_price,
        image_url,
        cost_price ? cost_price.toFixed(2) : null,
        id,
      ]
    );

    if (result.rowCount === 0) return handleError(res, 404, 'Product not found');
    return handleSuccess(res, 200, 'Product updated', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to update product', err);
  }
};

// DELETE /api/products/:id (admin)
const deleteProduct = async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (!id) return handleError(res, 400, 'Invalid product id');

    const result = await pool.query(`DELETE FROM products WHERE id=$1 RETURNING id`, [id]);
    if (result.rowCount === 0) return handleError(res, 404, 'Product not found');

    return handleSuccess(res, 200, 'Product deleted', { id });
  } catch (err) {
    return handleError(res, 500, 'Failed to delete product', err);
  }
};

// Stock helpers
const getOutOfStockProducts = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, sku, current_stock FROM products WHERE current_stock <= 0 ORDER BY id DESC`
    );
    return handleSuccess(res, 200, 'Out of stock products retrieved', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve out of stock products', err);
  }
};

const getLowStockProducts = async (req, res) => {
  try {
    const threshold = toInt(req.query.threshold) ?? 10;
    const result = await pool.query(
      `SELECT id, name, sku, current_stock FROM products WHERE current_stock > 0 AND current_stock <= $1 ORDER BY current_stock ASC`,
      [threshold]
    );
    return handleSuccess(res, 200, 'Low stock products retrieved', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve low stock products', err);
  }
};

module.exports = {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  getOutOfStockProducts,
  getLowStockProducts,
};