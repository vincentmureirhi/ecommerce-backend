'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

const ACTIVE_APPLICATION_STATUSES = ['submitted', 'under_review', 'approved'];
const APPLICATION_STATUSES = ['submitted', 'under_review', 'approved', 'rejected', 'withdrawn'];
const VENDOR_STATUSES = ['pending', 'active', 'suspended', 'closed'];
const VERIFICATION_STATUSES = ['unverified', 'pending', 'verified', 'rejected'];
const FULFILLMENT_MODELS = ['xpose_reviewed', 'xpose_fulfilled', 'vendor_fulfilled', 'hybrid'];
const PRODUCT_SUBMISSION_STATUSES = ['draft', 'submitted', 'changes_requested', 'approved', 'rejected', 'archived'];

function trimOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeEmail(value) {
  const trimmed = trimOrNull(value);
  return trimmed ? trimmed.toLowerCase() : null;
}

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseInteger(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeCategories(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 25);
  }

  const text = trimOrNull(value);
  if (!text) return [];

  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 25);
}

function normalizeFulfillmentModel(value, fallback = 'xpose_reviewed') {
  return FULFILLMENT_MODELS.includes(value) ? value : fallback;
}

function slugify(value) {
  const base = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return base || `vendor-${Date.now()}`;
}

function generateApplicationNumber() {
  const date = new Date();
  const stamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('');
  const suffix = Math.floor(100000 + Math.random() * 900000);
  return `VEND-${stamp}-${suffix}`;
}

function generateTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let output = 'XpV-';
  for (let i = 0; i < 10; i += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  return typeof secret === 'string' && secret.trim() ? secret : null;
}

function getActorId(req) {
  return req.user?.id || req.user?.user_id || req.user?.admin_id || null;
}

function normalizeOptionalUrl(value) {
  const text = trimOrNull(value);
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  return `https://${text}`;
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 20);
  }

  const text = trimOrNull(value);
  if (!text) return [];

  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function requirePositiveMoney(value, field) {
  const parsed = parseNumber(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be greater than 0`);
  }
  return parsed;
}

function requireNonNegativeMoney(value, field, fallback = null) {
  const parsed = parseNumber(value, fallback);
  if (parsed === null) return null;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be 0 or greater`);
  }
  return parsed;
}

function requirePositiveInteger(value, field, fallback = 1) {
  const parsed = parseInteger(value, fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be an integer greater than 0`);
  }
  return parsed;
}

function requireNonNegativeInteger(value, field, fallback = 0) {
  const parsed = parseInteger(value, fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be an integer 0 or greater`);
  }
  return parsed;
}

function mapVendorUser(row) {
  if (!row) return null;
  return {
    id: row.id || row.vendor_user_id,
    vendor_id: row.vendor_id,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    username: row.username,
    role: row.role,
    status: row.status || row.user_status,
    must_change_password: Boolean(row.must_change_password),
    last_login_at: row.last_login_at,
    created_at: row.created_at,
  };
}

function mapPublicVendor(row) {
  if (!row) return null;
  return {
    id: row.id,
    store_name: row.store_name,
    store_slug: row.store_slug,
    public_description: row.public_description,
    product_categories: row.product_categories || [],
    logo_url: row.logo_url,
    banner_url: row.banner_url,
    verification_status: row.verification_status,
    verified: row.verification_status === 'verified',
    verification_badge_label: row.verification_badge_label || 'Verified by XPOSE',
    product_count: Number(row.product_count || 0),
    limited_stock_count: Number(row.limited_stock_count || 0),
    minimum_price: row.minimum_price,
    storefront_featured: Boolean(row.storefront_featured),
    published_at: row.published_at,
  };
}

async function createUniqueSlug(client, storeName) {
  const base = slugify(storeName);
  let slug = base;
  let suffix = 2;

  while (suffix < 1000) {
    const check = await client.query('SELECT id FROM vendors WHERE store_slug = $1 LIMIT 1', [slug]);
    if (check.rows.length === 0) return slug;
    slug = `${base}-${suffix}`;
    suffix += 1;
  }

  return `${base}-${Date.now()}`;
}

async function createUniqueUsername(client, email, storeSlug) {
  const emailUsername = normalizeEmail(email);
  const base = emailUsername || storeSlug;
  let username = base;
  let suffix = 2;

  while (suffix < 1000) {
    const check = await client.query(
      'SELECT id FROM vendor_users WHERE LOWER(username) = LOWER($1) LIMIT 1',
      [username]
    );
    if (check.rows.length === 0) return username;
    username = `${base}-${suffix}`;
    suffix += 1;
  }

  return `${base}-${Date.now()}`;
}

function mapPlanPayload(body = {}) {
  return {
    code: trimOrNull(body.code),
    name: trimOrNull(body.name),
    description: trimOrNull(body.description),
    monthly_fee: parseNumber(body.monthly_fee, 0),
    commission_rate: parseNumber(body.commission_rate, 0),
    max_products: parseInteger(body.max_products, 25),
    featured_slots: parseInteger(body.featured_slots, 0),
    product_approval_required: normalizeBoolean(body.product_approval_required, true),
    price_review_required: normalizeBoolean(body.price_review_required, true),
    minimum_margin_percent: parseNumber(body.minimum_margin_percent, 0),
    allow_vendor_discounts: normalizeBoolean(body.allow_vendor_discounts, false),
    is_active: normalizeBoolean(body.is_active, true),
  };
}

function readPlanUpdate(body = {}) {
  const updates = {};

  if (body.name !== undefined) updates.name = trimOrNull(body.name);
  if (body.description !== undefined) updates.description = trimOrNull(body.description);
  if (body.monthly_fee !== undefined) updates.monthly_fee = parseNumber(body.monthly_fee, 0);
  if (body.commission_rate !== undefined) updates.commission_rate = parseNumber(body.commission_rate, 0);
  if (body.max_products !== undefined) updates.max_products = parseInteger(body.max_products, 0);
  if (body.featured_slots !== undefined) updates.featured_slots = parseInteger(body.featured_slots, 0);
  if (body.product_approval_required !== undefined) {
    updates.product_approval_required = normalizeBoolean(body.product_approval_required, true);
  }
  if (body.price_review_required !== undefined) {
    updates.price_review_required = normalizeBoolean(body.price_review_required, true);
  }
  if (body.minimum_margin_percent !== undefined) {
    updates.minimum_margin_percent = parseNumber(body.minimum_margin_percent, 0);
  }
  if (body.allow_vendor_discounts !== undefined) {
    updates.allow_vendor_discounts = normalizeBoolean(body.allow_vendor_discounts, false);
  }
  if (body.is_active !== undefined) updates.is_active = normalizeBoolean(body.is_active, true);

  return updates;
}

async function getDefaultPlan(client) {
  const result = await client.query(
    `
    SELECT *
    FROM vendor_subscription_plans
    WHERE is_active = TRUE
    ORDER BY
      CASE code WHEN 'starter' THEN 0 ELSE 1 END,
      monthly_fee ASC,
      id ASC
    LIMIT 1
    `
  );

  return result.rows[0] || null;
}

