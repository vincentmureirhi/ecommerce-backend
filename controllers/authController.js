'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

// LOGIN
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return handleError(res, 400, 'Email and password are required');
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, role, is_active FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return handleError(res, 401, 'Invalid credentials');
    }

    const user = result.rows[0];

    // Check if user is disabled (except superuser)
    if (user.role !== 'superuser' && !user.is_active) {
      console.log(`❌ Login blocked - Account disabled: ${user.email}`);
      return handleError(res, 403, 'Account is disabled');
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return handleError(res, 401, 'Invalid credentials');
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );

    console.log(`✅ Login successful: ${user.email} (${user.role})`);

    return handleSuccess(res, 200, 'Login successful', {
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        is_active: user.is_active,
      },
    });
  } catch (err) {
    console.error('❌ Login error:', err.message);
    return handleError(res, 500, 'Login failed', err);
  }
};

// CREATE NEW ADMIN
const createAdmin = async (req, res) => {
  try {
    const { admin_email, first_name, last_name, temporary_password } = req.body;
    const requestingUserId = req.user.id;

    const userResult = await pool.query(
      'SELECT role FROM users WHERE id = $1',
      [requestingUserId]
    );

    if (userResult.rows.length === 0) {
      return handleError(res, 404, 'User not found');
    }

    const requestingUser = userResult.rows[0];

    if (requestingUser.role !== 'superuser') {
      return handleError(res, 403, 'Only SuperUser can create admins');
    }

    if (!admin_email || !first_name || !last_name || !temporary_password) {
      return handleError(res, 400, 'All fields are required');
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [admin_email.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      return handleError(res, 409, 'Email already exists');
    }

    const hashedPassword = await bcrypt.hash(temporary_password, 10);

    const createResult = await pool.query(
      'INSERT INTO users (email, password_hash, first_name, last_name, role, is_active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW()) RETURNING id, email, first_name, last_name, role, is_active',
      [admin_email.toLowerCase(), hashedPassword, first_name, last_name, 'admin']
    );

    const newAdmin = createResult.rows[0];

    console.log(`✅ New admin created: ${newAdmin.email}`);

    return handleSuccess(res, 201, 'Admin account created successfully', {
      admin: newAdmin,
    });
  } catch (err) {
    console.error('❌ Create admin error:', err.message);
    return handleError(res, 500, 'Failed to create admin', err);
  }
};

// GET ALL ADMINS
const getAllAdmins = async (req, res) => {
  try {
    const requestingUserId = req.user.id;

    const userResult = await pool.query(
      'SELECT role FROM users WHERE id = $1',
      [requestingUserId]
    );

    if (userResult.rows.length === 0 || userResult.rows[0].role !== 'superuser') {
      return handleError(res, 403, 'Only SuperUser can view admins');
    }

    const result = await pool.query(
      'SELECT id, email, first_name, last_name, role, is_active, created_at FROM users WHERE role IN (\'admin\', \'superuser\') ORDER BY created_at DESC'
    );

    return handleSuccess(res, 200, 'Admins retrieved', {
      admins: result.rows,
      total: result.rows.length,
    });
  } catch (err) {
    console.error('❌ Get admins error:', err.message);
    return handleError(res, 500, 'Failed to get admins', err);
  }
};

// DISABLE ADMIN (NOT SUPERUSER)
const disableAdmin = async (req, res) => {
  try {
    const admin_id = req.params.admin_id;
    const requestingUserId = req.user.id;

    const userResult = await pool.query(
      'SELECT role FROM users WHERE id = $1',
      [requestingUserId]
    );

    if (userResult.rows.length === 0 || userResult.rows[0].role !== 'superuser') {
      return handleError(res, 403, 'Only SuperUser can disable admins');
    }

    const targetUser = await pool.query(
      'SELECT role, email FROM users WHERE id = $1',
      [admin_id]
    );

    if (targetUser.rows.length === 0) {
      return handleError(res, 404, 'Admin not found');
    }

    // Cannot disable superuser
    if (targetUser.rows[0].role === 'superuser') {
      return handleError(res, 400, 'Cannot disable SuperUser account');
    }

    await pool.query(
      'UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1',
      [admin_id]
    );

    console.log(`✅ Admin disabled: ${targetUser.rows[0].email}`);

    return handleSuccess(res, 200, 'Admin disabled successfully');
  } catch (err) {
    console.error('❌ Disable admin error:', err.message);
    return handleError(res, 500, 'Failed to disable admin', err);
  }
};

// VERIFY TOKEN
const verifyToken = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return handleError(res, 401, 'No token provided');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');

    const userResult = await pool.query(
      'SELECT id, email, role, is_active FROM users WHERE id = $1',
      [decoded.id]
    );

    if (userResult.rows.length === 0) {
      return handleError(res, 401, 'User not found');
    }

    const user = userResult.rows[0];

    // Check if user is disabled (except superuser)
    if (user.role !== 'superuser' && !user.is_active) {
      return handleError(res, 403, 'Account is disabled');
    }

    return handleSuccess(res, 200, 'Token valid', { user });
  } catch (err) {
    console.error('❌ Token verification error:', err.message);
    return handleError(res, 401, 'Invalid token', err);
  }
};

module.exports = {
  login,
  createAdmin,
  getAllAdmins,
  disableAdmin,
  verifyToken,
};