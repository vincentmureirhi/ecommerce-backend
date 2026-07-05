'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

function cleanSlug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRules(value) {
  const rules = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    flash: rules.flash === true,
    wholesale: rules.wholesale === true,
    min_price: numberOrNull(rules.min_price),
    max_price: numberOrNull(rules.max_price),
    sort: String(rules.sort || 'featured').trim().toLowerCase(),
    search_terms: Array.isArray(rules.search_terms)
      ? rules.search_terms.map((term) => String(term || '').trim()).filter(Boolean).slice(0, 20)
      : [],
  };
}

const stockExpression = `
  CASE
    WHEN COALESCE(p.stock_source, 'product') = 'pool' THEN COALESCE(sp.total_stock, 0)
    ELSE COALESCE(p.current_stock, 0)
  END
`;

const priceExpression = 'COALESCE(active_flash_sale.discounted_price, p.retail_price, p.wholesale_price, 0)';

async function queryCollectionProducts({ rules = {}, productIds = [], categoryIds = [], limit = 12 }) {
  const normalized = normalizeRules(rules);
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = [
    'COALESCE(p.is_active, TRUE) = TRUE',
    `${stockExpression} > 0`,
    `(
      COALESCE(p.product_owner_type, 'xpose') <> 'vendor'
      OR (
        p.vendor_id IS NOT NULL
        AND COALESCE(p.vendor_approval_status, 'pending') = 'approved'
        AND COALESCE(v.status, 'active') = 'active'
        AND COALESCE(v.store_visibility_status, 'public') = 'public'
      )
    )`,
  ];

  if (productIds.length || categoryIds.length) {
    const targetClauses = [];
    if (productIds.length) targetClauses.push(`p.id = ANY(${add(productIds)}::int[])`);
    if (categoryIds.length) targetClauses.push(`p.category_id = ANY(${add(categoryIds)}::int[])`);
    where.push(`(${targetClauses.join(' OR ')})`);
  }

  if (normalized.search_terms.length) {
    const termParam = add(normalized.search_terms.map((term) => `%${term}%`));
    where.push(`EXISTS (
      SELECT 1 FROM unnest(${termParam}::text[]) term
      WHERE p.name ILIKE term
         OR COALESCE(p.description, '') ILIKE term
         OR COALESCE(c.name, '') ILIKE term
         OR COALESCE(d.name, '') ILIKE term
    )`);
  }

  if (normalized.flash) where.push('active_flash_sale.id IS NOT NULL');
  if (normalized.min_price !== null) where.push(`${priceExpression} >= ${add(normalized.min_price)}`);
  if (normalized.max_price !== null) where.push(`${priceExpression} <= ${add(normalized.max_price)}`);
  if (normalized.wholesale) {
    where.push(`(
      COALESCE(p.min_order_qty, 1) > 1
      OR (p.wholesale_price IS NOT NULL AND p.wholesale_price > 0 AND p.wholesale_price < p.retail_price)
      OR EXISTS (SELECT 1 FROM product_price_tiers tier WHERE tier.product_id = p.id AND tier.min_qty > 1)
    )`);
  }

  const sortClauses = {
    newest: 'COALESCE(p.created_at, p.updated_at) DESC NULLS LAST, p.id DESC',
    'price-asc': `${priceExpression} ASC, p.name ASC`,
    'price-desc': `${priceExpression} DESC, p.name ASC`,
    trending: `(
      COALESCE((SELECT COUNT(*) FROM storefront_product_events spe WHERE spe.product_id = p.id AND spe.event_type = 'view' AND spe.created_at >= NOW() - INTERVAL '30 days'), 0)
      + COALESCE((SELECT COUNT(*) * 4 FROM storefront_product_events spe WHERE spe.product_id = p.id AND spe.event_type = 'add_to_cart' AND spe.created_at >= NOW() - INTERVAL '30 days'), 0)
      + COALESCE((SELECT SUM(oi.quantity) * 8 FROM order_items oi INNER JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.order_status IN ('delivered', 'completed') AND o.created_at >= NOW() - INTERVAL '90 days'), 0)
    ) DESC, COALESCE(p.updated_at, p.created_at) DESC NULLS LAST`,
    featured: `CASE WHEN active_flash_sale.id IS NOT NULL THEN 0 ELSE 1 END ASC, COALESCE(p.updated_at, p.created_at) DESC NULLS LAST`,
  };
  const orderBy = sortClauses[normalized.sort] || sortClauses.featured;
  const safeLimit = Math.min(Math.max(Number(limit) || 12, 4), 24);
  const limitParam = add(safeLimit);

  const result = await pool.query(
    `
    SELECT
      p.*,
      p.current_stock AS product_current_stock,
      (${stockExpression})::int AS current_stock,
      (${stockExpression})::int AS stock,
      COALESCE(p.stock_source, 'product') AS stock_source,
      sp.name AS stock_pool_name,
      COALESCE(NULLIF(p.stock_status_override, ''), CASE
        WHEN ${stockExpression} <= 0 THEN 'out_of_stock'
        WHEN ${stockExpression} <= GREATEST(COALESCE(p.min_order_qty, 1), COALESCE(p.reorder_level, sp.reorder_level, 10), 10) THEN 'limited_stock'
        ELSE 'in_stock'
      END) AS stock_status,
      c.name AS category_name,
      d.name AS department_name,
      v.store_name AS vendor_store_name,
      v.store_slug AS vendor_store_slug,
      v.verification_status AS vendor_verification_status,
      v.verification_badge_label AS vendor_verification_badge_label,
      (v.id IS NOT NULL AND v.verification_status = 'verified') AS vendor_verified,
      active_flash_sale.id AS flash_sale_id,
      active_flash_sale.name AS flash_sale_name,
      active_flash_sale.discounted_price,
      active_flash_sale.end_date AS flash_sale_end_date,
      (active_flash_sale.id IS NOT NULL) AS is_flash,
      COALESCE(tiers.price_tiers, '[]'::json) AS price_tiers,
      pr.rule_type AS pricing_rule_type,
      pr.name AS pricing_rule_name,
      pr.threshold_qty AS wholesale_threshold_qty,
      pg.name AS pricing_group_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN departments d ON d.id = p.department_id
    LEFT JOIN inventory_stock_pools sp ON sp.id = p.stock_pool_id
    LEFT JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN LATERAL (
      SELECT fs.id, fs.name, fs.end_date,
        CASE
          WHEN fs.discount_type = 'percentage' THEN ROUND((p.retail_price * (1 - fs.discount_value / 100.0))::numeric, 2)
          WHEN fs.discount_type = 'fixed' THEN GREATEST((p.retail_price - fs.discount_value)::numeric, 0)
          ELSE NULL
        END AS discounted_price
      FROM flash_sale_products fsp
      INNER JOIN flash_sales fs ON fs.id = fsp.flash_sale_id
      WHERE fsp.product_id = p.id AND fs.is_active = TRUE AND fs.start_date <= NOW() AND fs.end_date >= NOW()
      ORDER BY discounted_price ASC NULLS LAST, fs.end_date ASC
      LIMIT 1
    ) active_flash_sale ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('id', id, 'min_qty', min_qty, 'max_qty', max_qty, 'unit_price', unit_price) ORDER BY min_qty ASC) AS price_tiers
      FROM product_price_tiers tier WHERE tier.product_id = p.id
    ) tiers ON TRUE
    LEFT JOIN pricing_rules pr ON pr.id = p.pricing_rule_id
    LEFT JOIN pricing_groups pg ON pg.id = pr.pricing_group_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ${limitParam}
    `,
    params
  );

  return result.rows;
}