const listPublicVendorPlans = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        code,
        name,
        description,
        monthly_fee,
        commission_rate,
        max_products,
        featured_slots,
        product_approval_required,
        price_review_required,
        minimum_margin_percent,
        allow_vendor_discounts
      FROM vendor_subscription_plans
      WHERE is_active = TRUE
      ORDER BY monthly_fee ASC, id ASC
      `
    );

    return handleSuccess(res, 200, 'Vendor plans retrieved', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve vendor plans', err);
  }
};

const listPublicVendorStores = async (req, res) => {
  try {
    const { search, category, featured } = req.query;
    const params = [];
    const where = [
      "v.status = 'active'",
      "v.verification_status = 'verified'",
      "v.store_visibility_status = 'public'",
    ];

    if (search) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(
        v.store_name ILIKE $${params.length}
        OR COALESCE(v.public_description, '') ILIKE $${params.length}
        OR COALESCE(v.legal_name, '') ILIKE $${params.length}
      )`);
    }

    if (category) {
      params.push(String(category).trim().toLowerCase());
      where.push(`EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(v.product_categories, '[]'::jsonb)) item
        WHERE LOWER(item) = $${params.length}
      )`);
    }

    if (featured === '1' || featured === 'true') {
      where.push('v.storefront_featured = TRUE');
    }

    const result = await pool.query(
      `
      SELECT
        v.id,
        v.store_name,
        v.store_slug,
        v.public_description,
        v.product_categories,
        v.logo_url,
        v.banner_url,
        v.verification_status,
        v.verification_badge_label,
        v.storefront_featured,
        v.published_at,
        COALESCE(product_stats.product_count, 0)::int AS product_count,
        COALESCE(product_stats.limited_stock_count, 0)::int AS limited_stock_count,
        product_stats.minimum_price
      FROM vendors v
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS product_count,
          COUNT(*) FILTER (
            WHERE COALESCE(NULLIF(p.stock_status_override, ''), CASE
              WHEN COALESCE(p.current_stock, 0) <= 0 THEN 'out_of_stock'
              WHEN COALESCE(p.current_stock, 0) <= GREATEST(COALESCE(p.min_order_qty, 1), COALESCE(p.reorder_level, 10), 10) THEN 'limited_stock'
              ELSE 'in_stock'
            END) = 'limited_stock'
          ) AS limited_stock_count,
          MIN(COALESCE(p.retail_price, p.wholesale_price, 0)) AS minimum_price
        FROM products p
        WHERE p.vendor_id = v.id
          AND p.product_owner_type = 'vendor'
          AND p.vendor_approval_status = 'approved'
          AND COALESCE(p.is_active, TRUE) = TRUE
      ) product_stats ON TRUE
      WHERE ${where.join(' AND ')}
      ORDER BY v.storefront_featured DESC, product_stats.product_count DESC NULLS LAST, v.created_at DESC
      LIMIT 100
      `,
      params
    );

    return handleSuccess(res, 200, 'Public vendor stores retrieved', result.rows.map(mapPublicVendor));
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve public vendor stores', err);
  }
};

const getPublicVendorStoreBySlug = async (req, res) => {
  try {
    const vendorResult = await pool.query(
      `
      SELECT
        v.id,
        v.store_name,
        v.store_slug,
        v.public_description,
        v.product_categories,
        v.logo_url,
        v.banner_url,
        v.verification_status,
        v.verification_badge_label,
        v.storefront_featured,
        v.published_at,
        COALESCE(product_stats.product_count, 0)::int AS product_count,
        COALESCE(product_stats.limited_stock_count, 0)::int AS limited_stock_count,
        product_stats.minimum_price
      FROM vendors v
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS product_count,
          COUNT(*) FILTER (
            WHERE COALESCE(NULLIF(p.stock_status_override, ''), CASE
              WHEN COALESCE(p.current_stock, 0) <= 0 THEN 'out_of_stock'
              WHEN COALESCE(p.current_stock, 0) <= GREATEST(COALESCE(p.min_order_qty, 1), COALESCE(p.reorder_level, 10), 10) THEN 'limited_stock'
              ELSE 'in_stock'
            END) = 'limited_stock'
          ) AS limited_stock_count,
          MIN(COALESCE(p.retail_price, p.wholesale_price, 0)) AS minimum_price
        FROM products p
        WHERE p.vendor_id = v.id
          AND p.product_owner_type = 'vendor'
          AND p.vendor_approval_status = 'approved'
          AND COALESCE(p.is_active, TRUE) = TRUE
      ) product_stats ON TRUE
      WHERE v.store_slug = $1
        AND v.status = 'active'
        AND v.verification_status = 'verified'
        AND v.store_visibility_status = 'public'
      LIMIT 1
      `,
      [req.params.slug]
    );

    if (vendorResult.rows.length === 0) {
      return handleError(res, 404, 'Vendor store not found');
    }

    const productsResult = await pool.query(
      `
      SELECT
        p.id,
        p.name,
        p.description,
        p.sku,
        p.category_id,
        c.name AS category_name,
        p.image_url,
        p.retail_price,
        p.wholesale_price,
        p.min_order_qty,
        p.order_qty_step,
        p.selling_unit_label,
        p.current_stock,
        COALESCE(NULLIF(p.stock_status_override, ''), CASE
          WHEN COALESCE(p.current_stock, 0) <= 0 THEN 'out_of_stock'
          WHEN COALESCE(p.current_stock, 0) <= GREATEST(COALESCE(p.min_order_qty, 1), COALESCE(p.reorder_level, 10), 10) THEN 'limited_stock'
          ELSE 'in_stock'
        END) AS stock_status,
        v.store_name AS vendor_store_name,
        v.store_slug AS vendor_store_slug,
        v.verification_status AS vendor_verification_status,
        v.verification_badge_label AS vendor_verification_badge_label
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1
        AND p.product_owner_type = 'vendor'
        AND p.vendor_approval_status = 'approved'
        AND COALESCE(p.is_active, TRUE) = TRUE
      ORDER BY p.current_stock DESC, p.id DESC
      LIMIT 120
      `,
      [vendorResult.rows[0].id]
    );

    return handleSuccess(res, 200, 'Public vendor store retrieved', {
      store: mapPublicVendor(vendorResult.rows[0]),
      products: productsResult.rows,
    });
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve public vendor store', err);
  }
};

