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

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
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
        ) AS coupons,
        COALESCE((SELECT json_agg(mcp.product_id ORDER BY mcp.product_id) FROM marketing_campaign_products mcp WHERE mcp.campaign_id = mc.id), '[]'::json) AS product_ids,
        COALESCE((SELECT json_agg(mcc.category_id ORDER BY mcc.category_id) FROM marketing_campaign_categories mcc WHERE mcc.campaign_id = mc.id), '[]'::json) AS category_ids,
        COALESCE((SELECT json_agg(mcr.region_id ORDER BY mcr.region_id) FROM marketing_campaign_regions mcr WHERE mcr.campaign_id = mc.id), '[]'::json) AS region_ids
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
        COALESCE(coupon_stats.coupon_count, 0)::int AS coupon_count,
        COALESCE(sales.redemption_count, 0)::int AS redemption_count,
        COALESCE(sales.discount_given, 0)::numeric(12,2) AS discount_given,
        COALESCE(sales.attributed_revenue, 0)::numeric(12,2) AS attributed_revenue
      FROM marketing_campaigns mc
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS coupon_count FROM coupons c WHERE c.campaign_id = mc.id
      ) coupon_stats ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS redemption_count,
          SUM(cr.discount_amount) AS discount_given,
          SUM(cr.final_total_amount) AS attributed_revenue
        FROM coupon_redemptions cr
        WHERE cr.campaign_id = mc.id AND cr.status = 'redeemed'
      ) sales ON TRUE
      ${whereSql}
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
         cta_label, cta_url, budget_amount, target_amount, metadata,
         placement, hero_image_url, accent_color, auto_activate, auto_expire,
         sms_enabled, sms_message, sms_audience, created_by, updated_by,
         created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22,
         $23, $24, $25, $26, $26, NOW(), NOW())
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
        normalizeStatus(body.placement, 'home'),
        normalizeText(body.hero_image_url),
        normalizeText(body.accent_color),
        normalizeBoolean(body.auto_activate, false),
        normalizeBoolean(body.auto_expire, true),
        normalizeBoolean(body.sms_enabled, false),
        normalizeText(body.sms_message),
        normalizeStatus(body.sms_audience, 'campaign_scope'),
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
      placement: (v) => normalizeStatus(v, 'home'),
      hero_image_url: (v) => normalizeText(v),
      accent_color: (v) => normalizeText(v),
      auto_activate: (v) => normalizeBoolean(v, false),
      auto_expire: (v) => normalizeBoolean(v, true),
      sms_enabled: (v) => normalizeBoolean(v, false),
      sms_message: (v) => normalizeText(v),
      sms_audience: (v) => normalizeStatus(v, 'campaign_scope'),
      sms_queued_at: (v) => normalizeDate(v),
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

const trackCampaignEvent = async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const eventType = normalizeStatus(req.body?.event_type, 'impression');
    if (!Number.isInteger(campaignId) || campaignId <= 0) return handleError(res, 400, 'Invalid campaign id');
    if (!['impression', 'click'].includes(eventType)) return handleError(res, 400, 'Invalid campaign event type');

    const sessionId = String(req.body?.session_id || '').trim().slice(0, 120) || null;
    const sourcePath = String(req.body?.source_path || '').trim().slice(0, 500) || null;
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
    const result = await pool.query(
      `
      INSERT INTO marketing_campaign_events
        (campaign_id, event_type, session_id, source_path, request_id, metadata, created_at)
      SELECT mc.id, $2::varchar(30), $3::varchar(120), $4::text, $5::varchar(120), $6::jsonb, NOW()
      FROM marketing_campaigns mc
      WHERE mc.id = $1
        AND mc.status = 'active'
        AND (mc.starts_at IS NULL OR mc.starts_at <= NOW())
        AND (mc.ends_at IS NULL OR mc.ends_at > NOW())
        AND (
          $3::varchar(120) IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM marketing_campaign_events existing
            WHERE existing.campaign_id = mc.id
              AND existing.event_type = $2::varchar(30)
              AND existing.session_id = $3::varchar(120)
              AND existing.created_at >= NOW() - INTERVAL '6 hours'
          )
        )
      RETURNING id
      `,
      [campaignId, eventType, sessionId, sourcePath, req.requestId || null, JSON.stringify(metadata)]
    );

    return handleSuccess(res, 202, 'Campaign event accepted', { recorded: Boolean(result.rows[0]) });
  } catch (err) {
    console.error('trackCampaignEvent error:', err.message);
    return handleError(res, 500, 'Failed to record campaign event', err);
  }
};

