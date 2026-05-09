'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

const VALID_RULE_TYPES = ['CONSTANT', 'SKU_THRESHOLD', 'GROUP_THRESHOLD', 'TIERED'];

// GET ALL PRICING RULES
const getAllPricingRules = async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM pricing_rules ORDER BY id DESC`);
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
    const r = await pool.query(`SELECT * FROM pricing_rules WHERE id = $1`, [id]);
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

    const r = await pool.query(
      `INSERT INTO pricing_rules (name, description, rule_type, threshold_qty, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, description, ruleType, thresholdQty, isActive]
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

    const r = await pool.query(
      `UPDATE pricing_rules
       SET name=$1, description=$2, rule_type=$3, threshold_qty=$4, is_active=$5,
           updated_at=NOW()
       WHERE id=$6
       RETURNING *`,
      [name, description, ruleType, thresholdQty, isActive, id]
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

module.exports = {
  getAllPricingRules,
  getPricingRuleById,
  createPricingRule,
  updatePricingRule,
  deletePricingRule,
};
