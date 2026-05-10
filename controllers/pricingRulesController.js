'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const Decimal = require('decimal.js');

const VALID_RULE_TYPES = [
  'CONSTANT',
  'SKU_THRESHOLD',
  'GROUP_THRESHOLD',
  'TIERED',
  'FIXED_UNIT',
  'SKU_TIERED',
  'GROUP_TIERED',
];

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
  if (!d.isFinite() || d.lt(0)) throw new Error(`${field} must be a number >= 0`);
  return d.toDecimalPlaces(2);
}

// GET ALL PRICING RULES
const getAllPricingRules = async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT pr.*, pg.name AS pricing_group_name
      FROM pricing_rules pr
      LEFT JOIN pricing_groups pg ON pg.id = pr.pricing_group_id
      ORDER BY pr.id DESC
    `);
    return handleSuccess(res, 200, 'Pricing rules retrieved', r.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve pricing rules', err);
  }
};

// GET PRICING RULE BY ID
const getPricingRuleById = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return handleError(res, 400, 'Invalid id');
    }
    const r = await pool.query(`
      SELECT pr.*, pg.name AS pricing_group_name
      FROM pricing_rules pr
      LEFT JOIN pricing_groups pg ON pg.id = pr.pricing_group_id
      WHERE pr.id = $1
    `, [id]);
    if (r.rowCount === 0) return handleError(res, 404, 'Pricing rule not found');
    return handleSuccess(res, 200, 'Pricing rule retrieved', r.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve pricing rule', err);
  }
};

// CREATE PRICING RULE
const createPricingRule = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return handleError(res, 400, 'name is required');

    const ruleType = String(req.body.rule_type || '').trim().toUpperCase();
    if (!VALID_RULE_TYPES.includes(ruleType)) {
      return handleError(
        res,
        400,
        `rule_type must be one of: ${VALID_RULE_TYPES.join(', ')}`
      );
    }

    const description = req.body.description
      ? String(req.body.description).trim()
      : null;
    const isActive =
      req.body.is_active !== undefined ? Boolean(req.body.is_active) : true;

    let thresholdQty = null;
    if (req.body.threshold_qty != null && req.body.threshold_qty !== '') {
      thresholdQty = Number(req.body.threshold_qty);
      if (!Number.isInteger(thresholdQty) || thresholdQty < 1) {
        return handleError(res, 400, 'threshold_qty must be an integer >= 1');
      }
    }

    let pricingGroupId = null;
    if (req.body.pricing_group_id != null && req.body.pricing_group_id !== '') {
      pricingGroupId = Number(req.body.pricing_group_id);
      if (!Number.isInteger(pricingGroupId) || pricingGroupId < 1) {
        return handleError(res, 400, 'pricing_group_id must be a positive integer');
      }
    }

    const r = await pool.query(
      `INSERT INTO pricing_rules (name, description, rule_type, threshold_qty, is_active, pricing_group_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, description, ruleType, thresholdQty, isActive, pricingGroupId]
    );

    return handleSuccess(res, 201, 'Pricing rule created', r.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to create pricing rule', err);
  }
};

// UPDATE PRICING RULE
const updatePricingRule = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return handleError(res, 400, 'Invalid id');
    }

    const existing = await pool.query(
      `SELECT * FROM pricing_rules WHERE id = $1`,
      [id]
    );
    if (existing.rowCount === 0) return handleError(res, 404, 'Pricing rule not found');

    const name = String(req.body.name || '').trim();
    if (!name) return handleError(res, 400, 'name is required');

    const ruleType = String(req.body.rule_type || '').trim().toUpperCase();
    if (!VALID_RULE_TYPES.includes(ruleType)) {
      return handleError(
        res,
        400,
        `rule_type must be one of: ${VALID_RULE_TYPES.join(', ')}`
      );
    }

    const description = req.body.description
      ? String(req.body.description).trim()
      : null;
    const isActive =
      req.body.is_active !== undefined
        ? Boolean(req.body.is_active)
        : existing.rows[0].is_active;

    let thresholdQty = null;
    if (req.body.threshold_qty != null && req.body.threshold_qty !== '') {
      thresholdQty = Number(req.body.threshold_qty);
      if (!Number.isInteger(thresholdQty) || thresholdQty < 1) {
        return handleError(res, 400, 'threshold_qty must be an integer >= 1');
      }
    }

    let pricingGroupId = existing.rows[0].pricing_group_id;
    if (Object.prototype.hasOwnProperty.call(req.body, 'pricing_group_id')) {
      if (req.body.pricing_group_id == null || req.body.pricing_group_id === '') {
        pricingGroupId = null;
      } else {
        pricingGroupId = Number(req.body.pricing_group_id);
        if (!Number.isInteger(pricingGroupId) || pricingGroupId < 1) {
          return handleError(res, 400, 'pricing_group_id must be a positive integer');
        }
      }
    }

    const r = await pool.query(
      `UPDATE pricing_rules
       SET name=$1, description=$2, rule_type=$3, threshold_qty=$4, is_active=$5,
           pricing_group_id=$6, updated_at=NOW()
       WHERE id=$7
       RETURNING *`,
      [name, description, ruleType, thresholdQty, isActive, pricingGroupId, id]
    );

    return handleSuccess(res, 200, 'Pricing rule updated', r.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to update pricing rule', err);
  }
};

