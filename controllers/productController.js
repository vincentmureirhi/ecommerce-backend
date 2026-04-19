"use strict";

const pool = require("../config/database");
const { handleError, handleSuccess } = require("../utils/errorHandler");
const Decimal = require("decimal.js");

function toInt(v, field, { allowNull = false } = {}) {
  if (v == null || v === "") {
    if (allowNull) return null;
    throw new Error(`${field} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${field} must be an integer >= 0`);
  return n;
}

function toMoney(v, field, { allowNull = false } = {}) {
  if (v == null || v === "") {
    if (allowNull) return null;
    throw new Error(`${field} is required`);
  }
  const d = new Decimal(v);
  if (!d.isFinite() || d.lt(0)) throw new Error(`${field} must be a number >= 0`);
  return d.toDecimalPlaces(2);
}

const getAllProducts = async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        p.*,
        c.name AS category_name,
        d.name AS department_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN departments d ON d.id = p.department_id
      ORDER BY p.id DESC
    `);
    return handleSuccess(res, 200, "Products retrieved", r.rows);
  } catch (err) {
    return handleError(res, 500, "Failed to retrieve products", err);
  }
};

const getProductById = async (req, res) => {
  try {
    const id = toInt(req.params.id, "id");
    const r = await pool.query(
      `
      SELECT
        p.*,
        c.name AS category_name,
        d.name AS department_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN departments d ON d.id = p.department_id
      WHERE p.id = $1
      `,
      [id]
    );
    if (r.rowCount === 0) return handleError(res, 404, "Product not found");
    return handleSuccess(res, 200, "Product retrieved", r.rows[0]);
  } catch (err) {
    return handleError(res, 500, "Failed to retrieve product", err);
  }
};

const createProduct = async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const sku = String(req.body.sku || "").trim();
    if (!name) return handleError(res, 400, "name is required");
    if (!sku) return handleError(res, 400, "sku is required");

    const category_id = toInt(req.body.category_id, "category_id");
    const department_id = toInt(req.body.department_id, "department_id", { allowNull: true });
    const current_stock = toInt(req.body.current_stock ?? 0, "current_stock");
    const requires_manual_price = Boolean(req.body.requires_manual_price);

    const image_url = req.body.image_url ? String(req.body.image_url).trim() : null;

    // Profit calculation needs cost_price even if manual pricing product
    const cost_price = toMoney(req.body.cost_price, "cost_price", { allowNull: true });

    let retail_price = null;
    let wholesale_price = null;
    let min_qty_wholesale = null;

    if (!requires_manual_price) {
      retail_price = toMoney(req.body.retail_price, "retail_price");
      wholesale_price = toMoney(req.body.wholesale_price, "wholesale_price", { allowNull: true });
      min_qty_wholesale = toInt(req.body.min_qty_wholesale, "min_qty_wholesale", { allowNull: true });
    }

    const r = await pool.query(
      `
      INSERT INTO products (
        name, sku, category_id, department_id,
        current_stock, cost_price,
        retail_price, wholesale_price, min_qty_wholesale,
        requires_manual_price, image_url
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `,
      [
        name,
        sku,
        category_id,
        department_id,
        current_stock,
        cost_price ? cost_price.toFixed(2) : null,
        retail_price ? retail_price.toFixed(2) : null,
        wholesale_price ? wholesale_price.toFixed(2) : null,
        min_qty_wholesale,
        requires_manual_price,
        image_url,
      ]
    );

    return handleSuccess(res, 201, "Product created", r.rows[0]);
  } catch (err) {
    return handleError(res, 500, "Failed to create product", err);
  }
};

const updateProduct = async (req, res) => {
  try {
    const id = toInt(req.params.id, "id");

    const name = String(req.body.name || "").trim();
    const sku = String(req.body.sku || "").trim();
    if (!name) return handleError(res, 400, "name is required");
    if (!sku) return handleError(res, 400, "sku is required");

    const category_id = toInt(req.body.category_id, "category_id");
    const department_id = toInt(req.body.department_id, "department_id", { allowNull: true });
    const current_stock = toInt(req.body.current_stock ?? 0, "current_stock");
    const requires_manual_price = Boolean(req.body.requires_manual_price);

    const image_url = req.body.image_url ? String(req.body.image_url).trim() : null;
    const cost_price = toMoney(req.body.cost_price, "cost_price", { allowNull: true });

    let retail_price = null;
    let wholesale_price = null;
    let min_qty_wholesale = null;

    if (!requires_manual_price) {
      retail_price = toMoney(req.body.retail_price, "retail_price");
      wholesale_price = toMoney(req.body.wholesale_price, "wholesale_price", { allowNull: true });
      min_qty_wholesale = toInt(req.body.min_qty_wholesale, "min_qty_wholesale", { allowNull: true });
    }

    const r = await pool.query(
      `
      UPDATE products
      SET
        name=$1,
        sku=$2,
        category_id=$3,
        department_id=$4,
        current_stock=$5,
        cost_price=$6,
        retail_price=$7,
        wholesale_price=$8,
        min_qty_wholesale=$9,
        requires_manual_price=$10,
        image_url=$11
      WHERE id=$12
      RETURNING *
      `,
      [
        name,
        sku,
        category_id,
        department_id,
        current_stock,
        cost_price ? cost_price.toFixed(2) : null,
        retail_price ? retail_price.toFixed(2) : null,
        wholesale_price ? wholesale_price.toFixed(2) : null,
        min_qty_wholesale,
        requires_manual_price,
        image_url,
        id,
      ]
    );

    if (r.rowCount === 0) return handleError(res, 404, "Product not found");
    return handleSuccess(res, 200, "Product updated", r.rows[0]);
  } catch (err) {
    return handleError(res, 500, "Failed to update product", err);
  }
};

const deleteProduct = async (req, res) => {
  try {
    const id = toInt(req.params.id, "id");
    const r = await pool.query("DELETE FROM products WHERE id=$1", [id]);
    if (r.rowCount === 0) return handleError(res, 404, "Product not found");
    return handleSuccess(res, 200, "Product deleted");
  } catch (err) {
    return handleError(res, 500, "Failed to delete product", err);
  }
};

// If you already have these routes, keep them simple:
const getOutOfStockProducts = async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM products WHERE current_stock <= 0 ORDER BY id DESC`);
    return handleSuccess(res, 200, "Out of stock products", r.rows);
  } catch (err) {
    return handleError(res, 500, "Failed to retrieve out of stock products", err);
  }
};

const getLowStockProducts = async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM products WHERE current_stock > 0 AND current_stock <= 10 ORDER BY id DESC`);
    return handleSuccess(res, 200, "Low stock products", r.rows);
  } catch (err) {
    return handleError(res, 500, "Failed to retrieve low stock products", err);
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