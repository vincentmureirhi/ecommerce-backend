const pool = require('../config/database');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { handleError, handleSuccess } = require('../utils/errorHandler');

const JWT_SECRET = process.env.JWT_SECRET;
const SALES_REP_TOKEN_EXPIRY = '24h';

function normalizeNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBooleanInput(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'active'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', 'inactive'].includes(normalized)) return false;
  }
  return fallback;
}

function generateTemporaryPassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars.charAt(crypto.randomInt(0, chars.length));
  }
  return out;
}

function signSalesRepToken(rep) {
  if (!JWT_SECRET) {
    throw new Error('JWT secret is not configured');
  }
  return jwt.sign(
    {
      token_type: 'sales_rep',
      role: 'sales_rep',
      sales_rep_id: rep.id,
    },
    JWT_SECRET,
    { expiresIn: SALES_REP_TOKEN_EXPIRY }
  );
}

function validateTemporaryPassword(value) {
  if (!value || String(value).length < 8) {
    const err = new Error('temporary_password must be at least 8 characters');
    err.status = 400;
    throw err;
  }
}

function normalizeSalesRepResponse(rep) {
  return {
    id: rep.id,
    full_name: rep.full_name || rep.name,
    phone: rep.phone || rep.phone_number || null,
    email: rep.email || null,
    username: rep.username || null,
    route_area: rep.route_area || null,
    must_change_password: Boolean(rep.must_change_password),
    is_active: Boolean(rep.is_active),
    role: 'sales_rep',
    status: rep.status || (rep.is_active ? 'active' : 'inactive'),
    last_login_at: rep.last_login_at || null,
    created_at: rep.created_at,
    updated_at: rep.updated_at,
  };
}

async function getSalesRepByIdForAuth(id) {
  const result = await pool.query(
    `
    SELECT
      id,
      name,
      full_name,
      phone_number,
      phone,
      email,
      username,
      password_hash,
      must_change_password,
      is_active,
      route_area,
      status,
      created_at,
      updated_at,
      last_login_at
    FROM sales_reps
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

// Get all sales reps with actual performance metrics + latest location
const getAllSalesReps = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        sr.id,
        COALESCE(sr.full_name, sr.name) AS full_name,
        COALESCE(sr.full_name, sr.name) AS name,
        COALESCE(sr.phone, sr.phone_number) AS phone,
        COALESCE(sr.phone, sr.phone_number) AS phone_number,
        sr.email,
        sr.username,
        sr.route_area,
        sr.is_active,
        sr.must_change_password,
        sr.status,
        sr.created_at,
        sr.updated_at,
        COUNT(DISTINCT o.id) AS order_count,
        COUNT(DISTINCT CASE WHEN o.customer_id IS NOT NULL THEN o.customer_id END) AS customer_count,
        COALESCE(SUM(o.total_amount), 0) AS total_sales,
        COALESCE(AVG(o.total_amount), 0) AS avg_order_value,
        MAX(o.created_at) AS last_order_date,
        loc.latitude AS latest_latitude,
        loc.longitude AS latest_longitude,
        loc.accuracy_meters AS latest_accuracy_meters,
        loc.recorded_at AS latest_location_recorded_at,
        loc.source AS latest_location_source
      FROM sales_reps sr
      LEFT JOIN orders o ON o.sales_rep_id = sr.id
      LEFT JOIN LATERAL (
        SELECT
          srl.latitude,
          srl.longitude,
          srl.accuracy_meters,
          srl.recorded_at,
          srl.source
        FROM sales_rep_locations srl
        WHERE srl.sales_rep_id = sr.id
        ORDER BY srl.recorded_at DESC
        LIMIT 1
      ) loc ON TRUE
      GROUP BY
        sr.id,
        loc.latitude,
        loc.longitude,
        loc.accuracy_meters,
        loc.recorded_at,
        loc.source
      ORDER BY COALESCE(sr.full_name, sr.name) ASC
    `);

    return handleSuccess(res, 200, 'Sales reps retrieved successfully', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve sales reps', err);
  }
};

