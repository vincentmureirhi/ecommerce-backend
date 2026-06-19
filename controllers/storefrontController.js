'use strict';

const pool = require('../config/database');
const { handleError } = require('../utils/errorHandler');

function toPositiveInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function addParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function buildPublicProductFilters(query, params) {
  const where = [
    'COALESCE(p.is_active, TRUE) = TRUE',
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

  const searchText = String(query.search || query.q || '').trim();
  if (searchText) {
    const value = addParam(params, `%${searchText}%`);
    where.push(`(
      p.name ILIKE ${value}
      OR p.sku ILIKE ${value}
      OR COALESCE(p.description, '') ILIKE ${value}
      OR COALESCE(c.name, '') ILIKE ${value}
      OR COALESCE(d.name, '') ILIKE ${value}
      OR COALESCE(v.store_name, '') ILIKE ${value}
    )`);
  }

  if (query.category && query.category !== 'all') {
    const categoryId = Number(query.category);
    if (Number.isInteger(categoryId) && categoryId > 0) {
      where.push(`p.category_id = ${addParam(params, categoryId)}`);
    }
  }

  const priceExpression = 'COALESCE(active_flash_sale.discounted_price, p.retail_price, p.wholesale_price, 0)';

  if (query.min !== undefined && query.min !== '') {
    const minPrice = Number(query.min);
    if (Number.isFinite(minPrice) && minPrice >= 0) {
      where.push(`${priceExpression} >= ${addParam(params, minPrice)}`);
    }
  }

  if (query.max !== undefined && query.max !== '') {
    const maxPrice = Number(query.max);
    if (Number.isFinite(maxPrice) && maxPrice >= 0) {
      where.push(`${priceExpression} <= ${addParam(params, maxPrice)}`);
    }
  }

  if (query.flash === '1' || query.flash === 'true') {
    where.push('active_flash_sale.id IS NOT NULL');
  }

  const stock = String(query.stock || '').toLowerCase();
  const effectiveStockExpression = `
    CASE
      WHEN COALESCE(p.stock_source, 'product') = 'pool'
        THEN COALESCE(sp.total_stock, 0)
      ELSE COALESCE(p.current_stock, 0)
    END
  `;
  if (stock === 'limited') {
    where.push(`COALESCE(NULLIF(p.stock_status_override, ''), CASE
      WHEN COALESCE(p.stock_source, 'product') = 'pool' AND NULLIF(sp.stock_status_override, '') IS NOT NULL THEN sp.stock_status_override
      WHEN ${effectiveStockExpression} <= 0 THEN 'out_of_stock'
      WHEN ${effectiveStockExpression} <= GREATEST(COALESCE(p.min_order_qty, 1), COALESCE(p.reorder_level, sp.reorder_level, 10), 10) THEN 'limited_stock'
      ELSE 'in_stock'
    END) = 'limited_stock'`);
  } else if (stock === 'ready' || stock === 'in_stock') {
    where.push(`COALESCE(NULLIF(p.stock_status_override, ''), CASE
      WHEN COALESCE(p.stock_source, 'product') = 'pool' AND NULLIF(sp.stock_status_override, '') IS NOT NULL THEN sp.stock_status_override
      WHEN ${effectiveStockExpression} <= 0 THEN 'out_of_stock'
      WHEN ${effectiveStockExpression} <= GREATEST(COALESCE(p.min_order_qty, 1), COALESCE(p.reorder_level, sp.reorder_level, 10), 10) THEN 'limited_stock'
      ELSE 'in_stock'
    END) <> 'out_of_stock'`);
  } else if (stock === 'out_of_stock') {
    where.push(`COALESCE(NULLIF(p.stock_status_override, ''), CASE
      WHEN COALESCE(p.stock_source, 'product') = 'pool' AND NULLIF(sp.stock_status_override, '') IS NOT NULL THEN sp.stock_status_override
      WHEN ${effectiveStockExpression} <= 0 THEN 'out_of_stock'
      WHEN ${effectiveStockExpression} <= GREATEST(COALESCE(p.min_order_qty, 1), COALESCE(p.reorder_level, sp.reorder_level, 10), 10) THEN 'limited_stock'
      ELSE 'in_stock'
    END) = 'out_of_stock'`);
  }

  return { where, priceExpression };
}

function getSortClause(sort, priceExpression) {
  switch (String(sort || '').toLowerCase()) {
    case 'price-asc':
      return `${priceExpression} ASC, p.name ASC`;
    case 'price-desc':
      return `${priceExpression} DESC, p.name ASC`;
    case 'name-asc':
      return 'p.name ASC, p.id DESC';
    case 'name-desc':
      return 'p.name DESC, p.id DESC';
    case 'newest':
      return 'p.created_at DESC NULLS LAST, p.id DESC';
    default:
      return `
        CASE
          WHEN active_flash_sale.id IS NOT NULL THEN 0
          WHEN COALESCE(NULLIF(p.stock_status_override, ''), '') = 'limited_stock' THEN 1
          WHEN (
            CASE
              WHEN COALESCE(p.stock_source, 'product') = 'pool'
                THEN COALESCE(sp.total_stock, 0)
              ELSE COALESCE(p.current_stock, 0)
            END
          ) > 0 THEN 2
          ELSE 3
        END ASC,
        COALESCE(p.updated_at, p.created_at) DESC NULLS LAST,
        p.id DESC
      `;
  }
}

const productFromClause = `
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN departments d ON d.id = p.department_id
  LEFT JOIN inventory_stock_pools sp ON sp.id = p.stock_pool_id
  LEFT JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN LATERAL (
    SELECT
      fs.id,
      fs.name,
      fs.discount_type,
      fs.discount_value,
      fs.start_date,
      fs.end_date,
      CASE
        WHEN fs.discount_type = 'percentage'
          THEN ROUND((p.retail_price * (1 - fs.discount_value / 100.0))::numeric, 2)
        WHEN fs.discount_type = 'fixed'
          THEN GREATEST((p.retail_price - fs.discount_value)::numeric, 0)
        ELSE NULL
      END AS discounted_price
    FROM flash_sale_products fsp
    JOIN flash_sales fs ON fs.id = fsp.flash_sale_id
    WHERE fsp.product_id = p.id
      AND fs.is_active = TRUE
      AND fs.start_date <= NOW()
      AND fs.end_date >= NOW()
    ORDER BY discounted_price ASC NULLS LAST, fs.end_date ASC, fs.id ASC
    LIMIT 1
  ) active_flash_sale ON TRUE
`;

const productSelect = `
  SELECT
    p.*,
    p.current_stock AS product_current_stock,
    (CASE
      WHEN COALESCE(p.stock_source, 'product') = 'pool'
        THEN COALESCE(sp.total_stock, 0)
      ELSE COALESCE(p.current_stock, 0)
    END)::INT AS current_stock,
    (CASE
      WHEN COALESCE(p.stock_source, 'product') = 'pool'
        THEN COALESCE(sp.total_stock, 0)
      ELSE COALESCE(p.current_stock, 0)
    END)::INT AS stock,
    COALESCE(p.stock_source, 'product') AS stock_source,
    sp.id AS stock_pool_id,
    sp.name AS stock_pool_name,
    sp.sku AS stock_pool_sku,
    COALESCE(sp.total_stock, 0)::INT AS stock_pool_total_stock,
    p.stock_pool_note,
    COALESCE(NULLIF(p.stock_status_override, ''), CASE
      WHEN COALESCE(p.stock_source, 'product') = 'pool' AND NULLIF(sp.stock_status_override, '') IS NOT NULL THEN sp.stock_status_override
      WHEN (
        CASE
          WHEN COALESCE(p.stock_source, 'product') = 'pool'
            THEN COALESCE(sp.total_stock, 0)
          ELSE COALESCE(p.current_stock, 0)
        END
      ) <= 0 THEN 'out_of_stock'
      WHEN (
        CASE
          WHEN COALESCE(p.stock_source, 'product') = 'pool'
            THEN COALESCE(sp.total_stock, 0)
          ELSE COALESCE(p.current_stock, 0)
        END
      ) <= GREATEST(COALESCE(p.min_order_qty, 1), COALESCE(p.reorder_level, sp.reorder_level, 10), 10) THEN 'limited_stock'
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
    active_flash_sale.discount_type,
    active_flash_sale.discount_value,
    active_flash_sale.start_date AS flash_sale_start_date,
    active_flash_sale.end_date AS flash_sale_end_date,
    active_flash_sale.discounted_price AS discounted_price,
    (active_flash_sale.id IS NOT NULL) AS is_flash,
    COALESCE(pt.price_tiers, '[]'::json) AS price_tiers,
    pr.rule_type AS pricing_rule_type,
    pr.name AS pricing_rule_name,
    pr.threshold_qty AS wholesale_threshold_qty,
    pr.pricing_group_id,
    pg.name AS pricing_group_name
`;

const productJoinSuffix = `
  LEFT JOIN (
    SELECT
      product_id,
      json_agg(
        json_build_object(
          'id', id,
          'min_qty', min_qty,
          'max_qty', max_qty,
          'unit_price', unit_price
        )
        ORDER BY min_qty ASC
      ) AS price_tiers
    FROM product_price_tiers
    GROUP BY product_id
  ) pt ON pt.product_id = p.id
  LEFT JOIN pricing_rules pr ON pr.id = p.pricing_rule_id
  LEFT JOIN pricing_groups pg ON pg.id = pr.pricing_group_id
`;

async function listStorefrontProducts(req, res) {
  try {
    const page = toPositiveInteger(req.query.page, 1, { min: 1, max: 100000 });
    const limit = toPositiveInteger(req.query.limit, 24, { min: 1, max: 60 });
    const offset = (page - 1) * limit;
    const filterParams = [];
    const { where, priceExpression } = buildPublicProductFilters(req.query, filterParams);
    const orderBy = getSortClause(req.query.sort, priceExpression);

    const countResult = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      ${productFromClause}
      WHERE ${where.join(' AND ')}
      `,
      filterParams
    );

    const productParams = [...filterParams, limit, offset];
    const limitParam = `$${productParams.length - 1}`;
    const offsetParam = `$${productParams.length}`;

    const productResult = await pool.query(
      `
      ${productSelect}
      ${productFromClause}
      ${productJoinSuffix}
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
      `,
      productParams
    );

    const total = Number(countResult.rows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.json({
      success: true,
      data: productResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
      meta: {
        search: String(req.query.search || req.query.q || '').trim(),
        category: req.query.category || 'all',
        sort: req.query.sort || 'featured',
        requestId: req.requestId,
      },
    });
  } catch (err) {
    console.error('listStorefrontProducts error:', err.message);
    return handleError(res, 500, 'Failed to load storefront products', err);
  }
}

async function listFeaturedStorefrontProducts(req, res) {
  req.query = {
    ...req.query,
    page: 1,
    limit: toPositiveInteger(req.query.limit, 16, { min: 1, max: 30 }),
    sort: req.query.sort || 'featured',
    stock: req.query.stock || 'ready',
  };
  return listStorefrontProducts(req, res);
}

async function searchStorefrontProducts(req, res) {
  req.query = {
    ...req.query,
    page: 1,
    limit: toPositiveInteger(req.query.limit, 12, { min: 1, max: 30 }),
    search: req.query.q || req.query.search || '',
  };
  return listStorefrontProducts(req, res);
}

async function listStorefrontCategories(req, res) {
  try {
    const result = await pool.query(
      `
      SELECT
        c.*,
        COUNT(p.id)::int AS product_count,
        COALESCE(SUM(CASE
          WHEN COALESCE(p.stock_source, 'product') = 'pool'
            THEN COALESCE(sp.total_stock, 0)
          ELSE COALESCE(p.current_stock, 0)
        END), 0)::int AS total_stock
      FROM categories c
      LEFT JOIN products p
        ON p.category_id = c.id
       AND COALESCE(p.is_active, TRUE) = TRUE
      LEFT JOIN inventory_stock_pools sp ON sp.id = p.stock_pool_id
      WHERE (
        p.id IS NULL
        OR CASE
          WHEN COALESCE(p.stock_source, 'product') = 'pool'
            THEN COALESCE(sp.total_stock, 0)
          ELSE COALESCE(p.current_stock, 0)
        END > 0
      )
      GROUP BY c.id
      HAVING COUNT(p.id) > 0
      ORDER BY c.name ASC
      `
    );

    return res.json({
      success: true,
      data: result.rows,
      meta: {
        cache: 'public-categories',
        requestId: req.requestId,
      },
    });
  } catch (err) {
    console.error('listStorefrontCategories error:', err.message);
    return handleError(res, 500, 'Failed to load storefront categories', err);
  }
}

module.exports = {
  listStorefrontProducts,
  listFeaturedStorefrontProducts,
  searchStorefrontProducts,
  listStorefrontCategories,
};