const getCampaignTargets = async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    if (!Number.isInteger(campaignId) || campaignId <= 0) return handleError(res, 400, 'Invalid campaign id');
    const [campaign, products, categories, regions] = await Promise.all([
      pool.query('SELECT id, name, campaign_code FROM marketing_campaigns WHERE id = $1', [campaignId]),
      pool.query(`SELECT p.id, p.name, p.sku FROM marketing_campaign_products target INNER JOIN products p ON p.id = target.product_id WHERE target.campaign_id = $1 ORDER BY p.name`, [campaignId]),
      pool.query(`SELECT c.id, c.name FROM marketing_campaign_categories target INNER JOIN categories c ON c.id = target.category_id WHERE target.campaign_id = $1 ORDER BY c.name`, [campaignId]),
      pool.query(`SELECT r.id, r.name FROM marketing_campaign_regions target INNER JOIN regions r ON r.id = target.region_id WHERE target.campaign_id = $1 ORDER BY r.name`, [campaignId]),
    ]);
    if (!campaign.rows[0]) return handleError(res, 404, 'Marketing campaign not found');
    return handleSuccess(res, 200, 'Campaign targets retrieved', {
      campaign: campaign.rows[0],
      products: products.rows,
      categories: categories.rows,
      regions: regions.rows,
    });
  } catch (err) {
    console.error('getCampaignTargets error:', err.message);
    return handleError(res, 500, 'Failed to retrieve campaign targets', err);
  }
};

const replaceCampaignTargets = async (req, res) => {
  const client = await pool.connect();
  try {
    const campaignId = Number(req.params.id);
    if (!Number.isInteger(campaignId) || campaignId <= 0) return handleError(res, 400, 'Invalid campaign id');
    const productIds = normalizeIdList(req.body?.product_ids);
    const categoryIds = normalizeIdList(req.body?.category_ids);
    const regionIds = normalizeIdList(req.body?.region_ids);
    await client.query('BEGIN');
    const campaign = await client.query('SELECT id FROM marketing_campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
    if (!campaign.rows[0]) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Marketing campaign not found');
    }
    await Promise.all([
      client.query('DELETE FROM marketing_campaign_products WHERE campaign_id = $1', [campaignId]),
      client.query('DELETE FROM marketing_campaign_categories WHERE campaign_id = $1', [campaignId]),
      client.query('DELETE FROM marketing_campaign_regions WHERE campaign_id = $1', [campaignId]),
    ]);
    if (productIds.length) {
      await client.query(`INSERT INTO marketing_campaign_products (campaign_id, product_id) SELECT $1, p.id FROM products p WHERE p.id = ANY($2::int[]) ON CONFLICT DO NOTHING`, [campaignId, productIds]);
    }
    if (categoryIds.length) {
      await client.query(`INSERT INTO marketing_campaign_categories (campaign_id, category_id) SELECT $1, c.id FROM categories c WHERE c.id = ANY($2::int[]) ON CONFLICT DO NOTHING`, [campaignId, categoryIds]);
    }
    if (regionIds.length) {
      await client.query(`INSERT INTO marketing_campaign_regions (campaign_id, region_id) SELECT $1, r.id FROM regions r WHERE r.id = ANY($2::int[]) ON CONFLICT DO NOTHING`, [campaignId, regionIds]);
    }
    const hasProductTargets = productIds.length > 0;
    const hasCategoryTargets = categoryIds.length > 0;
    await client.query(
      `UPDATE coupons SET applies_to = $2, updated_at = NOW() WHERE campaign_id = $1`,
      [campaignId, hasProductTargets || hasCategoryTargets ? 'campaign_targets' : 'all']
    );
    await client.query('COMMIT');
    await logActivity(req.user?.id, 'replace_marketing_campaign_targets', 'marketing_campaign', campaignId, {
      product_ids: productIds,
      category_ids: categoryIds,
      region_ids: regionIds,
    }, { req });
    req.params.id = String(campaignId);
    return getCampaignTargets(req, res);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('replaceCampaignTargets error:', err.message);
    return handleError(res, 500, 'Failed to save campaign targets', err);
  } finally {
    client.release();
  }
};

