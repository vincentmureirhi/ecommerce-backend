'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

// ─────────────────────────────────────────────────────────────────────────────
// Pricing Groups — CRUD
// ─────────────────────────────────────────────────────────────────────────────

// GET ALL PRICING GROUPS
const getAllPricingGroups = async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        pg.*,
        COUNT(pgp.product_id) FILTER (WHERE pgp.is_active = TRUE) AS product_count
      FROM pricing_groups pg
      LEFT JOIN pricing_group_products pgp ON pgp.pricing_group_id = pg.id
      GROUP BY pg.id
      ORDER BY pg.id DESC
    `);
    return handleSuccess(res, 200, 'Pricing groups retrieved', r.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve pricing groups', err);
  }
};

// GET PRICING GROUP BY ID
const getPricingGroupById = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return handleError(res, 400, 'Invalid id');
    }

    const r = await pool.query(
      `SELECT * FROM pricing_groups WHERE id = $1`,
      [id]
    );
    if (r.rowCount === 0) return handleError(res, 404, 'Pricing group not found');

    // Also fetch members
    const members = await pool.query(
      `
      SELECT
        pgp.product_id,
        pgp.is_active,
        pgp.effective_from,
        pgp.effective_until,
        pgp.created_at,
        p.name AS product_name,
        p.sku
      FROM pricing_group_products pgp
      JOIN products p ON p.id = pgp.product_id
      WHERE pgp.pricing_group_id = $1
      ORDER BY p.name ASC
      `,
      [id]
    );

    const group = r.rows[0];
    group.products = members.rows;

    return handleSuccess(res, 200, 'Pricing group retrieved', group);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve pricing group', err);
  }
};

// CREATE PRICING GROUP
const createPricingGroup = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return handleError(res, 400, 'name is required');

    const description = req.body.description
      ? String(req.body.description).trim()
      : null;
    const isActive =
      req.body.is_active !== undefined ? Boolean(req.body.is_active) : true;

    const r = await pool.query(
      `INSERT INTO pricing_groups (name, description, is_active)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, description, isActive]
    );

    return handleSuccess(res, 201, 'Pricing group created', r.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to create pricing group', err);
  }
};

// UPDATE PRICING GROUP
const updatePricingGroup = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return handleError(res, 400, 'Invalid id');
    }

    const existing = await pool.query(
      `SELECT * FROM pricing_groups WHERE id = $1`,
      [id]
    );
    if (existing.rowCount === 0) return handleError(res, 404, 'Pricing group not found');

    const name = String(req.body.name || '').trim();
    if (!name) return handleError(res, 400, 'name is required');

    const description = req.body.description
      ? String(req.body.description).trim()
      : null;
    const isActive =
      req.body.is_active !== undefined
        ? Boolean(req.body.is_active)
        : existing.rows[0].is_active;

    const r = await pool.query(
      `UPDATE pricing_groups
       SET name=$1, description=$2, is_active=$3, updated_at=NOW()
       WHERE id=$4
       RETURNING *`,
      [name, description, isActive, id]
    );

    return handleSuccess(res, 200, 'Pricing group updated', r.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to update pricing group', err);
  }
};

// DELETE PRICING GROUP
const deletePricingGroup = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return handleError(res, 400, 'Invalid id');
    }
    const r = await pool.query(`DELETE FROM pricing_groups WHERE id = $1`, [id]);
    if (r.rowCount === 0) return handleError(res, 404, 'Pricing group not found');
    return handleSuccess(res, 200, 'Pricing group deleted');
  } catch (err) {
    return handleError(res, 500, 'Failed to delete pricing group', err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Group membership management
// ─────────────────────────────────────────────────────────────────────────────

// GET PRODUCTS IN A GROUP
const getGroupProducts = async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      return handleError(res, 400, 'Invalid group id');
    }

    const groupCheck = await pool.query(`SELECT id FROM pricing_groups WHERE id = $1`, [groupId]);
    if (groupCheck.rowCount === 0) return handleError(res, 404, 'Pricing group not found');

    const r = await pool.query(
      `
      SELECT
        pgp.product_id,
        pgp.is_active,
        pgp.effective_from,
        pgp.effective_until,
        pgp.created_at,
        p.name AS product_name,
        p.sku,
        p.retail_price,
        p.wholesale_price,
        p.min_qty_wholesale
      FROM pricing_group_products pgp
      JOIN products p ON p.id = pgp.product_id
      WHERE pgp.pricing_group_id = $1
      ORDER BY p.name ASC
      `,
      [groupId]
    );

    return handleSuccess(res, 200, 'Group products retrieved', r.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve group products', err);
  }
};

