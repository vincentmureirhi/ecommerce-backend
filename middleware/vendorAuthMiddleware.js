'use strict';

const jwt = require('jsonwebtoken');
const pool = require('../config/database');

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  return typeof secret === 'string' && secret.trim() ? secret : null;
}

const verifyVendorToken = async (req, res, next) => {
  try {
    const jwtSecret = getJwtSecret();
    if (!jwtSecret) {
      return res.status(500).json({
        success: false,
        error: 'JWT secret is not configured',
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Vendor authorization header missing or invalid format',
      });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, jwtSecret);

    if (decoded.token_type !== 'vendor_user' || !decoded.vendor_user_id || !decoded.vendor_id) {
      return res.status(401).json({
        success: false,
        error: 'Invalid vendor token',
      });
    }

    const result = await pool.query(
      `
      SELECT
        vu.id AS vendor_user_id,
        vu.vendor_id,
        vu.full_name,
        vu.email,
        vu.phone,
        vu.username,
        vu.role,
        vu.status AS user_status,
        vu.must_change_password,
        v.store_name,
        v.store_slug,
        v.status AS vendor_status,
        v.verification_status,
        v.store_visibility_status
      FROM vendor_users vu
      JOIN vendors v ON v.id = vu.vendor_id
      WHERE vu.id = $1
        AND vu.vendor_id = $2
      LIMIT 1
      `,
      [decoded.vendor_user_id, decoded.vendor_id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Vendor account not found',
      });
    }

    const account = result.rows[0];
    if (account.user_status !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'Vendor user account is not active',
      });
    }

    if (account.vendor_status !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'Vendor store is not active',
      });
    }

    req.vendorUser = {
      id: account.vendor_user_id,
      vendor_id: account.vendor_id,
      full_name: account.full_name,
      email: account.email,
      phone: account.phone,
      username: account.username,
      role: account.role,
      must_change_password: account.must_change_password,
    };

    req.vendor = {
      id: account.vendor_id,
      store_name: account.store_name,
      store_slug: account.store_slug,
      status: account.vendor_status,
      verification_status: account.verification_status,
      store_visibility_status: account.store_visibility_status,
    };

    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired vendor token',
    });
  }
};

const requireVendorOwnerOrManager = (req, res, next) => {
  if (!req.vendorUser) {
    return res.status(401).json({
      success: false,
      error: 'Vendor authentication required',
    });
  }

  if (!['owner', 'manager'].includes(req.vendorUser.role)) {
    return res.status(403).json({
      success: false,
      error: 'Vendor owner or manager access required',
    });
  }

  return next();
};

module.exports = {
  verifyVendorToken,
  requireVendorOwnerOrManager,
};