const getMarketingAnalytics = async (req, res) => {
  try {
    const days = toPositiveInteger(req.query.days, 30, { min: 1, max: 365 });
    const [summary, campaigns, coupons, daily, automation] = await Promise.all([
      pool.query(
        `
        SELECT
          (SELECT COUNT(*) FROM marketing_campaigns WHERE status = 'active')::int AS active_campaigns,
          (SELECT COUNT(*) FROM marketing_campaign_events WHERE event_type = 'impression' AND created_at >= NOW() - ($1::int * INTERVAL '1 day'))::int AS impressions,
          (SELECT COUNT(*) FROM marketing_campaign_events WHERE event_type = 'click' AND created_at >= NOW() - ($1::int * INTERVAL '1 day'))::int AS clicks,
          COUNT(cr.id)::int AS conversions,
          COALESCE(SUM(cr.discount_amount), 0)::numeric(14,2) AS discount_given,
          COALESCE(SUM(cr.final_total_amount), 0)::numeric(14,2) AS attributed_revenue,
          COALESCE(AVG(cr.final_total_amount), 0)::numeric(14,2) AS average_order_value
        FROM coupon_redemptions cr
        WHERE cr.status = 'redeemed' AND cr.redeemed_at >= NOW() - ($1::int * INTERVAL '1 day')
        `,
        [days]
      ),
      pool.query(
        `
        SELECT mc.id, mc.name, mc.campaign_code, mc.status,
          COALESCE(events.impressions, 0)::int AS impressions,
          COALESCE(events.clicks, 0)::int AS clicks,
          COALESCE(sales.conversions, 0)::int AS conversions,
          COALESCE(sales.attributed_revenue, 0)::numeric(14,2) AS attributed_revenue,
          COALESCE(sales.discount_given, 0)::numeric(14,2) AS discount_given
        FROM marketing_campaigns mc
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE event_type = 'impression') AS impressions,
            COUNT(*) FILTER (WHERE event_type = 'click') AS clicks
          FROM marketing_campaign_events ev
          WHERE ev.campaign_id = mc.id
            AND ev.created_at >= NOW() - ($1::int * INTERVAL '1 day')
        ) events ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS conversions,
            SUM(cr.final_total_amount) AS attributed_revenue,
            SUM(cr.discount_amount) AS discount_given
          FROM coupon_redemptions cr
          WHERE cr.campaign_id = mc.id
            AND cr.status = 'redeemed'
            AND cr.redeemed_at >= NOW() - ($1::int * INTERVAL '1 day')
        ) sales ON TRUE
        ORDER BY attributed_revenue DESC, conversions DESC, clicks DESC
        LIMIT 12
        `,
        [days]
      ),
      pool.query(
        `
        SELECT c.id, c.code, c.name, c.status, COUNT(cr.id)::int AS redemptions,
          COALESCE(SUM(cr.discount_amount), 0)::numeric(14,2) AS discount_given,
          COALESCE(SUM(cr.final_total_amount), 0)::numeric(14,2) AS attributed_revenue,
          COALESCE(AVG(cr.final_total_amount), 0)::numeric(14,2) AS average_order_value
        FROM coupons c
        LEFT JOIN coupon_redemptions cr ON cr.coupon_id = c.id AND cr.status = 'redeemed' AND cr.redeemed_at >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY c.id
        ORDER BY attributed_revenue DESC, redemptions DESC
        LIMIT 12
        `,
        [days]
      ),
      pool.query(
        `
        SELECT calendar.day_value::date AS day,
          COALESCE(ev.impressions, 0)::int AS impressions,
          COALESCE(ev.clicks, 0)::int AS clicks,
          COALESCE(redemptions.conversions, 0)::int AS conversions,
          COALESCE(redemptions.revenue, 0)::numeric(14,2) AS revenue
        FROM generate_series(
          CURRENT_DATE - ($1::int - 1),
          CURRENT_DATE,
          INTERVAL '1 day'
        ) AS calendar(day_value)
        LEFT JOIN (
          SELECT created_at::date AS day,
            COUNT(*) FILTER (WHERE event_type = 'impression') AS impressions,
            COUNT(*) FILTER (WHERE event_type = 'click') AS clicks
          FROM marketing_campaign_events
          WHERE created_at >= CURRENT_DATE - ($1::int - 1)
          GROUP BY created_at::date
        ) ev ON ev.day = calendar.day_value::date
        LEFT JOIN (
          SELECT redeemed_at::date AS day, COUNT(*) AS conversions, SUM(final_total_amount) AS revenue
          FROM coupon_redemptions
          WHERE status = 'redeemed' AND redeemed_at >= CURRENT_DATE - ($1::int - 1)
          GROUP BY redeemed_at::date
        ) redemptions ON redemptions.day = calendar.day_value::date
        ORDER BY calendar.day_value
        `,
        [days]
      ),
      pool.query(`SELECT * FROM marketing_automation_runs ORDER BY started_at DESC LIMIT 10`),
    ]);
    const s = summary.rows[0] || {};
    const impressions = Number(s.impressions || 0);
    const clicks = Number(s.clicks || 0);
    const conversions = Number(s.conversions || 0);
    return handleSuccess(res, 200, 'Marketing analytics retrieved', {
      period_days: days,
      summary: {
        ...s,
        click_through_rate: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
        conversion_rate: clicks > 0 ? Number(((conversions / clicks) * 100).toFixed(2)) : 0,
      },
      top_campaigns: campaigns.rows,
      top_coupons: coupons.rows,
      daily: daily.rows,
      automation_runs: automation.rows,
    });
  } catch (err) {
    console.error('getMarketingAnalytics error:', err.message);
    return handleError(res, 500, 'Failed to retrieve marketing analytics', err);
  }
};