// DELETE PRICING RULE
const deletePricingRule = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return handleError(res, 400, 'Invalid id');
    }
    const r = await pool.query(`DELETE FROM pricing_rules WHERE id = $1`, [id]);
    if (r.rowCount === 0) return handleError(res, 404, 'Pricing rule not found');
    return handleSuccess(res, 200, 'Pricing rule deleted');
  } catch (err) {
    return handleError(res, 500, 'Failed to delete pricing rule', err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Rule-level tier management (pricing_rule_tiers)
// Used by SKU_TIERED and GROUP_TIERED rule types.
// ─────────────────────────────────────────────────────────────────────────────

// GET TIERS FOR A RULE
const getRuleTiers = async (req, res) => {
  try {
    const ruleId = toInt(req.params.id, 'rule id');
    const r = await pool.query(
      `SELECT id, pricing_rule_id, min_qty, max_qty, unit_price
       FROM pricing_rule_tiers
       WHERE pricing_rule_id = $1
       ORDER BY min_qty ASC`,
      [ruleId]
    );
    return handleSuccess(res, 200, 'Rule tiers retrieved', r.rows);
  } catch (err) {
    return handleError(res, 400, err.message || 'Failed to retrieve rule tiers');
  }
};

// CREATE A RULE TIER
const createRuleTier = async (req, res) => {
  const client = await pool.connect();
  try {
    const ruleId = toInt(req.params.id, 'rule id');
    const minQty = toInt(req.body.min_qty, 'min_qty');
    const maxQty = toNullableInt(req.body.max_qty, 'max_qty');
    const unitPrice = toMoney(req.body.unit_price, 'unit_price');

    if (maxQty != null && maxQty < minQty) {
      return handleError(res, 400, 'max_qty must be >= min_qty');
    }

    await client.query('BEGIN');

    // Verify rule exists
    const ruleCheck = await client.query(`SELECT id FROM pricing_rules WHERE id = $1`, [ruleId]);
    if (ruleCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Pricing rule not found');
    }

    // Overlap check
    const overlap = await client.query(
      `
      SELECT 1
      FROM pricing_rule_tiers
      WHERE pricing_rule_id = $1
        AND (
          ($2 BETWEEN min_qty AND COALESCE(max_qty, 2147483647))
          OR (COALESCE($3, 2147483647) BETWEEN min_qty AND COALESCE(max_qty, 2147483647))
          OR (min_qty BETWEEN $2 AND COALESCE($3, 2147483647))
        )
      LIMIT 1
      `,
      [ruleId, minQty, maxQty]
    );
    if (overlap.rowCount > 0) {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'Tier overlaps an existing tier for this rule');
    }

    const ins = await client.query(
      `INSERT INTO pricing_rule_tiers (pricing_rule_id, min_qty, max_qty, unit_price)
       VALUES ($1, $2, $3, $4)
       RETURNING id, pricing_rule_id, min_qty, max_qty, unit_price`,
      [ruleId, minQty, maxQty, unitPrice.toFixed(2)]
    );

    await client.query('COMMIT');
    return handleSuccess(res, 201, 'Rule tier created', ins.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return handleError(res, 400, err.message || 'Failed to create rule tier', err);
  } finally {
    client.release();
  }
};

// UPDATE A RULE TIER
const updateRuleTier = async (req, res) => {
  const client = await pool.connect();
  try {
    const tierId = toInt(req.params.tier_id, 'tier_id');
    const ruleId = toInt(req.params.id, 'rule id');
    const minQty = toInt(req.body.min_qty, 'min_qty');
    const maxQty = toNullableInt(req.body.max_qty, 'max_qty');
    const unitPrice = toMoney(req.body.unit_price, 'unit_price');

    if (maxQty != null && maxQty < minQty) {
      return handleError(res, 400, 'max_qty must be >= min_qty');
    }

    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT id FROM pricing_rule_tiers WHERE id = $1 AND pricing_rule_id = $2`,
      [tierId, ruleId]
    );
    if (cur.rowCount === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Rule tier not found');
    }

    const overlap = await client.query(
      `
      SELECT 1
      FROM pricing_rule_tiers
      WHERE pricing_rule_id = $1
        AND id <> $2
        AND (
          ($3 BETWEEN min_qty AND COALESCE(max_qty, 2147483647))
          OR (COALESCE($4, 2147483647) BETWEEN min_qty AND COALESCE(max_qty, 2147483647))
          OR (min_qty BETWEEN $3 AND COALESCE($4, 2147483647))
        )
      LIMIT 1
      `,
      [ruleId, tierId, minQty, maxQty]
    );
    if (overlap.rowCount > 0) {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'Tier overlaps an existing tier for this rule');
    }

    const upd = await client.query(
      `UPDATE pricing_rule_tiers
       SET min_qty=$2, max_qty=$3, unit_price=$4, updated_at=NOW()
       WHERE id=$1
       RETURNING id, pricing_rule_id, min_qty, max_qty, unit_price`,
      [tierId, minQty, maxQty, unitPrice.toFixed(2)]
    );

    await client.query('COMMIT');
    return handleSuccess(res, 200, 'Rule tier updated', upd.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return handleError(res, 400, err.message || 'Failed to update rule tier', err);
  } finally {
    client.release();
  }
};

// DELETE A RULE TIER
const deleteRuleTier = async (req, res) => {
  try {
    const tierId = toInt(req.params.tier_id, 'tier_id');
    const ruleId = toInt(req.params.id, 'rule id');
    const r = await pool.query(
      `DELETE FROM pricing_rule_tiers WHERE id = $1 AND pricing_rule_id = $2 RETURNING id`,
      [tierId, ruleId]
    );
    if (r.rowCount === 0) return handleError(res, 404, 'Rule tier not found');
    return handleSuccess(res, 200, 'Rule tier deleted', { id: tierId });
  } catch (err) {
    return handleError(res, 400, err.message || 'Failed to delete rule tier');
  }
};

module.exports = {
  getAllPricingRules,
  getPricingRuleById,
  createPricingRule,
  updatePricingRule,
  deletePricingRule,
  getRuleTiers,
  createRuleTier,
  updateRuleTier,
  deleteRuleTier,
};