// Get single sales rep with real served customers, orders, and latest location
const getSalesRepById = async (req, res) => {
  try {
    const { id } = req.params;

    const repResult = await pool.query(
      `
      SELECT
        sr.*,
        COALESCE(sr.full_name, sr.name) AS full_name,
        COALESCE(sr.phone, sr.phone_number) AS phone,
        COUNT(DISTINCT o.id) AS order_count,
        COUNT(DISTINCT CASE WHEN o.customer_id IS NOT NULL THEN o.customer_id END) AS ordering_customer_count,
        COALESCE(SUM(o.total_amount), 0) AS total_sales,
        COALESCE(AVG(o.total_amount), 0) AS avg_order_value,
        MAX(o.created_at) AS last_order_date,
        COUNT(CASE WHEN o.order_status = 'completed' THEN 1 END) AS completed_orders,
        COUNT(CASE WHEN o.order_status = 'pending' THEN 1 END) AS pending_orders,
        loc.latitude AS latest_latitude,
        loc.longitude AS latest_longitude,
        loc.accuracy_meters AS latest_accuracy_meters,
        loc.speed_kph AS latest_speed_kph,
        loc.heading_degrees AS latest_heading_degrees,
        loc.battery_level AS latest_battery_level,
        loc.source AS latest_location_source,
        loc.recorded_at AS latest_location_recorded_at
      FROM sales_reps sr
      LEFT JOIN orders o ON o.sales_rep_id = sr.id
      LEFT JOIN LATERAL (
        SELECT
          srl.latitude,
          srl.longitude,
          srl.accuracy_meters,
          srl.speed_kph,
          srl.heading_degrees,
          srl.battery_level,
          srl.source,
          srl.recorded_at
        FROM sales_rep_locations srl
        WHERE srl.sales_rep_id = sr.id
        ORDER BY srl.recorded_at DESC
        LIMIT 1
      ) loc ON TRUE
      WHERE sr.id = $1
      GROUP BY
        sr.id,
        loc.latitude,
        loc.longitude,
        loc.accuracy_meters,
        loc.speed_kph,
        loc.heading_degrees,
        loc.battery_level,
        loc.source,
        loc.recorded_at
      `,
      [id]
    );

    if (repResult.rows.length === 0) {
      return handleError(res, 404, 'Sales rep not found');
    }

    const customersResult = await pool.query(
      `
      SELECT DISTINCT
        c.id,
        c.name,
        c.phone,
        c.email,
        c.customer_type,
        c.is_active,
        l.name AS location_name,
        r.name AS region_name
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      WHERE o.sales_rep_id = $1
      ORDER BY c.name ASC
      `,
      [id]
    );

    const ordersResult = await pool.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.customer_id,
        o.customer_name,
        o.total_amount,
        o.order_status,
        o.payment_status,
        o.created_at,
        l.name AS location_name,
        r.name AS region_name,
        COUNT(DISTINCT oi.id) AS item_count
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.sales_rep_id = $1
      GROUP BY o.id, l.id, r.id
      ORDER BY o.created_at DESC
      `,
      [id]
    );

    const data = {
      ...repResult.rows[0],
      customers: customersResult.rows,
      orders: ordersResult.rows,
    };

    return handleSuccess(res, 200, 'Sales rep retrieved successfully', data);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve sales rep', err);
  }
};

// Save latest location ping for a sales rep
const saveSalesRepLocation = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      latitude,
      longitude,
      accuracy_meters,
      speed_kph,
      heading_degrees,
      battery_level,
      source,
      recorded_at,
    } = req.body;

    const lat = normalizeNumber(latitude);
    const lng = normalizeNumber(longitude);

    if (lat === null || lng === null) {
      return handleError(res, 400, 'latitude and longitude are required');
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return handleError(res, 400, 'Invalid latitude/longitude range');
    }

    const repCheck = await pool.query(
      'SELECT id, is_active, status FROM sales_reps WHERE id = $1',
      [id]
    );

    if (repCheck.rows.length === 0) {
      return handleError(res, 404, 'Sales rep not found');
    }

    if (!repCheck.rows[0].is_active || repCheck.rows[0].status === 'inactive') {
      return handleError(res, 403, 'Sales rep account is inactive');
    }

    const result = await pool.query(
      `
      INSERT INTO sales_rep_locations
      (
        sales_rep_id,
        latitude,
        longitude,
        accuracy_meters,
        speed_kph,
        heading_degrees,
        battery_level,
        source,
        recorded_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()))
      RETURNING *
      `,
      [
        id,
        lat,
        lng,
        normalizeNumber(accuracy_meters),
        normalizeNumber(speed_kph),
        normalizeNumber(heading_degrees),
        normalizeNumber(battery_level),
        source || 'web',
        recorded_at || null,
      ]
    );

    return handleSuccess(res, 201, 'Sales rep location saved successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to save sales rep location', err);
  }
};

// Get latest location for one sales rep
const getLatestSalesRepLocation = async (req, res) => {
  try {
    const { id } = req.params;

    const repCheck = await pool.query(
      'SELECT id, name FROM sales_reps WHERE id = $1',
      [id]
    );

    if (repCheck.rows.length === 0) {
      return handleError(res, 404, 'Sales rep not found');
    }

    const result = await pool.query(
      `
      SELECT
        srl.*,
        COALESCE(sr.full_name, sr.name) AS sales_rep_name
      FROM sales_rep_locations srl
      JOIN sales_reps sr ON sr.id = srl.sales_rep_id
      WHERE srl.sales_rep_id = $1
      ORDER BY srl.recorded_at DESC
      LIMIT 1
      `,
      [id]
    );

    return handleSuccess(
      res,
      200,
      'Latest sales rep location retrieved successfully',
      result.rows[0] || null
    );
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve latest sales rep location', err);
  }
};

// Get latest location for all reps
const getLatestSalesRepLocations = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        sr.id AS sales_rep_id,
        COALESCE(sr.full_name, sr.name) AS sales_rep_name,
        COALESCE(sr.phone, sr.phone_number) AS phone,
        COALESCE(sr.phone, sr.phone_number) AS phone_number,
        sr.status,
        sr.is_active,
        loc.id,
        loc.latitude,
        loc.longitude,
        loc.accuracy_meters,
        loc.speed_kph,
        loc.heading_degrees,
        loc.battery_level,
        loc.source,
        loc.recorded_at
      FROM sales_reps sr
      LEFT JOIN LATERAL (
        SELECT *
        FROM sales_rep_locations srl
        WHERE srl.sales_rep_id = sr.id
        ORDER BY srl.recorded_at DESC
        LIMIT 1
      ) loc ON TRUE
      ORDER BY COALESCE(sr.full_name, sr.name) ASC
    `);

    return handleSuccess(
      res,
      200,
      'Latest locations for all sales reps retrieved successfully',
      result.rows
    );
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve latest sales rep locations', err);
  }
};