const loginVendor = async (req, res) => {
  try {
    const identifier = trimOrNull(req.body?.identifier || req.body?.username || req.body?.email || req.body?.phone);
    const password = String(req.body?.password || '');

    if (!identifier || !password) {
      return handleError(res, 400, 'Vendor username/email/phone and password are required');
    }

    const phoneDigits = normalizePhoneDigits(identifier) || null;
    const result = await pool.query(
      `
      SELECT
        vu.*,
        v.store_name,
        v.store_slug,
        v.status AS vendor_status,
        v.verification_status,
        v.store_visibility_status,
        v.logo_url,
        v.banner_url
      FROM vendor_users vu
      JOIN vendors v ON v.id = vu.vendor_id
      WHERE LOWER(vu.username) = LOWER($1)
         OR LOWER(COALESCE(vu.email, '')) = LOWER($1)
         OR REGEXP_REPLACE(COALESCE(vu.phone, ''), '\\D', '', 'g') = $2
      ORDER BY vu.created_at ASC
      LIMIT 1
      `,
      [identifier, phoneDigits]
    );

    if (result.rows.length === 0) {
      return handleError(res, 401, 'Invalid vendor login credentials');
    }

    const account = result.rows[0];
    const validPassword = await bcrypt.compare(password, account.password_hash);
    if (!validPassword) {
      return handleError(res, 401, 'Invalid vendor login credentials');
    }

    if (account.status !== 'active') {
      return handleError(res, 403, 'Vendor user account is not active');
    }

    if (account.vendor_status !== 'active') {
      return handleError(res, 403, 'Vendor store is not active');
    }

    const jwtSecret = getJwtSecret();
    if (!jwtSecret) {
      return handleError(res, 500, 'JWT secret is not configured');
    }

    const token = jwt.sign(
      {
        token_type: 'vendor_user',
        vendor_user_id: account.id,
        vendor_id: account.vendor_id,
        username: account.username,
        role: account.role,
      },
      jwtSecret,
      { expiresIn: process.env.VENDOR_JWT_EXPIRES_IN || '12h' }
    );

    await pool.query('UPDATE vendor_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [account.id]);

    return handleSuccess(res, 200, 'Vendor login successful', {
      token,
      vendor_user: mapVendorUser(account),
      vendor: {
        id: account.vendor_id,
        store_name: account.store_name,
        store_slug: account.store_slug,
        status: account.vendor_status,
        verification_status: account.verification_status,
        store_visibility_status: account.store_visibility_status,
        logo_url: account.logo_url,
        banner_url: account.banner_url,
      },
      must_change_password: Boolean(account.must_change_password),
    });
  } catch (err) {
    return handleError(res, 500, 'Vendor login failed', err);
  }
};

const submitVendorApplication = async (req, res) => {
  try {
    const body = req.body || {};
    const storeName = trimOrNull(body.store_name);
    const contactPerson = trimOrNull(body.contact_person || body.owner_name);
    const phone = trimOrNull(body.phone);
    const email = normalizeEmail(body.email);

    if (!storeName) return handleError(res, 400, 'store_name is required');
    if (!contactPerson) return handleError(res, 400, 'contact_person is required');
    if (!phone) return handleError(res, 400, 'phone is required');
    if (!email) return handleError(res, 400, 'email is required');

    const phoneDigits = normalizePhoneDigits(phone);
    if (phoneDigits.length < 9) {
      return handleError(res, 400, 'phone must be a valid contact number');
    }

    const duplicate = await pool.query(
      `
      SELECT id, application_number, status
      FROM vendor_applications
      WHERE status = ANY($1::text[])
        AND (
          LOWER(email) = LOWER($2)
          OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = $3
        )
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [ACTIVE_APPLICATION_STATUSES, email, phoneDigits]
    );

    if (duplicate.rows.length > 0) {
      return handleError(
        res,
        409,
        `A vendor application already exists for this contact (${duplicate.rows[0].application_number}).`
      );
    }

    const existingVendor = await pool.query(
      `
      SELECT id, store_name, status
      FROM vendors
      WHERE LOWER(email) = LOWER($1)
         OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = $2
      LIMIT 1
      `,
      [email, phoneDigits]
    );

    if (existingVendor.rows.length > 0) {
      return handleError(res, 409, 'A vendor store already exists for this contact.');
    }

    const categories = normalizeCategories(body.product_categories);
    const result = await pool.query(
      `
      INSERT INTO vendor_applications
        (
          application_number,
          store_name,
          legal_name,
          contact_person,
          phone,
          email,
          business_type,
          business_registration_no,
          kra_pin,
          national_id,
          address,
          region_id,
          location_id,
          product_categories,
          estimated_skus,
          expected_monthly_sales,
          sample_price_min,
          sample_price_max,
          pricing_notes,
          preferred_plan_id,
          requested_commission_rate,
          requested_monthly_fee,
          fulfillment_preference,
          status
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, $20,
         $21, $22, $23, 'submitted')
      RETURNING *
      `,
      [
        generateApplicationNumber(),
        storeName,
        trimOrNull(body.legal_name || body.business_name),
        contactPerson,
        phone,
        email,
        trimOrNull(body.business_type),
        trimOrNull(body.business_registration_no),
        trimOrNull(body.kra_pin),
        trimOrNull(body.national_id),
        trimOrNull(body.address),
        parseInteger(body.region_id),
        parseInteger(body.location_id),
        JSON.stringify(categories),
        parseInteger(body.estimated_skus),
        parseNumber(body.expected_monthly_sales),
        parseNumber(body.sample_price_min),
        parseNumber(body.sample_price_max),
        trimOrNull(body.pricing_notes),
        parseInteger(body.preferred_plan_id),
        parseNumber(body.requested_commission_rate),
        parseNumber(body.requested_monthly_fee),
        normalizeFulfillmentModel(body.fulfillment_preference),
      ]
    );

    return handleSuccess(res, 201, 'Vendor application submitted', {
      application: result.rows[0],
      next_step: 'XPOSE will review the store, pricing model, product fit, and verification documents before approval.',
    });
  } catch (err) {
    return handleError(res, 500, 'Failed to submit vendor application', err);
  }
};

const listVendorApplications = async (req, res) => {
  try {
    const { status, search } = req.query;
    const params = [];
    let where = 'WHERE 1 = 1';

    if (status && APPLICATION_STATUSES.includes(status)) {
      params.push(status);
      where += ` AND a.status = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      where += `
        AND (
          a.store_name ILIKE $${params.length}
          OR a.contact_person ILIKE $${params.length}
          OR a.email ILIKE $${params.length}
          OR a.phone ILIKE $${params.length}
          OR a.application_number ILIKE $${params.length}
        )
      `;
    }

    const result = await pool.query(
      `
      SELECT
        a.*,
        p.name AS preferred_plan_name,
        v.store_slug AS approved_store_slug,
        v.status AS approved_vendor_status
      FROM vendor_applications a
      LEFT JOIN vendor_subscription_plans p ON p.id = a.preferred_plan_id
      LEFT JOIN vendors v ON v.id = a.approved_vendor_id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT 200
      `,
      params
    );

    return handleSuccess(res, 200, 'Vendor applications retrieved', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve vendor applications', err);
  }
};

const getVendorApplicationById = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        a.*,
        p.name AS preferred_plan_name,
        p.monthly_fee AS preferred_plan_monthly_fee,
        p.commission_rate AS preferred_plan_commission_rate,
        v.store_slug AS approved_store_slug,
        v.status AS approved_vendor_status
      FROM vendor_applications a
      LEFT JOIN vendor_subscription_plans p ON p.id = a.preferred_plan_id
      LEFT JOIN vendors v ON v.id = a.approved_vendor_id
      WHERE a.id = $1
      LIMIT 1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Vendor application not found');
    }

    return handleSuccess(res, 200, 'Vendor application retrieved', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve vendor application', err);
  }
};

const approveVendorApplication = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const applicationResult = await client.query(
      'SELECT * FROM vendor_applications WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );

    if (applicationResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Vendor application not found');
    }

    const application = applicationResult.rows[0];
    if (application.status === 'approved' && application.approved_vendor_id) {
      await client.query('ROLLBACK');
      return handleError(res, 409, 'Vendor application is already approved');
    }

    if (application.status === 'rejected' || application.status === 'withdrawn') {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'Only submitted or under-review applications can be approved');
    }

    const requestedPlanId = parseInteger(req.body?.subscription_plan_id) || application.preferred_plan_id;
    let plan = null;
    if (requestedPlanId) {
      const planResult = await client.query(
        'SELECT * FROM vendor_subscription_plans WHERE id = $1 AND is_active = TRUE',
        [requestedPlanId]
      );
      plan = planResult.rows[0] || null;
    }
    if (!plan) {
      plan = await getDefaultPlan(client);
    }
    if (!plan) {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'No active vendor subscription plan is available');
    }

    const storeSlug = await createUniqueSlug(client, application.store_name);
    const monthlyFee = parseNumber(req.body?.monthly_fee, parseNumber(application.requested_monthly_fee, Number(plan.monthly_fee)));
    const commissionRate = parseNumber(
      req.body?.commission_rate,
      parseNumber(application.requested_commission_rate, Number(plan.commission_rate))
    );
    const maxProducts = parseInteger(req.body?.max_products, Number(plan.max_products));
    const productApprovalRequired = normalizeBoolean(req.body?.product_approval_required, plan.product_approval_required);
    const priceReviewRequired = normalizeBoolean(req.body?.price_review_required, plan.price_review_required);
    const minimumMargin = parseNumber(req.body?.minimum_margin_percent, Number(plan.minimum_margin_percent));
    const allowDiscounts = normalizeBoolean(req.body?.allow_vendor_discounts, plan.allow_vendor_discounts);
    const fulfillmentModel = normalizeFulfillmentModel(req.body?.fulfillment_model, application.fulfillment_preference);
    const actorId = getActorId(req);

    const vendorResult = await client.query(
      `
      INSERT INTO vendors
        (
          store_name,
          store_slug,
          legal_name,
          contact_person,
          phone,
          email,
          business_type,
          business_registration_no,
          kra_pin,
          national_id,
          address,
          region_id,
          location_id,
          product_categories,
          status,
          verification_status,
          subscription_plan_id,
          monthly_fee,
          commission_rate,
          max_products,
          product_approval_required,
          price_review_required,
          minimum_margin_percent,
          allow_vendor_discounts,
          fulfillment_model,
          admin_notes,
          approved_by,
          approved_at
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14::jsonb, 'active', $15, $16, $17, $18, $19,
         $20, $21, $22, $23, $24, $25, $26, NOW())
      RETURNING *
      `,
      [
        application.store_name,
        storeSlug,
        application.legal_name,
        application.contact_person,
        application.phone,
        application.email,
        application.business_type,
        application.business_registration_no,
        application.kra_pin,
        application.national_id,
        application.address,
        application.region_id,
        application.location_id,
        JSON.stringify(application.product_categories || []),
        VERIFICATION_STATUSES.includes(req.body?.verification_status) ? req.body.verification_status : 'verified',
        plan.id,
        monthlyFee,
        commissionRate,
        maxProducts,
        productApprovalRequired,
        priceReviewRequired,
        minimumMargin,
        allowDiscounts,
        fulfillmentModel,
        trimOrNull(req.body?.admin_notes || req.body?.review_notes),
        actorId,
      ]
    );

    const vendor = vendorResult.rows[0];

    const subscriptionResult = await client.query(
      `
      INSERT INTO vendor_subscriptions
        (
          vendor_id,
          plan_id,
          status,
          current_period_start,
          current_period_end,
          amount_due,
          amount_paid,
          next_invoice_at,
          notes
        )
      VALUES
        ($1, $2, $3, NOW(), NOW() + INTERVAL '30 days', $4, 0, NOW() + INTERVAL '30 days', $5)
      RETURNING *
      `,
      [
        vendor.id,
        plan.id,
        req.body?.subscription_status === 'active' ? 'active' : 'trial',
        monthlyFee,
        trimOrNull(req.body?.subscription_notes),
      ]
    );

    let vendorUser = null;
    let temporaryPassword = null;
    if (req.body?.create_owner_user !== false) {
      temporaryPassword = trimOrNull(req.body?.temporary_password) || generateTemporaryPassword();
      const username = await createUniqueUsername(client, vendor.email, vendor.store_slug);
      const passwordHash = await bcrypt.hash(temporaryPassword, 10);

      const userResult = await client.query(
        `
        INSERT INTO vendor_users
          (
            vendor_id,
            full_name,
            email,
            phone,
            username,
            password_hash,
            role,
            status,
            must_change_password
          )
        VALUES ($1, $2, $3, $4, $5, $6, 'owner', 'active', TRUE)
        RETURNING id, vendor_id, full_name, email, phone, username, role, status, must_change_password, created_at
        `,
        [
          vendor.id,
          vendor.contact_person,
          vendor.email,
          vendor.phone,
          username,
          passwordHash,
        ]
      );

      vendorUser = userResult.rows[0];
    }

    await client.query(
      `
      UPDATE vendor_applications
      SET
        status = 'approved',
        admin_review_notes = $1,
        reviewed_by = $2,
        reviewed_at = NOW(),
        approved_vendor_id = $3,
        updated_at = NOW()
      WHERE id = $4
      `,
      [
        trimOrNull(req.body?.review_notes || req.body?.admin_review_notes),
        actorId,
        vendor.id,
        application.id,
      ]
    );

    await client.query(
      `
      INSERT INTO vendor_audit_logs
        (vendor_id, application_id, actor_type, actor_id, action, details)
      VALUES
        ($1, $2, 'admin', $3, 'vendor_application_approved', $4::jsonb)
      `,
      [
        vendor.id,
        application.id,
        actorId,
        JSON.stringify({
          plan_id: plan.id,
          plan_code: plan.code,
          monthly_fee: monthlyFee,
          commission_rate: commissionRate,
          owner_user_created: Boolean(vendorUser),
        }),
      ]
    );

    await client.query('COMMIT');

    return handleSuccess(res, 200, 'Vendor application approved', {
      vendor,
      subscription: subscriptionResult.rows[0],
      owner_user: vendorUser,
      temporary_password: temporaryPassword,
      handling_warning: temporaryPassword
        ? 'Store and share this temporary password securely. It is shown only in this response.'
        : null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return handleError(res, 409, 'Vendor store, email, slug, or owner username already exists');
    }
    return handleError(res, 500, 'Failed to approve vendor application', err);
  } finally {
    client.release();
  }
};