// ADD A PRODUCT TO A GROUP
const addProductToGroup = async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      return handleError(res, 400, 'Invalid group id');
    }

    const productId = Number(req.body.product_id);
    if (!Number.isInteger(productId) || productId <= 0) {
      return handleError(res, 400, 'product_id must be a positive integer');
    }

    const isActive =
      req.body.is_active !== undefined ? Boolean(req.body.is_active) : true;
    const effectiveFrom = req.body.effective_from || null;
    const effectiveUntil = req.body.effective_until || null;

    // Validate group exists
    const groupCheck = await pool.query(`SELECT id FROM pricing_groups WHERE id = $1`, [groupId]);
    if (groupCheck.rowCount === 0) return handleError(res, 404, 'Pricing group not found');

    // Validate product exists
    const productCheck = await pool.query(`SELECT id FROM products WHERE id = $1`, [productId]);
    if (productCheck.rowCount === 0) return handleError(res, 404, 'Product not found');

    const r = await pool.query(
      `
      INSERT INTO pricing_group_products
        (pricing_group_id, product_id, is_active, effective_from, effective_until)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (pricing_group_id, product_id) DO UPDATE
        SET is_active = EXCLUDED.is_active,
            effective_from = EXCLUDED.effective_from,
            effective_until = EXCLUDED.effective_until
      RETURNING *
      `,
      [groupId, productId, isActive, effectiveFrom, effectiveUntil]
    );

    return handleSuccess(res, 201, 'Product added to group', r.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to add product to group', err);
  }
};

// UPDATE PRODUCT MEMBERSHIP IN A GROUP
const updateGroupProduct = async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    const productId = Number(req.params.product_id);

    if (!Number.isInteger(groupId) || groupId <= 0) {
      return handleError(res, 400, 'Invalid group id');
    }
    if (!Number.isInteger(productId) || productId <= 0) {
      return handleError(res, 400, 'Invalid product id');
    }

    const existing = await pool.query(
      `SELECT * FROM pricing_group_products WHERE pricing_group_id = $1 AND product_id = $2`,
      [groupId, productId]
    );
    if (existing.rowCount === 0) {
      return handleError(res, 404, 'Product is not in this group');
    }

    const isActive =
      req.body.is_active !== undefined
        ? Boolean(req.body.is_active)
        : existing.rows[0].is_active;
    const effectiveFrom =
      Object.prototype.hasOwnProperty.call(req.body, 'effective_from')
        ? (req.body.effective_from || null)
        : existing.rows[0].effective_from;
    const effectiveUntil =
      Object.prototype.hasOwnProperty.call(req.body, 'effective_until')
        ? (req.body.effective_until || null)
        : existing.rows[0].effective_until;

    const r = await pool.query(
      `
      UPDATE pricing_group_products
      SET is_active=$3, effective_from=$4, effective_until=$5
      WHERE pricing_group_id=$1 AND product_id=$2
      RETURNING *
      `,
      [groupId, productId, isActive, effectiveFrom, effectiveUntil]
    );

    return handleSuccess(res, 200, 'Group membership updated', r.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to update group membership', err);
  }
};

// REMOVE A PRODUCT FROM A GROUP
const removeProductFromGroup = async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    const productId = Number(req.params.product_id);

    if (!Number.isInteger(groupId) || groupId <= 0) {
      return handleError(res, 400, 'Invalid group id');
    }
    if (!Number.isInteger(productId) || productId <= 0) {
      return handleError(res, 400, 'Invalid product id');
    }

    const r = await pool.query(
      `DELETE FROM pricing_group_products
       WHERE pricing_group_id = $1 AND product_id = $2`,
      [groupId, productId]
    );
    if (r.rowCount === 0) {
      return handleError(res, 404, 'Product is not in this group');
    }
    return handleSuccess(res, 200, 'Product removed from group');
  } catch (err) {
    return handleError(res, 500, 'Failed to remove product from group', err);
  }
};

module.exports = {
  getAllPricingGroups,
  getPricingGroupById,
  createPricingGroup,
  updatePricingGroup,
  deletePricingGroup,
  getGroupProducts,
  addProductToGroup,
  updateGroupProduct,
  removeProductFromGroup,
};