// Create sales rep
const createSalesRep = async (req, res) => {
  try {
    const {
      full_name,
      name,
      phone,
      phone_number,
      email,
      username,
      route_area,
      status,
      is_active,
      temporary_password,
    } = req.body;

    const resolvedName = String(full_name || name || '').trim();
    if (!resolvedName) {
      return handleError(res, 400, 'full_name is required');
    }

    const resolvedIsActive = normalizeBooleanInput(
      is_active,
      status ? String(status).toLowerCase() !== 'inactive' : true
    );
    const resolvedStatus = resolvedIsActive ? 'active' : 'inactive';

    const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
    const normalizedUsername = username ? String(username).trim().toLowerCase() : null;
    const resolvedPhone = String(phone || phone_number || '').trim() || null;
    const resolvedRouteArea = String(route_area || '').trim() || null;
    const resolvedTemporaryPassword = String(temporary_password || '').trim() || generateTemporaryPassword();
    validateTemporaryPassword(resolvedTemporaryPassword);
    const passwordHash = await bcrypt.hash(resolvedTemporaryPassword, 10);

    const result = await pool.query(
      `INSERT INTO sales_reps
       (
         name,
         full_name,
         phone_number,
         phone,
         email,
         username,
         route_area,
         status,
         is_active,
         password_hash,
         must_change_password,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, NOW(), NOW())
       RETURNING *`,
      [
        resolvedName,
        resolvedName,
        resolvedPhone,
        resolvedPhone,
        normalizedEmail,
        normalizedUsername,
        resolvedRouteArea,
        resolvedStatus,
        resolvedIsActive,
        passwordHash,
      ]
    );

    return handleSuccess(res, 201, 'Sales rep created successfully', {
      sales_rep: normalizeSalesRepResponse(result.rows[0]),
      credentials: {
        username: result.rows[0].username || result.rows[0].email,
        temporary_password: resolvedTemporaryPassword,
        must_change_password: true,
        handling_warning: 'Store and share this temporary password securely. It is shown only in this response.',
      },
    });
  } catch (err) {
    if (err.status) {
      return handleError(res, err.status, err.message);
    }
    if (err.code === '23505') {
      return handleError(res, 409, 'Sales rep with this email or username already exists');
    }
    return handleError(res, 500, 'Failed to create sales rep', err);
  }
};