const rejectVendorApplication = async (req, res) => {
  try {
    const reason = trimOrNull(req.body?.rejection_reason || req.body?.reason);
    const notes = trimOrNull(req.body?.admin_review_notes || req.body?.review_notes);

    if (!reason) {
      return handleError(res, 400, 'rejection_reason is required');
    }

    const result = await pool.query(
      `
      UPDATE vendor_applications
      SET
        status = 'rejected',
        rejection_reason = $1,
        admin_review_notes = $2,
        reviewed_by = $3,
        reviewed_at = NOW(),
        updated_at = NOW()
      WHERE id = $4
        AND status IN ('submitted', 'under_review')
      RETURNING *
      `,
      [reason, notes, getActorId(req), req.params.id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Vendor application not found or cannot be rejected');
    }

    await pool.query(
      `
      INSERT INTO vendor_audit_logs
        (application_id, actor_type, actor_id, action, details)
      VALUES ($1, 'admin', $2, 'vendor_application_rejected', $3::jsonb)
      `,
      [
        result.rows[0].id,
        getActorId(req),
        JSON.stringify({ reason }),
      ]
    );

    return handleSuccess(res, 200, 'Vendor application rejected', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to reject vendor application', err);
  }
};

const listVendors = async (req, res) => {
  try {
    const { status, verification_status, search } = req.query;
    const params = [];
    let where = 'WHERE 1 = 1';

    if (status && VENDOR_STATUSES.includes(status)) {
      params.push(status);
      where += ` AND v.status = $${params.length}`;
    }

    if (verification_status && VERIFICATION_STATUSES.includes(verification_status)) {
      params.push(verification_status);
      where += ` AND v.verification_status = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      where += `
        AND (
          v.store_name ILIKE $${params.length}
          OR v.legal_name ILIKE $${params.length}
          OR v.contact_person ILIKE $${params.length}
          OR v.email ILIKE $${params.length}
          OR v.phone ILIKE $${params.length}
        )
      `;
    }

    const result = await pool.query(
      `
      SELECT
        v.*,
        p.name AS plan_name,
        p.code AS plan_code,
        s.status AS subscription_status,
        s.current_period_end AS subscription_current_period_end,
        COALESCE(product_stats.product_count, 0)::int AS product_count,
        COALESCE(product_stats.approved_product_count, 0)::int AS approved_product_count,
        COALESCE(submission_stats.pending_submission_count, 0)::int AS pending_submission_count
      FROM vendors v
      LEFT JOIN vendor_subscription_plans p ON p.id = v.subscription_plan_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM vendor_subscriptions s
        WHERE s.vendor_id = v.id
        ORDER BY s.created_at DESC
        LIMIT 1
      ) s ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS product_count,
          COUNT(*) FILTER (WHERE vendor_approval_status = 'approved') AS approved_product_count
        FROM products p2
        WHERE p2.vendor_id = v.id
      ) product_stats ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS pending_submission_count
        FROM vendor_product_submissions ps
        WHERE ps.vendor_id = v.id
          AND ps.submission_status IN ('submitted', 'changes_requested')
      ) submission_stats ON TRUE
      ${where}
      ORDER BY v.created_at DESC
      LIMIT 200
      `,
      params
    );

    return handleSuccess(res, 200, 'Vendors retrieved', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve vendors', err);
  }
};

const getVendorById = async (req, res) => {
  try {
    const vendorResult = await pool.query(
      `
      SELECT
        v.*,
        p.name AS plan_name,
        p.code AS plan_code
      FROM vendors v
      LEFT JOIN vendor_subscription_plans p ON p.id = v.subscription_plan_id
      WHERE v.id = $1
      LIMIT 1
      `,
      [req.params.id]
    );

    if (vendorResult.rows.length === 0) {
      return handleError(res, 404, 'Vendor not found');
    }

    const [usersResult, subscriptionsResult, submissionsResult, auditResult] = await Promise.all([
      pool.query(
        `
        SELECT id, full_name, email, phone, username, role, status, must_change_password, last_login_at, created_at
        FROM vendor_users
        WHERE vendor_id = $1
        ORDER BY created_at ASC
        `,
        [req.params.id]
      ),
      pool.query(
        `
        SELECT s.*, p.name AS plan_name, p.code AS plan_code
        FROM vendor_subscriptions s
        LEFT JOIN vendor_subscription_plans p ON p.id = s.plan_id
        WHERE s.vendor_id = $1
        ORDER BY s.created_at DESC
        LIMIT 10
        `,
        [req.params.id]
      ),
      pool.query(
        `
        SELECT id, product_name, sku, submission_status, proposed_retail_price, proposed_wholesale_price, current_stock, created_at, submitted_at, reviewed_at
        FROM vendor_product_submissions
        WHERE vendor_id = $1
        ORDER BY created_at DESC
        LIMIT 20
        `,
        [req.params.id]
      ),
      pool.query(
        `
        SELECT id, actor_type, actor_id, action, details, created_at
        FROM vendor_audit_logs
        WHERE vendor_id = $1
        ORDER BY created_at DESC
        LIMIT 30
        `,
        [req.params.id]
      ),
    ]);

    return handleSuccess(res, 200, 'Vendor retrieved', {
      vendor: vendorResult.rows[0],
      users: usersResult.rows,
      subscriptions: subscriptionsResult.rows,
      product_submissions: submissionsResult.rows,
      audit_logs: auditResult.rows,
    });
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve vendor', err);
  }
};

const updateVendor = async (req, res) => {
  try {
    const body = req.body || {};
    const allowedUpdates = [];
    const params = [];

    function addUpdate(column, value) {
      if (value === undefined) return;
      params.push(value);
      allowedUpdates.push(`${column} = $${params.length}`);
    }

    if (body.status !== undefined) {
      if (!VENDOR_STATUSES.includes(body.status)) return handleError(res, 400, 'Invalid vendor status');
      addUpdate('status', body.status);
      if (body.status === 'suspended') addUpdate('suspended_at', new Date());
    }

    if (body.verification_status !== undefined) {
      if (!VERIFICATION_STATUSES.includes(body.verification_status)) {
        return handleError(res, 400, 'Invalid verification status');
      }
      addUpdate('verification_status', body.verification_status);
    }

    if (body.subscription_plan_id !== undefined) addUpdate('subscription_plan_id', parseInteger(body.subscription_plan_id));
    if (body.monthly_fee !== undefined) addUpdate('monthly_fee', parseNumber(body.monthly_fee, 0));
    if (body.commission_rate !== undefined) addUpdate('commission_rate', parseNumber(body.commission_rate, 0));
    if (body.max_products !== undefined) addUpdate('max_products', parseInteger(body.max_products, 0));
    if (body.product_approval_required !== undefined) addUpdate('product_approval_required', normalizeBoolean(body.product_approval_required, true));
    if (body.price_review_required !== undefined) addUpdate('price_review_required', normalizeBoolean(body.price_review_required, true));
    if (body.minimum_margin_percent !== undefined) addUpdate('minimum_margin_percent', parseNumber(body.minimum_margin_percent, 0));
    if (body.allow_vendor_discounts !== undefined) addUpdate('allow_vendor_discounts', normalizeBoolean(body.allow_vendor_discounts, false));
    if (body.fulfillment_model !== undefined) addUpdate('fulfillment_model', normalizeFulfillmentModel(body.fulfillment_model));
    if (body.admin_notes !== undefined) addUpdate('admin_notes', trimOrNull(body.admin_notes));
    if (body.payout_phone !== undefined) addUpdate('payout_phone', trimOrNull(body.payout_phone));
    if (body.payout_name !== undefined) addUpdate('payout_name', trimOrNull(body.payout_name));
    if (body.payout_notes !== undefined) addUpdate('payout_notes', trimOrNull(body.payout_notes));

    if (allowedUpdates.length === 0) {
      return handleError(res, 400, 'No valid vendor fields were provided');
    }

    params.push(req.params.id);
    const result = await pool.query(
      `
      UPDATE vendors
      SET ${allowedUpdates.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING *
      `,
      params
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Vendor not found');
    }

    await pool.query(
      `
      INSERT INTO vendor_audit_logs
        (vendor_id, actor_type, actor_id, action, details)
      VALUES ($1, 'admin', $2, 'vendor_updated', $3::jsonb)
      `,
      [
        result.rows[0].id,
        getActorId(req),
        JSON.stringify({ fields: Object.keys(body) }),
      ]
    );

    return handleSuccess(res, 200, 'Vendor updated', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to update vendor', err);
  }
};

const getVendorMe = async (req, res) => {
  try {
    const vendorId = req.vendorUser.vendor_id;
    const [vendorResult, subscriptionResult, statsResult] = await Promise.all([
      pool.query(
        `
        SELECT
          v.*,
          p.name AS plan_name,
          p.code AS plan_code
        FROM vendors v
        LEFT JOIN vendor_subscription_plans p ON p.id = v.subscription_plan_id
        WHERE v.id = $1
        LIMIT 1
        `,
        [vendorId]
      ),
      pool.query(
        `
        SELECT s.*, p.name AS plan_name, p.code AS plan_code
        FROM vendor_subscriptions s
        LEFT JOIN vendor_subscription_plans p ON p.id = s.plan_id
        WHERE s.vendor_id = $1
        ORDER BY s.created_at DESC
        LIMIT 1
        `,
        [vendorId]
      ),
      pool.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE p.vendor_approval_status = 'approved')::int AS approved_products,
          COUNT(*) FILTER (WHERE p.vendor_approval_status = 'approved' AND COALESCE(p.is_active, TRUE) = TRUE)::int AS live_products,
          COALESCE((
            SELECT COUNT(*)
            FROM vendor_product_submissions ps
            WHERE ps.vendor_id = $1
              AND ps.submission_status IN ('submitted', 'changes_requested')
          ), 0)::int AS pending_submissions
        FROM products p
        WHERE p.vendor_id = $1
        `,
        [vendorId]
      ),
    ]);

    return handleSuccess(res, 200, 'Vendor workspace retrieved', {
      vendor_user: req.vendorUser,
      vendor: vendorResult.rows[0] || req.vendor,
      subscription: subscriptionResult.rows[0] || null,
      stats: statsResult.rows[0] || { approved_products: 0, live_products: 0, pending_submissions: 0 },
    });
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve vendor workspace', err);
  }
};

