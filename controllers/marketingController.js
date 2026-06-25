'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const { logActivity } = require('../middleware/auditMiddleware');
const {
  normalizeCouponCode,
  validateCouponForOrder,
} = require('../services/marketingCouponService');

function toPositiveInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeSlug(value, fallback = 'CAMPAIGN') {
  const source = normalizeText(value) || fallback;
  return source
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 70) || fallback;
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(value, fallback = 'draft') {
  const status = String(value || fallback).trim().toLowerCase();
  return status || fallback;
}

const listPublicCampaigns = async (req, res) => {
  try {
    const limit = toPositiveInteger(req.query.limit, 6, { min: 1, max: 20 });

    const result = await pool.query(
      `
      SELECT
        mc.*,
        COALESCE(
          json_agg(
            json_build_object(
              'id', c.id,
              'code', c.code,
              'name', c.name,
              'description', c.description,
              'discount_type', c.discount_type,
              'discount_value', c.discount_value,
              'min_order_amount', c.min_order_amount,
              'max_discount_amount', c.max_discount_amount,
              'ends_at', c.ends_at
            )
            ORDER BY c.id ASC
          ) FILTER (WHERE c.id IS NOT NULL),
          '[]'::json
        ) AS coupons
      FROM marketing_campaigns mc
      LEFT JOIN coupons c
        ON c.campaign_id = mc.id
       AND c.status = 'active'
       AND (c.starts_at IS NULL OR c.starts_at <= NOW())
       AND (c.ends_at IS NULL OR c.ends_at >= NOW())
      WHERE mc.status = 'active'
        AND (mc.starts_at IS NULL OR mc.starts_at <= NOW())
        AND (mc.ends_at IS NULL OR mc.ends_at >= NOW())
      GROUP BY mc.id
      ORDER BY mc.priority DESC, mc.created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    return handleSuccess(res, 200, 'Public campaigns retrieved', result.rows);
  } catch (err) {
    console.error('listPublicCampaigns error:', err.message);
    return handleError(res, 500, 'Failed to retrieve public campaigns', err);
  }
};

const validateCoupon = async (req, res) => {
  const client = await pool.connect();
  try {
    const validation = await validateCouponForOrder(client, req.body || {}, { lock: false });
    return handleSuccess(res, 200, 'Coupon validated', validation);
  } catch (err) {
    if (err.isCouponValidationError) {
      return handleError(res, 422, err.message, err);
    }
    console.error('validateCoupon error:', err.message);
    return handleError(res, 500, 'Failed to validate coupon', err);
  } finally {
    client.release();
  }
};

const listCampaigns = async (req, res) => {
  try {
    const page = toPositiveInteger(req.query.page, 1, { min: 1, max: 100000 });
    const limit = toPositiveInteger(req.query.limit, 30, { min: 1, max: 100 });
    const offset = (page - 1) * limit;
    const status = normalizeText(req.query.status);
    const type = normalizeText(req.query.type || req.query.campaign_type);

    const where = [];
    const params = [];
    if (status) {
      params.push(status.toLowerCase());
      where.push(`mc.status = $${params.length}`);
    }
    if (type) {
      params.push(type.toLowerCase());
      where.push(`mc.campaign_type = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM marketing_campaigns mc ${whereSql}`,
      params
    );

    params.push(limit, offset);
    const result = await pool.query(
      `
      SELECT
        mc.*,
        COUNT(DISTINCT c.id)::int AS coupon_count,
        COUNT(DISTINCT cr.id)::int AS redemption_count,
        COALESCE(SUM(cr.discount_amount), 0)::numeric(12,2) AS discount_given,
        COALESCE(SUM(cr.final_total_amount), 0)::numeric(12,2) AS attributed_revenue
      FROM marketing_campaigns mc
      LEFT JOIN coupons c ON c.campaign_id = mc.id
      LEFT JOIN coupon_redemptions cr ON cr.campaign_id = mc.id AND cr.status = 'redeemed'
      ${whereSql}
      GROUP BY mc.id
      ORDER BY mc.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    const total = Number(countResult.rows[0]?.total || 0);
    return handleSuccess(res, 200, 'Marketing campaigns retrieved', {
      campaigns: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    console.error('listCampaigns error:', err.message);
    return handleError(res, 500, 'Failed to retrieve marketing campaigns', err);
  }
};

const createCampaign = async (req, res) => {
  try {
    const body = req.body || {};
    const name = normalizeText(body.name);
    if (!name) return handleError(res, 400, 'Campaign name is required');

    const campaignCode = normalizeSlug(body.campaign_code || name, 'CAMPAIGN');

    const result = await pool.query(
      `
      INSERT INTO marketing_campaigns
        (campaign_code, name, description, campaign_type, status, customer_scope,
         starts_at, ends_at, priority, hero_title, hero_subtitle, badge_label,
         cta_label, cta_url, budget_amount, target_amount, metadata, created_by, updated_by,
         created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17::jsonb, $18, $18, NOW(), NOW())
      RETURNING *
      `,
      [
        campaignCode,
        name,
        normalizeText(body.description),
        normalizeStatus(body.campaign_type, 'general'),
        normalizeStatus(body.status, 'draft'),
        normalizeStatus(body.customer_scope, 'all'),
        normalizeDate(body.starts_at),
        normalizeDate(body.ends_at),
        Number.isInteger(Number(body.priority)) ? Number(body.priority) : 0,
        normalizeText(body.hero_title),
        normalizeText(body.hero_subtitle),
        normalizeText(body.badge_label),
        normalizeText(body.cta_label),
        normalizeText(body.cta_url),
        numberOrNull(body.budget_amount),
        numberOrNull(body.target_amount),
        JSON.stringify(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
        req.user?.id || null,
      ]
    );

    await logActivity(req.user?.id, 'create_marketing_campaign', 'marketing_campaign', result.rows[0].id, {
      campaign_code: campaignCode,
      name,
    }, { req });

    return handleSuccess(res, 201, 'Marketing campaign created', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return handleError(res, 409, 'Campaign code already exists', err);
    console.error('createCampaign error:', err.message);
    return handleError(res, 500, 'Failed to create marketing campaign', err);
  }
};

const updateCampaign = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return handleError(res, 400, 'Invalid campaign id');

    const allowed = {
      name: (v) => normalizeText(v),
      description: (v) => normalizeText(v),
      campaign_type: (v) => normalizeStatus(v, 'general'),
      status: (v) => normalizeStatus(v, 'draft'),
      customer_scope: (v) => normalizeStatus(v, 'all'),
      starts_at: (v) => normalizeDate(v),
      ends_at: (v) => normalizeDate(v),
      priority: (v) => Number.isInteger(Number(v)) ? Number(v) : 0,
      hero_title: (v) => normalizeText(v),
      hero_subtitle: (v) => normalizeText(v),
      badge_label: (v) => normalizeText(v),
      cta_label: (v) => normalizeText(v),
      cta_url: (v) => normalizeText(v),
      budget_amount: (v) => numberOrNull(v),
      target_amount: (v) => numberOrNull(v),
      metadata: (v) => JSON.stringify(v && typeof v === 'object' ? v : {}),
    };

    const fields = [];
    const params = [];
    for (const [key, normalizer] of Object.entries(allowed)) {
      if (!(key in req.body)) continue;
      params.push(normalizer(req.body[key]));
      fields.push(`${key} = $${params.length}${key === 'metadata' ? '::jsonb' : ''}`);
    }

    if (!fields.length) return handleError(res, 400, 'No valid campaign fields were provided');

    params.push(req.user?.id || null);
    fields.push(`updated_by = $${params.length}`);
    fields.push('updated_at = NOW()');
    params.push(id);

    const result = await pool.query(
      `UPDATE marketing_campaigns SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (!result.rows[0]) return handleError(res, 404, 'Marketing campaign not found');

    await logActivity(req.user?.id, 'update_marketing_campaign', 'marketing_campaign', id, {
      fields: Object.keys(req.body || {}),
    }, { req });

    return handleSuccess(res, 200, 'Marketing campaign updated', result.rows[0]);
  } catch (err) {
    console.error('updateCampaign error:', err.message);
    return handleError(res, 500, 'Failed to update marketing campaign', err);
  }
};

const listCoupons = async (req, res) => {
  try {
    const page = toPositiveInteger(req.query.page, 1, { min: 1, max: 100000 });
    const limit = toPositiveInteger(req.query.limit, 30, { min: 1, max: 100 });
    const offset = (page - 1) * limit;
    const status = normalizeText(req.query.status);

    const where = [];
    const params = [];
    if (status) {
      params.push(status.toLowerCase());
      where.push(`c.status = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM coupons c ${whereSql}`, params);
    params.push(limit, offset);

    const result = await pool.query(
      `
      SELECT
        c.*,
        mc.campaign_code,
        mc.name AS campaign_name,
        COUNT(cr.id)::int AS redemption_count,
        COALESCE(SUM(cr.discount_amount), 0)::numeric(12,2) AS discount_given,
        COALESCE(SUM(cr.final_total_amount), 0)::numeric(12,2) AS attributed_revenue
      FROM coupons c
      LEFT JOIN marketing_campaigns mc ON mc.id = c.campaign_id
      LEFT JOIN coupon_redemptions cr ON cr.coupon_id = c.id AND cr.status = 'redeemed'
      ${whereSql}
      GROUP BY c.id, mc.id
      ORDER BY c.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    const total = Number(countResult.rows[0]?.total || 0);
    return handleSuccess(res, 200, 'Coupons retrieved', {
      coupons: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    console.error('listCoupons error:', err.message);
    return handleError(res, 500, 'Failed to retrieve coupons', err);
  }
};

const createCoupon = async (req, res) => {
  try {
    const body = req.body || {};
    const code = normalizeCouponCode(body.code);
    const name = normalizeText(body.name);
    const discountType = normalizeStatus(body.discount_type, 'percentage');
    const discountValue = numberOrNull(body.discount_value);

    if (!code) return handleError(res, 400, 'Coupon code is required');
    if (!name) return handleError(res, 400, 'Coupon name is required');
    if (!discountValue || discountValue <= 0) return handleError(res, 400, 'discount_value must be greater than zero');

    const result = await pool.query(
      `
      INSERT INTO coupons
        (campaign_id, code, name, description, status, discount_type, discount_value,
         max_discount_amount, min_order_amount, customer_scope, applies_to, starts_at, ends_at,
         max_total_uses, max_uses_per_customer, max_uses_per_phone, stackable, metadata,
         created_by, updated_by, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18::jsonb,
         $19, $19, NOW(), NOW())
      RETURNING *
      `,
      [
        numberOrNull(body.campaign_id),
        code,
        name,
        normalizeText(body.description),
        normalizeStatus(body.status, 'draft'),
        discountType,
        discountValue,
        numberOrNull(body.max_discount_amount),
        numberOrNull(body.min_order_amount) || 0,
        normalizeStatus(body.customer_scope, 'all'),
        normalizeStatus(body.applies_to, 'all'),
        normalizeDate(body.starts_at),
        normalizeDate(body.ends_at),
        body.max_total_uses == null || body.max_total_uses === '' ? null : Number(body.max_total_uses),
        body.max_uses_per_customer == null || body.max_uses_per_customer === '' ? null : Number(body.max_uses_per_customer),
        body.max_uses_per_phone == null || body.max_uses_per_phone === '' ? null : Number(body.max_uses_per_phone),
        Boolean(body.stackable),
        JSON.stringify(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
        req.user?.id || null,
      ]
    );

    await logActivity(req.user?.id, 'create_coupon', 'coupon', result.rows[0].id, {
      code,
      name,
    }, { req });

    return handleSuccess(res, 201, 'Coupon created', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return handleError(res, 409, 'Coupon code already exists', err);
    console.error('createCoupon error:', err.message);
    return handleError(res, 500, 'Failed to create coupon', err);
  }
};

const updateCoupon = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return handleError(res, 400, 'Invalid coupon id');

    const allowed = {
      campaign_id: (v) => numberOrNull(v),
      code: (v) => normalizeCouponCode(v),
      name: (v) => normalizeText(v),
      description: (v) => normalizeText(v),
      status: (v) => normalizeStatus(v, 'draft'),
      discount_type: (v) => normalizeStatus(v, 'percentage'),
      discount_value: (v) => numberOrNull(v),
      max_discount_amount: (v) => numberOrNull(v),
      min_order_amount: (v) => numberOrNull(v) || 0,
      customer_scope: (v) => normalizeStatus(v, 'all'),
      applies_to: (v) => normalizeStatus(v, 'all'),
      starts_at: (v) => normalizeDate(v),
      ends_at: (v) => normalizeDate(v),
      max_total_uses: (v) => v == null || v === '' ? null : Number(v),
      max_uses_per_customer: (v) => v == null || v === '' ? null : Number(v),
      max_uses_per_phone: (v) => v == null || v === '' ? null : Number(v),
      stackable: (v) => Boolean(v),
      metadata: (v) => JSON.stringify(v && typeof v === 'object' ? v : {}),
    };

    const fields = [];
    const params = [];
    for (const [key, normalizer] of Object.entries(allowed)) {
      if (!(key in req.body)) continue;
      params.push(normalizer(req.body[key]));
      fields.push(`${key} = $${params.length}${key === 'metadata' ? '::jsonb' : ''}`);
    }

    if (!fields.length) return handleError(res, 400, 'No valid coupon fields were provided');

    params.push(req.user?.id || null);
    fields.push(`updated_by = $${params.length}`);
    fields.push('updated_at = NOW()');
    params.push(id);

    const result = await pool.query(
      `UPDATE coupons SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (!result.rows[0]) return handleError(res, 404, 'Coupon not found');

    await logActivity(req.user?.id, 'update_coupon', 'coupon', id, {
      fields: Object.keys(req.body || {}),
    }, { req });

    return handleSuccess(res, 200, 'Coupon updated', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return handleError(res, 409, 'Coupon code already exists', err);
    console.error('updateCoupon error:', err.message);
    return handleError(res, 500, 'Failed to update coupon', err);
  }
};

module.exports = {
  listPublicCampaigns,
  validateCoupon,
  listCampaigns,
  createCampaign,
  updateCampaign,
  listCoupons,
  createCoupon,
  updateCoupon,
};