const listReferralCodes = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT rc.*, sr.name AS sales_rep_name, sr.phone_number,
        COUNT(ref.id)::int AS applications,
        COUNT(ref.id) FILTER (WHERE ref.status IN ('approved', 'rewarded'))::int AS approved_referrals
      FROM sales_rep_referral_codes rc
      INNER JOIN sales_reps sr ON sr.id = rc.sales_rep_id
      LEFT JOIN route_customer_referrals ref ON ref.referral_code_id = rc.id
      GROUP BY rc.id, sr.id
      ORDER BY approved_referrals DESC, applications DESC, sr.name
      `
    );
    return handleSuccess(res, 200, 'Sales rep referral codes retrieved', result.rows);
  } catch (err) {
    console.error('listReferralCodes error:', err.message);
    return handleError(res, 500, 'Failed to retrieve referral codes', err);
  }
};

const ensureReferralCodes = async (req, res) => {
  try {
    const result = await pool.query(
      `
      INSERT INTO sales_rep_referral_codes (sales_rep_id, code, created_at, updated_at)
      SELECT sr.id, 'XPOSE-REP-' || sr.id::text, NOW(), NOW()
      FROM sales_reps sr
      ON CONFLICT (sales_rep_id) DO NOTHING
      RETURNING id
      `
    );
    return handleSuccess(res, 200, 'Referral codes synchronized', { created: result.rowCount || 0 });
  } catch (err) {
    console.error('ensureReferralCodes error:', err.message);
    return handleError(res, 500, 'Failed to synchronize referral codes', err);
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
  trackCampaignEvent,
  getCampaignTargets,
  replaceCampaignTargets,
  getMarketingAnalytics,
  listReferralCodes,
  ensureReferralCodes,
};