const changeVendorPassword = async (req, res) => {
  try {
    const currentPassword = String(req.body?.current_password || '');
    const newPassword = String(req.body?.new_password || '');

    if (!currentPassword || !newPassword) {
      return handleError(res, 400, 'current_password and new_password are required');
    }

    if (newPassword.length < 10) {
      return handleError(res, 400, 'New password must be at least 10 characters');
    }

    const userResult = await pool.query(
      'SELECT id, password_hash FROM vendor_users WHERE id = $1 AND vendor_id = $2 LIMIT 1',
      [req.vendorUser.id, req.vendorUser.vendor_id]
    );

    if (userResult.rows.length === 0) {
      return handleError(res, 404, 'Vendor user not found');
    }

    const valid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
    if (!valid) {
      return handleError(res, 401, 'Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `
      UPDATE vendor_users
      SET password_hash = $1,
          must_change_password = FALSE,
          password_changed_at = NOW(),
          updated_at = NOW()
      WHERE id = $2
      `,
      [passwordHash, req.vendorUser.id]
    );

    await pool.query(
      `
      INSERT INTO vendor_audit_logs (vendor_id, actor_type, actor_id, action, details)
      VALUES ($1, 'vendor', $2, 'vendor_password_changed', '{}'::jsonb)
      `,
      [req.vendorUser.vendor_id, req.vendorUser.id]
    );

    return handleSuccess(res, 200, 'Vendor password updated');
  } catch (err) {
    return handleError(res, 500, 'Failed to update vendor password', err);
  }
};

const updateMyVendorProfile = async (req, res) => {
  try {
    const body = req.body || {};
    const updates = [];
    const params = [];

    function addUpdate(column, value) {
      if (value === undefined) return;
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    }

    if (body.public_description !== undefined) addUpdate('public_description', trimOrNull(body.public_description));
    if (body.support_phone !== undefined) addUpdate('support_phone', trimOrNull(body.support_phone));
    if (body.support_email !== undefined) addUpdate('support_email', normalizeEmail(body.support_email));
    if (body.website_url !== undefined) addUpdate('website_url', normalizeOptionalUrl(body.website_url));
    if (body.logo_url !== undefined) addUpdate('logo_url', trimOrNull(body.logo_url));
    if (body.banner_url !== undefined) addUpdate('banner_url', trimOrNull(body.banner_url));
    if (body.payout_phone !== undefined) addUpdate('payout_phone', trimOrNull(body.payout_phone));
    if (body.payout_name !== undefined) addUpdate('payout_name', trimOrNull(body.payout_name));
    if (body.payout_notes !== undefined) addUpdate('payout_notes', trimOrNull(body.payout_notes));

    if (body.store_visibility_status !== undefined) {
      const visibility = String(body.store_visibility_status || '').trim().toLowerCase();
      if (!['public', 'hidden'].includes(visibility)) {
        return handleError(res, 400, 'store_visibility_status must be public or hidden');
      }
      if (visibility === 'public' && req.vendor.verification_status !== 'verified') {
        return handleError(res, 400, 'Only verified vendors can publish a public store');
      }
      addUpdate('store_visibility_status', visibility);
      if (visibility === 'public') addUpdate('published_at', new Date());
    }

    if (updates.length === 0) {
      return handleError(res, 400, 'No valid profile fields were provided');
    }

    params.push(req.vendorUser.vendor_id);
    const result = await pool.query(
      `
      UPDATE vendors
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING *
      `,
      params
    );

    await pool.query(
      `
      INSERT INTO vendor_audit_logs (vendor_id, actor_type, actor_id, action, details)
      VALUES ($1, 'vendor', $2, 'vendor_profile_updated', $3::jsonb)
      `,
      [req.vendorUser.vendor_id, req.vendorUser.id, JSON.stringify({ fields: Object.keys(body) })]
    );

    return handleSuccess(res, 200, 'Vendor profile updated', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to update vendor profile', err);
  }
};

function readProductSubmissionPayload(body = {}, existing = {}) {
  const productName = trimOrNull(body.product_name ?? body.name ?? existing.product_name);
  if (!productName) throw new Error('product_name is required');

  const categoryId = parseInteger(body.category_id ?? existing.category_id);
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    throw new Error('category_id is required');
  }

  const retailPrice = requirePositiveMoney(body.proposed_retail_price ?? body.retail_price ?? existing.proposed_retail_price, 'proposed_retail_price');
  const wholesalePrice = requireNonNegativeMoney(
    body.proposed_wholesale_price ?? body.wholesale_price ?? existing.proposed_wholesale_price,
    'proposed_wholesale_price',
    null
  );
  const costPrice = requireNonNegativeMoney(
    body.proposed_cost_price ?? body.cost_price ?? existing.proposed_cost_price,
    'proposed_cost_price',
    null
  );

  return {
    product_name: productName,
    sku: trimOrNull(body.sku ?? existing.sku),
    brand_name: trimOrNull(body.brand_name ?? existing.brand_name),
    category_id: categoryId,
    description: trimOrNull(body.description ?? existing.description),
    image_url: trimOrNull(body.image_url ?? existing.image_url),
    proposed_retail_price: retailPrice,
    proposed_wholesale_price: wholesalePrice,
    proposed_cost_price: costPrice,
    min_order_qty: requirePositiveInteger(body.min_order_qty ?? existing.min_order_qty, 'min_order_qty', 1),
    order_qty_step: requirePositiveInteger(body.order_qty_step ?? existing.order_qty_step, 'order_qty_step', 1),
    current_stock: requireNonNegativeInteger(body.current_stock ?? existing.current_stock, 'current_stock', 0),
    selling_unit_label: trimOrNull(body.selling_unit_label ?? existing.selling_unit_label) || 'piece',
    fulfillment_model: normalizeFulfillmentModel(body.fulfillment_model ?? existing.fulfillment_model, 'xpose_reviewed'),
    product_tags: normalizeTags(body.product_tags ?? existing.product_tags),
    is_featured_requested: normalizeBoolean(body.is_featured_requested ?? existing.is_featured_requested, false),
    vendor_notes: trimOrNull(body.vendor_notes ?? existing.vendor_notes),
  };
}

async function assertVendorCanSubmitProduct(vendorId) {
  const result = await pool.query(
    `
    SELECT
      v.max_products,
      COUNT(p.id) FILTER (WHERE p.vendor_approval_status = 'approved')::int AS approved_products
    FROM vendors v
    LEFT JOIN products p ON p.vendor_id = v.id AND p.product_owner_type = 'vendor'
    WHERE v.id = $1
    GROUP BY v.id
    `,
    [vendorId]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Vendor store not found');
  if (Number(row.max_products) > 0 && Number(row.approved_products) >= Number(row.max_products)) {
    throw new Error('Vendor product limit reached. Contact XPOSE to upgrade the store plan.');
  }
}

const listMyVendorProductSubmissions = async (req, res) => {
  try {
    const { status } = req.query;
    const params = [req.vendorUser.vendor_id];
    const where = ['ps.vendor_id = $1'];

    if (status && PRODUCT_SUBMISSION_STATUSES.includes(status)) {
      params.push(status);
      where.push(`ps.submission_status = $${params.length}`);
    }

    const result = await pool.query(
      `
      SELECT
        ps.*,
        c.name AS category_name,
        p.id AS live_product_id,
        p.name AS live_product_name,
        p.vendor_approval_status AS live_product_status
      FROM vendor_product_submissions ps
      LEFT JOIN categories c ON c.id = ps.category_id
      LEFT JOIN products p ON p.id = ps.product_id
      WHERE ${where.join(' AND ')}
      ORDER BY ps.created_at DESC
      LIMIT 200
      `,
      params
    );

    return handleSuccess(res, 200, 'Vendor product submissions retrieved', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve vendor product submissions', err);
  }
};

const createMyVendorProductSubmission = async (req, res) => {
  try {
    await assertVendorCanSubmitProduct(req.vendorUser.vendor_id);
    const payload = readProductSubmissionPayload(req.body);
    const shouldSubmit = req.body?.submit === true || req.body?.submission_status === 'submitted';

    const result = await pool.query(
      `
      INSERT INTO vendor_product_submissions
        (
          vendor_id,
          submission_status,
          product_name,
          sku,
          brand_name,
          category_id,
          description,
          image_url,
          proposed_retail_price,
          proposed_wholesale_price,
          proposed_cost_price,
          min_order_qty,
          order_qty_step,
          current_stock,
          selling_unit_label,
          fulfillment_model,
          commission_rate,
          minimum_margin_percent,
          price_review_required,
          product_tags,
          is_featured_requested,
          vendor_notes,
          submitted_at
        )
      SELECT
        v.id,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        v.commission_rate,
        v.minimum_margin_percent,
        v.price_review_required,
        $17::jsonb,
        $18,
        $19,
        CASE WHEN $2 = 'submitted' THEN NOW() ELSE NULL END
      FROM vendors v
      WHERE v.id = $1
      RETURNING *
      `,
      [
        req.vendorUser.vendor_id,
        shouldSubmit ? 'submitted' : 'draft',
        payload.product_name,
        payload.sku,
        payload.brand_name,
        payload.category_id,
        payload.description,
        payload.image_url,
        payload.proposed_retail_price,
        payload.proposed_wholesale_price,
        payload.proposed_cost_price,
        payload.min_order_qty,
        payload.order_qty_step,
        payload.current_stock,
        payload.selling_unit_label,
        payload.fulfillment_model,
        JSON.stringify(payload.product_tags),
        payload.is_featured_requested,
        payload.vendor_notes,
      ]
    );

    if (shouldSubmit) {
      await pool.query('UPDATE vendors SET last_product_submission_at = NOW(), updated_at = NOW() WHERE id = $1', [
        req.vendorUser.vendor_id,
      ]);
    }

    await pool.query(
      `
      INSERT INTO vendor_audit_logs (vendor_id, actor_type, actor_id, action, details)
      VALUES ($1, 'vendor', $2, $3, $4::jsonb)
      `,
      [
        req.vendorUser.vendor_id,
        req.vendorUser.id,
        shouldSubmit ? 'vendor_product_submitted' : 'vendor_product_draft_created',
        JSON.stringify({ submission_id: result.rows[0].id }),
      ]
    );

    return handleSuccess(res, 201, shouldSubmit ? 'Product submitted for XPOSE review' : 'Product draft created', result.rows[0]);
  } catch (err) {
    return handleError(res, 400, err.message || 'Failed to create vendor product submission', err);
  }
};

const updateMyVendorProductSubmission = async (req, res) => {
  try {
    const existingResult = await pool.query(
      `
      SELECT *
      FROM vendor_product_submissions
      WHERE id = $1
        AND vendor_id = $2
      LIMIT 1
      `,
      [req.params.id, req.vendorUser.vendor_id]
    );

    if (existingResult.rows.length === 0) {
      return handleError(res, 404, 'Vendor product submission not found');
    }

    const existing = existingResult.rows[0];
    if (!['draft', 'changes_requested'].includes(existing.submission_status)) {
      return handleError(res, 400, 'Only draft or changes-requested submissions can be edited');
    }

    await assertVendorCanSubmitProduct(req.vendorUser.vendor_id);
    const payload = readProductSubmissionPayload(req.body, existing);
    const shouldSubmit = req.body?.submit === true || req.body?.submission_status === 'submitted';

    const result = await pool.query(
      `
      UPDATE vendor_product_submissions
      SET
        submission_status = $1,
        product_name = $2,
        sku = $3,
        brand_name = $4,
        category_id = $5,
        description = $6,
        image_url = $7,
        proposed_retail_price = $8,
        proposed_wholesale_price = $9,
        proposed_cost_price = $10,
        min_order_qty = $11,
        order_qty_step = $12,
        current_stock = $13,
        selling_unit_label = $14,
        fulfillment_model = $15,
        product_tags = $16::jsonb,
        is_featured_requested = $17,
        vendor_notes = $18,
        submitted_at = CASE WHEN $1 = 'submitted' THEN COALESCE(submitted_at, NOW()) ELSE submitted_at END,
        updated_at = NOW()
      WHERE id = $19
        AND vendor_id = $20
      RETURNING *
      `,
      [
        shouldSubmit ? 'submitted' : existing.submission_status,
        payload.product_name,
        payload.sku,
        payload.brand_name,
        payload.category_id,
        payload.description,
        payload.image_url,
        payload.proposed_retail_price,
        payload.proposed_wholesale_price,
        payload.proposed_cost_price,
        payload.min_order_qty,
        payload.order_qty_step,
        payload.current_stock,
        payload.selling_unit_label,
        payload.fulfillment_model,
        JSON.stringify(payload.product_tags),
        payload.is_featured_requested,
        payload.vendor_notes,
        req.params.id,
        req.vendorUser.vendor_id,
      ]
    );

    if (shouldSubmit) {
      await pool.query('UPDATE vendors SET last_product_submission_at = NOW(), updated_at = NOW() WHERE id = $1', [
        req.vendorUser.vendor_id,
      ]);
    }

    await pool.query(
      `
      INSERT INTO vendor_audit_logs (vendor_id, actor_type, actor_id, action, details)
      VALUES ($1, 'vendor', $2, $3, $4::jsonb)
      `,
      [
        req.vendorUser.vendor_id,
        req.vendorUser.id,
        shouldSubmit ? 'vendor_product_submitted' : 'vendor_product_draft_updated',
        JSON.stringify({ submission_id: result.rows[0].id }),
      ]
    );

    return handleSuccess(res, 200, shouldSubmit ? 'Product submitted for XPOSE review' : 'Product submission updated', result.rows[0]);
  } catch (err) {
    return handleError(res, 400, err.message || 'Failed to update vendor product submission', err);
  }
};

const submitMyVendorProductSubmission = async (req, res) => {
  try {
    await assertVendorCanSubmitProduct(req.vendorUser.vendor_id);
    const result = await pool.query(
      `
      UPDATE vendor_product_submissions
      SET submission_status = 'submitted',
          submitted_at = COALESCE(submitted_at, NOW()),
          updated_at = NOW()
      WHERE id = $1
        AND vendor_id = $2
        AND submission_status IN ('draft', 'changes_requested')
      RETURNING *
      `,
      [req.params.id, req.vendorUser.vendor_id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Vendor product submission not found or cannot be submitted');
    }

    await pool.query('UPDATE vendors SET last_product_submission_at = NOW(), updated_at = NOW() WHERE id = $1', [
      req.vendorUser.vendor_id,
    ]);

    await pool.query(
      `
      INSERT INTO vendor_audit_logs (vendor_id, actor_type, actor_id, action, details)
      VALUES ($1, 'vendor', $2, 'vendor_product_submitted', $3::jsonb)
      `,
      [req.vendorUser.vendor_id, req.vendorUser.id, JSON.stringify({ submission_id: result.rows[0].id })]
    );

    return handleSuccess(res, 200, 'Product submitted for XPOSE review', result.rows[0]);
  } catch (err) {
    return handleError(res, 400, err.message || 'Failed to submit vendor product', err);
  }
};

const listVendorPlans = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM vendor_subscription_plans ORDER BY is_active DESC, monthly_fee ASC, id ASC'
    );
    return handleSuccess(res, 200, 'Vendor plans retrieved', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve vendor plans', err);
  }
};

const createVendorPlan = async (req, res) => {
  try {
    const payload = mapPlanPayload(req.body);
    if (!payload.code) return handleError(res, 400, 'code is required');
    if (!payload.name) return handleError(res, 400, 'name is required');

    const result = await pool.query(
      `
      INSERT INTO vendor_subscription_plans
        (
          code,
          name,
          description,
          monthly_fee,
          commission_rate,
          max_products,
          featured_slots,
          product_approval_required,
          price_review_required,
          minimum_margin_percent,
          allow_vendor_discounts,
          is_active
        )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
      `,
      [
        payload.code,
        payload.name,
        payload.description,
        payload.monthly_fee,
        payload.commission_rate,
        payload.max_products,
        payload.featured_slots,
        payload.product_approval_required,
        payload.price_review_required,
        payload.minimum_margin_percent,
        payload.allow_vendor_discounts,
        payload.is_active,
      ]
    );

    return handleSuccess(res, 201, 'Vendor plan created', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return handleError(res, 409, 'Vendor plan code already exists');
    return handleError(res, 500, 'Failed to create vendor plan', err);
  }
};

const updateVendorPlan = async (req, res) => {
  try {
    const payload = readPlanUpdate(req.body);
    const updates = [];
    const params = [];

    Object.entries(payload).forEach(([column, value]) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    });

    if (updates.length === 0) {
      return handleError(res, 400, 'No valid vendor plan fields were provided');
    }

    params.push(req.params.id);
    const result = await pool.query(
      `
      UPDATE vendor_subscription_plans
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING *
      `,
      params
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Vendor plan not found');
    }

    return handleSuccess(res, 200, 'Vendor plan updated', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to update vendor plan', err);
  }
};

async function createUniqueProductSku(client, vendorId, submissionId, rawSku, productName) {
  const base = trimOrNull(rawSku) || `V${vendorId}-${submissionId}-${slugify(productName).slice(0, 18)}`;
  let sku = base.toUpperCase();
  let suffix = 2;

  while (suffix < 1000) {
    const check = await client.query('SELECT id FROM products WHERE LOWER(sku) = LOWER($1) LIMIT 1', [sku]);
    if (check.rows.length === 0) return sku;
    sku = `${base}-${suffix}`.toUpperCase();
    suffix += 1;
  }

  return `${base}-${Date.now()}`.toUpperCase();
}

function deriveStockOverride(currentStock, minOrderQty) {
  if (Number(currentStock || 0) <= 0) return 'out_of_stock';
  if (Number(currentStock || 0) <= Math.max(Number(minOrderQty || 1), 10)) return 'limited_stock';
  return null;
}

const listVendorProductSubmissions = async (req, res) => {
  try {
    const { status, vendor_id, search } = req.query;
    const params = [];
    const where = ['1=1'];

    if (status && PRODUCT_SUBMISSION_STATUSES.includes(status)) {
      params.push(status);
      where.push(`ps.submission_status = $${params.length}`);
    }

    const vendorId = parseInteger(vendor_id);
    if (vendorId) {
      params.push(vendorId);
      where.push(`ps.vendor_id = $${params.length}`);
    }

    if (search) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(
        ps.product_name ILIKE $${params.length}
        OR COALESCE(ps.sku, '') ILIKE $${params.length}
        OR v.store_name ILIKE $${params.length}
        OR COALESCE(c.name, '') ILIKE $${params.length}
      )`);
    }

    const result = await pool.query(
      `
      SELECT
        ps.*,
        v.store_name,
        v.store_slug,
        v.status AS vendor_status,
        v.verification_status,
        c.name AS category_name,
        p.id AS live_product_id,
        p.vendor_approval_status AS live_product_status
      FROM vendor_product_submissions ps
      JOIN vendors v ON v.id = ps.vendor_id
      LEFT JOIN categories c ON c.id = ps.category_id
      LEFT JOIN products p ON p.id = ps.product_id
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE ps.submission_status
          WHEN 'submitted' THEN 0
          WHEN 'changes_requested' THEN 1
          WHEN 'draft' THEN 2
          ELSE 3
        END,
        ps.created_at DESC
      LIMIT 250
      `,
      params
    );

    return handleSuccess(res, 200, 'Vendor product submissions retrieved', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve vendor product submissions', err);
  }
};

const getVendorProductSubmissionById = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        ps.*,
        v.store_name,
        v.store_slug,
        v.status AS vendor_status,
        v.verification_status,
        v.commission_rate AS vendor_default_commission_rate,
        v.minimum_margin_percent AS vendor_default_minimum_margin,
        c.name AS category_name,
        p.id AS live_product_id,
        p.name AS live_product_name,
        p.vendor_approval_status AS live_product_status
      FROM vendor_product_submissions ps
      JOIN vendors v ON v.id = ps.vendor_id
      LEFT JOIN categories c ON c.id = ps.category_id
      LEFT JOIN products p ON p.id = ps.product_id
      WHERE ps.id = $1
      LIMIT 1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Vendor product submission not found');
    }

    return handleSuccess(res, 200, 'Vendor product submission retrieved', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve vendor product submission', err);
  }
};

