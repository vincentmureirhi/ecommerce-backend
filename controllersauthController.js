'use strict';

const pool = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { handleError, handleSuccess } = require('../utils/errorHandler');

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

/**
 * POST /api/auth/login
 * body: { email, password }
 */
const login = async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) return handleError(res, 400, 'email and password are required');

    const result = await pool.query(
      `SELECT id, email, password_hash, role, is_active, first_name, last_name
       FROM users
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [email]
    );

    if (result.rowCount === 0) return handleError(res, 401, 'Invalid credentials');

    const user = result.rows[0];
    if (!user.is_active) return handleError(res, 403, 'Account disabled');

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return handleError(res, 401, 'Invalid credentials');

    const token = signToken(user);

    return handleSuccess(res, 200, 'Login successful', {
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name,
      },
    });
  } catch (err) {
    return handleError(res, 500, 'Login failed', err);
  }
};

module.exports = { login };