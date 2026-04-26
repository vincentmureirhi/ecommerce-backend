'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

const VALID_RULE_TYPES = new Set(['CONSTANT', 'SKU_THRESHOLD', 'GROUP_THRESHOLD', 'TIERED']);

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

// GET /api/pricing-rules
const listPricingRules = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, rule_type, threshold_qty, description, is_active, created_at, updated_at
       FROM pricing_rules
       ORDER BY name ASC`
    );
    return handleSuccess(res, 200, 'Pricing rules retrieved', result.rows);
  } catch (err) {
    console.error('listPricingRules error:', err.message);
    return handleError(res, 500, 'Failed to retrieve pricing rules', err);
  }
};

// GET /api/pricing-rules/:id
const getPricingRule = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return handleError(res, 400, 'Invalid pricing rule id');
    }

    const result = await pool.query(
      `SELECT id, name, rule_type, threshold_qty, description, is_active, created_at, updated_at
       FROM pricing_rules WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Pricing rule not found');
    }

    return handleSuccess(res, 200, 'Pricing rule retrieved', result.rows[0]);
  } catch (err) {
    console.error('getPricingRule error:', err.message);
    return handleError(res, 500, 'Failed to retrieve pricing rule', err);
  }
};

// POST /api/pricing-rules
const createPricingRule = async (req, res) => {
  try {
    const { name, rule_type, threshold_qty, description, is_active } = req.body;

    const normalizedName = normalizeText(name);
    if (!normalizedName) {
      return handleError(res, 400, 'name is required');
    }

    const normalizedType = String(rule_type || '').trim().toUpperCase();
    if (!VALID_RULE_TYPES.has(normalizedType)) {
      return handleError(
        res,
        400,
        `rule_type must be one of: ${[...VALID_RULE_TYPES].join(', ')}`
      );
    }

    let normalizedThresholdQty = null;
    if (threshold_qty !== undefined && threshold_qty !== null && threshold_qty !== '') {
      const t = Number(threshold_qty);
      if (!Number.isInteger(t) || t < 1) {
        return handleError(res, 400, 'threshold_qty must be an integer >= 1');
      }
      normalizedThresholdQty = t;
    }

    // threshold_qty required for SKU_THRESHOLD and GROUP_THRESHOLD
    if (
      (normalizedType === 'SKU_THRESHOLD' || normalizedType === 'GROUP_THRESHOLD') &&
      normalizedThresholdQty == null
    ) {
      return handleError(
        res,
        400,
        `threshold_qty is required for rule_type ${normalizedType}`
      );
    }

    const normalizedDescription = normalizeText(description);
    const normalizedIsActive     = is_active !== false && is_active !== 'false';

    const result = await pool.query(
      `INSERT INTO pricing_rules (name, rule_type, threshold_qty, description, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, rule_type, threshold_qty, description, is_active, created_at, updated_at`,
      [normalizedName, normalizedType, normalizedThresholdQty, normalizedDescription, normalizedIsActive]
    );

    return handleSuccess(res, 201, 'Pricing rule created', result.rows[0]);
  } catch (err) {
    console.error('createPricingRule error:', err.message);
    return handleError(res, 500, 'Failed to create pricing rule', err);
  }
};

// PUT /api/pricing-rules/:id
const updatePricingRule = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return handleError(res, 400, 'Invalid pricing rule id');
    }

    const existing = await pool.query(
      'SELECT id FROM pricing_rules WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      return handleError(res, 404, 'Pricing rule not found');
    }

    const { name, rule_type, threshold_qty, description, is_active } = req.body;

    const normalizedName = normalizeText(name);
    if (!normalizedName) {
      return handleError(res, 400, 'name is required');
    }

    const normalizedType = String(rule_type || '').trim().toUpperCase();
    if (!VALID_RULE_TYPES.has(normalizedType)) {
      return handleError(
        res,
        400,
        `rule_type must be one of: ${[...VALID_RULE_TYPES].join(', ')}`
      );
    }

    let normalizedThresholdQty = null;
    if (threshold_qty !== undefined && threshold_qty !== null && threshold_qty !== '') {
      const t = Number(threshold_qty);
      if (!Number.isInteger(t) || t < 1) {
        return handleError(res, 400, 'threshold_qty must be an integer >= 1');
      }
      normalizedThresholdQty = t;
    }

    if (
      (normalizedType === 'SKU_THRESHOLD' || normalizedType === 'GROUP_THRESHOLD') &&
      normalizedThresholdQty == null
    ) {
      return handleError(
        res,
        400,
        `threshold_qty is required for rule_type ${normalizedType}`
      );
    }

    const normalizedDescription = normalizeText(description);
    const normalizedIsActive     = is_active !== false && is_active !== 'false';

    const result = await pool.query(
      `UPDATE pricing_rules
       SET name = $1, rule_type = $2, threshold_qty = $3, description = $4,
           is_active = $5, updated_at = NOW()
       WHERE id = $6
       RETURNING id, name, rule_type, threshold_qty, description, is_active, created_at, updated_at`,
      [normalizedName, normalizedType, normalizedThresholdQty, normalizedDescription, normalizedIsActive, id]
    );

    return handleSuccess(res, 200, 'Pricing rule updated', result.rows[0]);
  } catch (err) {
    console.error('updatePricingRule error:', err.message);
    return handleError(res, 500, 'Failed to update pricing rule', err);
  }
};

// DELETE /api/pricing-rules/:id
const deletePricingRule = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return handleError(res, 400, 'Invalid pricing rule id');
    }

    const existing = await pool.query(
      'SELECT id FROM pricing_rules WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      return handleError(res, 404, 'Pricing rule not found');
    }

    // Check if any products reference this rule
    const usageCheck = await pool.query(
      'SELECT COUNT(*) AS cnt FROM products WHERE pricing_rule_id = $1',
      [id]
    );
    if (Number(usageCheck.rows[0].cnt) > 0) {
      return handleError(
        res,
        409,
        'Cannot delete a pricing rule that is assigned to one or more products. ' +
        'Reassign or unassign those products first.'
      );
    }

    await pool.query('DELETE FROM pricing_rules WHERE id = $1', [id]);
    return handleSuccess(res, 200, 'Pricing rule deleted');
  } catch (err) {
    console.error('deletePricingRule error:', err.message);
    return handleError(res, 500, 'Failed to delete pricing rule', err);
  }
};

module.exports = {
  listPricingRules,
  getPricingRule,
  createPricingRule,
  updatePricingRule,
  deletePricingRule,
};