const approveVendorProductSubmission = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const submissionResult = await client.query(
      `
      SELECT
        ps.*,
        v.status AS vendor_status,
        v.verification_status,
        v.max_products,
        v.store_name,
        v.commission_rate AS vendor_commission_rate,
        v.minimum_margin_percent AS vendor_minimum_margin
      FROM vendor_product_submissions ps
      JOIN vendors v ON v.id = ps.vendor_id
      WHERE ps.id = $1
      FOR UPDATE OF ps
      `,
      [req.params.id]
    );

    if (submissionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Vendor product submission not found');
    }

    const submission = submissionResult.rows[0];
    if (!['submitted', 'changes_requested'].includes(submission.submission_status)) {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'Only submitted or changes-requested products can be approved');
    }

    if (submission.vendor_status !== 'active') {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'Vendor store must be active before products can be approved');
    }

    const countResult = await client.query(
      `
      SELECT COUNT(*)::int AS approved_products
      FROM products
      WHERE vendor_id = $1
        AND product_owner_type = 'vendor'
        AND vendor_approval_status = 'approved'
      `,
      [submission.vendor_id]
    );

    if (Number(submission.max_products) > 0 && Number(countResult.rows[0].approved_products) >= Number(submission.max_products)) {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'Vendor product limit reached. Upgrade the vendor plan before approving more products.');
    }

    const retailPrice = requirePositiveMoney(req.body?.retail_price ?? submission.proposed_retail_price, 'retail_price');
    const wholesalePrice = requireNonNegativeMoney(
      req.body?.wholesale_price ?? submission.proposed_wholesale_price ?? retailPrice,
      'wholesale_price',
      retailPrice
    );
    const costPrice = requireNonNegativeMoney(
      req.body?.cost_price ?? submission.proposed_cost_price,
      'cost_price',
      null
    );
    const commissionRate = requireNonNegativeMoney(
      req.body?.commission_rate ?? submission.commission_rate ?? submission.vendor_commission_rate,
      'commission_rate',
      0
    );
    if (commissionRate > 100) {
      await client.query('ROLLBACK');
      return handleError(res, 400, 'commission_rate cannot exceed 100');
    }

    const vendorNetPrice = requireNonNegativeMoney(
      req.body?.vendor_net_price,
      'vendor_net_price',
      Number((retailPrice * (1 - commissionRate / 100)).toFixed(2))
    );
    const sku = await createUniqueProductSku(client, submission.vendor_id, submission.id, req.body?.sku || submission.sku, submission.product_name);
    const stockOverride = deriveStockOverride(submission.current_stock, submission.min_order_qty);

    const productResult = await client.query(
      `
      INSERT INTO products
        (
          name,
          description,
          sku,
          barcode,
          category_id,
          department_id,
          current_stock,
          stock_status_override,
          cost_price,
          retail_price,
          wholesale_price,
          min_qty_wholesale,
          requires_manual_price,
          image_url,
          pricing_rule_id,
          min_order_qty,
          order_qty_step,
          selling_unit_label,
          reorder_level,
          is_combo_eligible,
          is_active,
          vendor_id,
          product_owner_type,
          vendor_approval_status,
          vendor_product_submission_id,
          vendor_commission_rate,
          vendor_net_price,
          vendor_price_reviewed_at,
          vendor_price_review_notes
        )
      VALUES
        ($1,$2,$3,NULL,$4,NULL,$5,$6,$7,$8,$9,NULL,FALSE,$10,NULL,$11,$12,$13,10,FALSE,TRUE,
         $14,'vendor','approved',$15,$16,$17,NOW(),$18)
      RETURNING *
      `,
      [
        submission.product_name,
        submission.description,
        sku,
        submission.category_id,
        submission.current_stock,
        stockOverride,
        costPrice,
        retailPrice,
        wholesalePrice,
        submission.image_url,
        submission.min_order_qty,
        submission.order_qty_step,
        submission.selling_unit_label || 'piece',
        submission.vendor_id,
        submission.id,
        commissionRate,
        vendorNetPrice,
        trimOrNull(req.body?.price_review_notes || submission.price_review_notes || submission.admin_review_notes),
      ]
    );

    const updatedSubmission = await client.query(
      `
      UPDATE vendor_product_submissions
      SET submission_status = 'approved',
          product_id = $1,
          commission_rate = $2,
          vendor_net_price = $3,
          price_review_notes = $4,
          admin_review_notes = $5,
          reviewed_by = $6,
          reviewed_at = NOW(),
          updated_at = NOW()
      WHERE id = $7
      RETURNING *
      `,
      [
        productResult.rows[0].id,
        commissionRate,
        vendorNetPrice,
        trimOrNull(req.body?.price_review_notes || submission.price_review_notes),
        trimOrNull(req.body?.admin_review_notes || req.body?.review_notes),
        getActorId(req),
        submission.id,
      ]
    );

    await client.query(
      `
      INSERT INTO vendor_audit_logs (vendor_id, actor_type, actor_id, action, details)
      VALUES ($1, 'admin', $2, 'vendor_product_approved', $3::jsonb)
      `,
      [
        submission.vendor_id,
        getActorId(req),
        JSON.stringify({ submission_id: submission.id, product_id: productResult.rows[0].id, sku }),
      ]
    );

    await client.query('COMMIT');

    return handleSuccess(res, 200, 'Vendor product approved and published', {
      submission: updatedSubmission.rows[0],
      product: productResult.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return handleError(res, 409, 'Product SKU already exists');
    }
    if (err.code === '23503') {
      return handleError(res, 400, 'Invalid category or vendor reference', err);
    }
    return handleError(res, 500, 'Failed to approve vendor product', err);
  } finally {
    client.release();
  }
};