async function loadCollection(slug) {
  const result = await pool.query(
    `
    SELECT mc.*,
      COALESCE((SELECT json_agg(product_id ORDER BY product_id) FROM marketing_campaign_products WHERE campaign_id = mc.id), '[]'::json) AS product_ids,
      COALESCE((SELECT json_agg(category_id ORDER BY category_id) FROM marketing_campaign_categories WHERE campaign_id = mc.id), '[]'::json) AS category_ids
    FROM marketing_campaigns mc
    WHERE mc.is_collection = TRUE
      AND LOWER(mc.collection_slug) = LOWER($1)
      AND mc.status = 'active'
      AND (mc.starts_at IS NULL OR mc.starts_at <= NOW())
      AND (mc.ends_at IS NULL OR mc.ends_at >= NOW())
    LIMIT 1
    `,
    [slug]
  );
  return result.rows[0] || null;
}

const listPublicCollections = async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, collection_slug, hero_title, hero_subtitle, badge_label, cta_label, cta_url,
              hero_image_url, share_image_url, accent_color, customer_scope, homepage_section,
              seo_title, seo_description, priority, product_limit
       FROM marketing_campaigns
       WHERE is_collection = TRUE AND status = 'active'
         AND (starts_at IS NULL OR starts_at <= NOW())
         AND (ends_at IS NULL OR ends_at >= NOW())
       ORDER BY priority DESC, created_at DESC`,
    );
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return handleSuccess(res, 200, 'Collections retrieved', result.rows);
  } catch (error) {
    console.error('listPublicCollections error:', error.message);
    return handleError(res, 500, 'Failed to load collections', error);
  }
};

const getPublicCollection = async (req, res) => {
  try {
    const slug = cleanSlug(req.params.slug);
    if (!slug) return handleError(res, 400, 'Invalid collection slug');
    const collection = await loadCollection(slug);
    if (!collection) return handleError(res, 404, 'Collection not found');
    const products = await queryCollectionProducts({
      rules: collection.automatic_rules,
      productIds: collection.product_ids || [],
      categoryIds: collection.category_ids || [],
      limit: collection.product_limit,
    });
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=180');
    return handleSuccess(res, 200, 'Collection retrieved', { collection, products });
  } catch (error) {
    console.error('getPublicCollection error:', error.message);
    return handleError(res, 500, 'Failed to load collection', error);
  }
};

const listHomeMerchandising = async (_req, res) => {
  try {
    const [trending, wholesale, under500, newArrivals] = await Promise.all([
      queryCollectionProducts({ rules: { sort: 'trending' }, limit: 10 }),
      queryCollectionProducts({ rules: { wholesale: true, sort: 'price-asc' }, limit: 10 }),
      queryCollectionProducts({ rules: { max_price: 500, sort: 'price-asc' }, limit: 10 }),
      queryCollectionProducts({ rules: { sort: 'newest' }, limit: 10 }),
    ]);
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return handleSuccess(res, 200, 'Homepage merchandising retrieved', {
      trending,
      wholesale,
      under_500: under500,
      new_arrivals: newArrivals,
    });
  } catch (error) {
    console.error('listHomeMerchandising error:', error.message);
    return handleError(res, 500, 'Failed to load homepage merchandising', error);
  }
};

const trackProductEvent = async (req, res) => {
  try {
    const productId = Number(req.params.id);
    const eventType = String(req.body?.event_type || 'view').trim().toLowerCase();
    if (!Number.isInteger(productId) || productId <= 0) return handleError(res, 400, 'Invalid product id');
    if (!['view', 'add_to_cart'].includes(eventType)) return handleError(res, 400, 'Invalid product event type');
    const sessionId = String(req.body?.session_id || '').trim().slice(0, 120) || null;
    const sourcePath = String(req.body?.source_path || '').trim().slice(0, 500) || null;
    const campaignId = numberOrNull(req.body?.campaign_id);
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
    const result = await pool.query(
      `
      INSERT INTO storefront_product_events
        (product_id, event_type, session_id, source_path, campaign_id, metadata, created_at)
      SELECT p.id, $2::varchar(30), $3::varchar(120), $4::text, (SELECT id FROM marketing_campaigns WHERE id = $5::int), $6::jsonb, NOW()
      FROM products p
      WHERE p.id = $1 AND COALESCE(p.is_active, TRUE) = TRUE
        AND (
          $3::varchar(120) IS NULL OR NOT EXISTS (
            SELECT 1 FROM storefront_product_events existing
            WHERE existing.product_id = p.id
              AND existing.event_type = $2::varchar(30)
              AND existing.session_id = $3::varchar(120)
              AND existing.created_at >= NOW() - CASE WHEN $2::varchar(30) = 'view' THEN INTERVAL '6 hours' ELSE INTERVAL '5 minutes' END
          )
        )
      RETURNING id
      `,
      [productId, eventType, sessionId, sourcePath, campaignId, JSON.stringify(metadata)]
    );
    return handleSuccess(res, 202, 'Product event accepted', { recorded: Boolean(result.rows[0]) });
  } catch (error) {
    console.error('trackProductEvent error:', error.message);
    return handleError(res, 500, 'Failed to record product event', error);
  }
};

module.exports = {
  listPublicCollections,
  getPublicCollection,
  listHomeMerchandising,
  trackProductEvent,
  queryCollectionProducts,
};