// Update sales rep
const updateSalesRep = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, full_name, phone, phone_number, email, username, route_area, status, is_active } = req.body;

    const resolvedName = full_name !== undefined
      ? String(full_name || '').trim()
      : (name !== undefined ? String(name || '').trim() : null);
    const resolvedPhone = phone !== undefined || phone_number !== undefined
      ? (String(phone || phone_number || '').trim() || null)
      : undefined;
    const resolvedEmail = email !== undefined ? (String(email || '').trim().toLowerCase() || null) : undefined;
    const resolvedUsername = username !== undefined ? (String(username || '').trim().toLowerCase() || null) : undefined;
    const resolvedRouteArea = route_area !== undefined ? (String(route_area || '').trim() || null) : undefined;

    const resolvedIsActive = normalizeBooleanInput(
      is_active,
      status !== undefined ? String(status).toLowerCase() !== 'inactive' : undefined
    );
    const resolvedStatus = resolvedIsActive === undefined ? null : (resolvedIsActive ? 'active' : 'inactive');

    const result = await pool.query(
      `UPDATE sales_reps
       SET name = COALESCE($1, name),
           full_name = COALESCE($1, full_name),
           phone_number = COALESCE($2, phone_number),
           phone = COALESCE($2, phone),
           email = COALESCE($3, email),
           username = COALESCE($4, username),
           route_area = COALESCE($5, route_area),
           status = COALESCE($6, status),
           is_active = COALESCE($7, is_active),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $8
       RETURNING *`,
      [
        resolvedName || null,
        resolvedPhone === undefined ? null : resolvedPhone,
        resolvedEmail === undefined ? null : resolvedEmail,
        resolvedUsername === undefined ? null : resolvedUsername,
        resolvedRouteArea === undefined ? null : resolvedRouteArea,
        resolvedStatus,
        resolvedIsActive,
        id,
      ]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Sales rep not found');
    }

    return handleSuccess(res, 200, 'Sales rep updated successfully', normalizeSalesRepResponse(result.rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 409, 'Sales rep with this email or username already exists');
    }
    return handleError(res, 500, 'Failed to update sales rep', err);
  }
};

const resetSalesRepPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const temporaryPassword = String(req.body?.temporary_password || '').trim() || generateTemporaryPassword();
    validateTemporaryPassword(temporaryPassword);
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    const result = await pool.query(
      `
      UPDATE sales_reps
      SET
        password_hash = $1,
        must_change_password = TRUE,
        updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [passwordHash, id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Sales rep not found');
    }

    return handleSuccess(res, 200, 'Sales rep password reset successfully', {
      sales_rep: normalizeSalesRepResponse(result.rows[0]),
      credentials: {
        username: result.rows[0].username || result.rows[0].email,
        temporary_password: temporaryPassword,
        must_change_password: true,
        handling_warning: 'Store and share this temporary password securely. It is shown only in this response.',
      },
    });
  } catch (err) {
    if (err.status) {
      return handleError(res, err.status, err.message);
    }
    return handleError(res, 500, 'Failed to reset sales rep password', err);
  }
};

const loginSalesRep = async (req, res) => {
  try {
    const { username, email, identifier, password } = req.body;
    const normalizedIdentifier = String(identifier || username || email || '').trim().toLowerCase();
    if (!normalizedIdentifier || !password) {
      return handleError(res, 400, 'identifier (username/email) and password are required');
    }
    if (!JWT_SECRET) {
      return handleError(res, 500, 'JWT secret is not configured');
    }

    const result = await pool.query(
      `
      SELECT
        id,
        name,
        full_name,
        phone_number,
        phone,
        email,
        username,
        route_area,
        password_hash,
        must_change_password,
        is_active,
        status,
        created_at,
        updated_at,
        last_login_at
      FROM sales_reps
      WHERE
        LOWER(COALESCE(username, '')) = $1
        OR LOWER(COALESCE(email, '')) = $1
      LIMIT 1
      `,
      [normalizedIdentifier]
    );

    if (result.rows.length === 0) {
      return handleError(res, 401, 'Invalid credentials');
    }

    const rep = result.rows[0];
    if (!rep.password_hash) {
      return handleError(res, 401, 'Sales rep account is not provisioned for login');
    }

    const passwordMatches = await bcrypt.compare(String(password), rep.password_hash);
    if (!passwordMatches) {
      return handleError(res, 401, 'Invalid credentials');
    }

    if (!rep.is_active || rep.status === 'inactive') {
      return handleError(res, 403, 'Sales rep account is inactive');
    }

    await pool.query(
      `
      UPDATE sales_reps
      SET
        last_login_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      `,
      [rep.id]
    );

    const freshRep = await getSalesRepByIdForAuth(rep.id);
    const token = signSalesRepToken(rep);

    return handleSuccess(res, 200, 'Sales rep login successful', {
      token,
      sales_rep: normalizeSalesRepResponse(freshRep || rep),
    });
  } catch (err) {
    return handleError(res, 500, 'Sales rep login failed', err);
  }
};

const getSalesRepSession = async (req, res) => {
  try {
    const salesRepId = req.salesRepAuth?.sales_rep_id;
    const rep = await getSalesRepByIdForAuth(salesRepId);

    if (!rep) {
      return handleError(res, 404, 'Sales rep not found');
    }

    if (!rep.is_active || rep.status === 'inactive') {
      return handleError(res, 403, 'Sales rep account is inactive');
    }

    return handleSuccess(res, 200, 'Sales rep session retrieved successfully', {
      sales_rep: normalizeSalesRepResponse(rep),
    });
  } catch (err) {
    return handleError(res, 500, 'Failed to get sales rep session', err);
  }
};

const changeSalesRepPassword = async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    const salesRepId = req.salesRepAuth?.sales_rep_id;

    if (!current_password || !new_password || !confirm_password) {
      return handleError(res, 400, 'current_password, new_password, and confirm_password are required');
    }
    if (String(new_password) !== String(confirm_password)) {
      return handleError(res, 400, 'new_password and confirm_password must match');
    }
    if (String(new_password).length < 8) {
      return handleError(res, 400, 'new_password must be at least 8 characters');
    }

    const rep = await getSalesRepByIdForAuth(salesRepId);
    if (!rep) {
      return handleError(res, 404, 'Sales rep not found');
    }
    if (!rep.is_active || rep.status === 'inactive') {
      return handleError(res, 403, 'Sales rep account is inactive');
    }
    if (!rep.password_hash) {
      return handleError(res, 401, 'Sales rep account is not provisioned for login');
    }

    const currentMatches = await bcrypt.compare(String(current_password), rep.password_hash);
    if (!currentMatches) {
      return handleError(res, 401, 'Current password is incorrect');
    }

    const newHash = await bcrypt.hash(String(new_password), 10);
    await pool.query(
      `
      UPDATE sales_reps
      SET
        password_hash = $1,
        must_change_password = FALSE,
        updated_at = NOW()
      WHERE id = $2
      `,
      [newHash, salesRepId]
    );

    const updated = await getSalesRepByIdForAuth(salesRepId);
    return handleSuccess(res, 200, 'Sales rep password changed successfully', {
      sales_rep: normalizeSalesRepResponse(updated || rep),
    });
  } catch (err) {
    return handleError(res, 500, 'Failed to change sales rep password', err);
  }
};

const saveOwnSalesRepLocation = async (req, res) => {
  try {
    const salesRepId = req.salesRepAuth?.sales_rep_id;
    const rep = await getSalesRepByIdForAuth(salesRepId);

    if (!rep) {
      return handleError(res, 404, 'Sales rep not found');
    }
    if (!rep.is_active || rep.status === 'inactive') {
      return handleError(res, 403, 'Sales rep account is inactive');
    }
    if (rep.must_change_password) {
      return handleError(res, 403, 'Password change is required before location updates');
    }

    req.params.id = salesRepId;
    return saveSalesRepLocation(req, res);
  } catch (err) {
    return handleError(res, 500, 'Failed to save sales rep location', err);
  }
};

// Delete sales rep
const deleteSalesRep = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM sales_reps WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Sales rep not found');
    }

    return handleSuccess(res, 200, 'Sales rep deleted successfully');
  } catch (err) {
    return handleError(res, 500, 'Failed to delete sales rep', err);
  }
};

module.exports = {
  getAllSalesReps,
  getSalesRepById,
  saveSalesRepLocation,
  saveOwnSalesRepLocation,
  getLatestSalesRepLocation,
  getLatestSalesRepLocations,
  loginSalesRep,
  getSalesRepSession,
  changeSalesRepPassword,
  createSalesRep,
  updateSalesRep,
  resetSalesRepPassword,
  deleteSalesRep
};