const requestVendorProductChanges = async (req, res) => {
  try {
    const notes = trimOrNull(req.body?.admin_review_notes || req.body?.review_notes || req.body?.reason);
    if (!notes) {
      return handleError(res, 400, 'Review notes are required when requesting changes');
    }

    const result = await pool.query(
      `
      UPDATE vendor_product_submissions
      SET submission_status = 'changes_requested',
          admin_review_notes = $1,
          reviewed_by = $2,
          reviewed_at = NOW(),
          updated_at = NOW()
      WHERE id = $3
        AND submission_status = 'submitted'
      RETURNING *
      `,
      [notes, getActorId(req), req.params.id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Vendor product submission not found or cannot be changed');
    }

    await pool.query(
      `
      INSERT INTO vendor_audit_logs (vendor_id, actor_type, actor_id, action, details)
      VALUES ($1, 'admin', $2, 'vendor_product_changes_requested', $3::jsonb)
      `,
      [result.rows[0].vendor_id, getActorId(req), JSON.stringify({ submission_id: result.rows[0].id, notes })]
    );

    return handleSuccess(res, 200, 'Product changes requested', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to request vendor product changes', err);
  }
};

const rejectVendorProductSubmission = async (req, res) => {
  try {
    const reason = trimOrNull(req.body?.rejection_reason || req.body?.reason);
    if (!reason) {
      return handleError(res, 400, 'rejection_reason is required');
    }

    const result = await pool.query(
      `
      UPDATE vendor_product_submissions
      SET submission_status = 'rejected',
          rejection_reason = $1,
          admin_review_notes = $2,
          reviewed_by = $3,
          reviewed_at = NOW(),
          updated_at = NOW()
      WHERE id = $4
        AND submission_status IN ('submitted', 'changes_requested')
      RETURNING *
      `,
      [
        reason,
        trimOrNull(req.body?.admin_review_notes || req.body?.review_notes),
        getActorId(req),
        req.params.id,
      ]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Vendor product submission not found or cannot be rejected');
    }

    await pool.query(
      `
      INSERT INTO vendor_audit_logs (vendor_id, actor_type, actor_id, action, details)
      VALUES ($1, 'admin', $2, 'vendor_product_rejected', $3::jsonb)
      `,
      [result.rows[0].vendor_id, getActorId(req), JSON.stringify({ submission_id: result.rows[0].id, reason })]
    );

    return handleSuccess(res, 200, 'Vendor product rejected', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to reject vendor product', err);
  }
};

module.exports = {
  listPublicVendorPlans,
  listPublicVendorStores,
  getPublicVendorStoreBySlug,
  loginVendor,
  submitVendorApplication,
  listVendorApplications,
  getVendorApplicationById,
  approveVendorApplication,
  rejectVendorApplication,
  listVendors,
  getVendorById,
  updateVendor,
  getVendorMe,
  changeVendorPassword,
  updateMyVendorProfile,
  listMyVendorProductSubmissions,
  createMyVendorProductSubmission,
  updateMyVendorProductSubmission,
  submitMyVendorProductSubmission,
  listVendorPlans,
  createVendorPlan,
  updateVendorPlan,
  listVendorProductSubmissions,
  getVendorProductSubmissionById,
  approveVendorProductSubmission,
  requestVendorProductChanges,
  rejectVendorProductSubmission,
};
