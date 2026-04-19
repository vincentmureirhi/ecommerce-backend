'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const Decimal = require('decimal.js');

function toInt(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${field} must be an integer >= 1`);
  return n;
}
function toNullableInt(v, field) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${field} must be an integer >= 1`);
  return n;
}
function toMoney(v, field) {
  const d = new Decimal(v);
  if (!d.isFinite() || d.lte(0)) throw new Error(`${field} must be a number > 0`);
  return d.toDecimalPlaces(2);
}

const listTiersByProduct = async (req, res) => {
  try {
    const product_id = toInt(req.params.product_id, 'product_id');

    const r = await pool.query(
      `SELECT id, product_id, min_qty, max_qty, unit_price
       FROM product_price_tiers
       WHERE product_id = $1
       ORDER BY min_qty ASC`,
      [product_id]
    );

    return handleSuccess(res, 200, 'Tiers retrieved', r.rows);
  } catch (err) {
    return handleError(res, 400, err.message);
  }
};

const createTier = async (req, res) => {
  const client = await pool.connect();
  try {
    const product_id = toInt(req.body.product_id, 'product_id');
    const min_qty = toInt(req.body.min_qty, 'min_qty');
    const max_qty = toNullableInt(req.body.max_qty, 'max_qty');
    const unit_price = toMoney(req.body.unit_price, 'unit_price');

    if (max_qty != null && max_qty < min_qty) {
      return handleError(res, 400, 'max_qty must be >= min_qty');
    }

    await client.query('BEGIN');

    // overlap protection: tier ranges must not overlap for same product
    const overlap = await client.query(
      `
      SELECT 1
      FROM product_price_tiers
      WHERE product_id = $1
        AND (
          ($2 BETWEEN min_qty AND COALESCE(max_qty, 2147483647))
          OR (COALESCE($3, 2147483647) BETWEEN min_qty AND COALESCE(max_qty, 2147483647))
          OR (min_qty BETWEEN $2 AND COALESCE($3, 2147483647))
        )
      LIMIT 1
      `,
      [product_id, min_qty, max_qty]
    );

    if (overlap.rowCount > 0) {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'Tier overlaps an existing tier for this product');
    }

    const ins = await client.query(
      `
      INSERT INTO product_price_tiers (product_id, min_qty, max_qty, unit_price)
      VALUES ($1,$2,$3,$4)
      RETURNING id, product_id, min_qty, max_qty, unit_price
      `,
      [product_id, min_qty, max_qty, unit_price.toFixed(2)]
    );

    await client.query('COMMIT');
    return handleSuccess(res, 201, 'Tier created', ins.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return handleError(res, 400, err.message || 'Failed to create tier', err);
  } finally {
    client.release();
  }
};

const updateTier = async (req, res) => {
  const client = await pool.connect();
  try {
    const id = toInt(req.params.id, 'id');
    const min_qty = toInt(req.body.min_qty, 'min_qty');
    const max_qty = toNullableInt(req.body.max_qty, 'max_qty');
    const unit_price = toMoney(req.body.unit_price, 'unit_price');

    if (max_qty != null && max_qty < min_qty) {
      return handleError(res, 400, 'max_qty must be >= min_qty');
    }

    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT id, product_id FROM product_price_tiers WHERE id = $1`,
      [id]
    );
    if (cur.rowCount === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Tier not found');
    }
    const product_id = cur.rows[0].product_id;

    const overlap = await client.query(
      `
      SELECT 1
      FROM product_price_tiers
      WHERE product_id = $1
        AND id <> $2
        AND (
          ($3 BETWEEN min_qty AND COALESCE(max_qty, 2147483647))
          OR (COALESCE($4, 2147483647) BETWEEN min_qty AND COALESCE(max_qty, 2147483647))
          OR (min_qty BETWEEN $3 AND COALESCE($4, 2147483647))
        )
      LIMIT 1
      `,
      [product_id, id, min_qty, max_qty]
    );

    if (overlap.rowCount > 0) {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'Tier overlaps an existing tier for this product');
    }

    const upd = await client.query(
      `
      UPDATE product_price_tiers
      SET min_qty = $2, max_qty = $3, unit_price = $4
      WHERE id = $1
      RETURNING id, product_id, min_qty, max_qty, unit_price
      `,
      [id, min_qty, max_qty, unit_price.toFixed(2)]
    );

    await client.query('COMMIT');
    return handleSuccess(res, 200, 'Tier updated', upd.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return handleError(res, 400, err.message || 'Failed to update tier', err);
  } finally {
    client.release();
  }
};

const deleteTier = async (req, res) => {
  try {
    const id = toInt(req.params.id, 'id');
    const r = await pool.query(`DELETE FROM product_price_tiers WHERE id = $1 RETURNING id`, [id]);
    if (r.rowCount === 0) return handleError(res, 404, 'Tier not found');
    return handleSuccess(res, 200, 'Tier deleted', { id });
  } catch (err) {
    return handleError(res, 400, err.message);
  }
};

module.exports = { listTiersByProduct, createTier, updateTier, deleteTier };