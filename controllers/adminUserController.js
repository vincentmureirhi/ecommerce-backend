'use strict';

const bcrypt = require('bcrypt');
const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const { logActivity } = require('../middleware/auditMiddleware');

const VALID_ROLES = ['superuser', 'superadmin', 'admin', 'staff'];

// Build a parameterized IN clause from the VALID_ROLES constant
const ROLES_PLACEHOLDER = VALID_ROLES.map((_, i) => `$${i + 1}`).join(', ');

function normalizeRole(role) {
  const value = String(role || 'staff').trim().toLowerCase();
  if (value === 'superadmin' || value === 'super_admin') return 'superuser';
  return value;
}

function isSuperAdminRole(role) {
  return role === 'superuser' || role === 'superadmin';
}

function splitFullName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '-' };
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1],
  };
}

const getAdminUsers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        id,
        email,
        COALESCE(first_name || ' ' || last_name, email) AS name,
        first_name,
        last_name,
        role,
        is_active,
        created_at,
        updated_at
      FROM users
      WHERE role IN (${ROLES_PLACEHOLDER})
      ORDER BY created_at DESC`,
      VALID_ROLES
    );

    return handleSuccess(res, 200, 'Admin users retrieved successfully', result.rows);
  } catch (err) {
    console.error('❌ getAdminUsers error:', err.message);
    return handleError(res, 500, 'Failed to retrieve admin users', err);
  }
};

const createAdminUser = async (req, res) => {
  try {
    if (!isSuperAdminRole(req.user.role)) {
      return handleError(res, 403, 'Only superuser can create admin users');
    }

    const { email, first_name, last_name, name, password, role } = req.body;
    const splitName = splitFullName(name);

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedFirstName = String(first_name || splitName.firstName || '').trim();
    const normalizedLastName = String(last_name || splitName.lastName || '').trim();
    const normalizedRole = normalizeRole(role || 'admin');

    if (!normalizedEmail) return handleError(res, 400, 'email is required');
    if (!normalizedFirstName) return handleError(res, 400, 'first_name is required');
    if (!normalizedLastName) return handleError(res, 400, 'last_name is required');
    if (!password) return handleError(res, 400, 'password is required');
    if (!VALID_ROLES.includes(normalizedRole)) {
      return handleError(res, 400, `role must be one of: ${VALID_ROLES.join(', ')}`);
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return handleError(res, 409, 'A user with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW())
       RETURNING id, email, first_name, last_name, role, is_active, created_at`,
      [normalizedEmail, passwordHash, normalizedFirstName, normalizedLastName, normalizedRole]
    );

    await logActivity(
      req.user?.id,
      'admin_user_created',
      'user',
      result.rows[0].id,
      {
        target_email: result.rows[0].email,
        target_role: result.rows[0].role,
      },
      { req, actorType: 'admin' }
    );

    return handleSuccess(res, 201, 'Admin user created successfully', result.rows[0]);
  } catch (err) {
    console.error('❌ createAdminUser error:', err.message);
    return handleError(res, 500, 'Failed to create admin user', err);
  }
};

const updateAdminUser = async (req, res) => {
  try {
    if (!isSuperAdminRole(req.user.role)) {
      return handleError(res, 403, 'Only superuser can update admin users');
    }

    const { id } = req.params;
    const { first_name, last_name, name, email, is_active, password } = req.body;
    const splitName = splitFullName(name);

    const existing = await pool.query(
      'SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = $1 AND role = ANY($2)',
      [id, VALID_ROLES]
    );
    if (existing.rows.length === 0) {
      return handleError(res, 404, 'Admin user not found');
    }

    const updates = [];
    const params = [];
    const changedFields = [];
    let idx = 1;

    if (isSuperAdminRole(existing.rows[0].role) && is_active === false) {
      return handleError(res, 400, 'The superadmin account cannot be deactivated');
    }

    const resolvedFirstName = first_name !== undefined ? first_name : splitName.firstName || undefined;
    const resolvedLastName = last_name !== undefined ? last_name : splitName.lastName || undefined;

    if (resolvedFirstName !== undefined) {
      updates.push(`first_name = $${idx++}`);
      params.push(String(resolvedFirstName).trim());
      changedFields.push('first_name');
    }
    if (resolvedLastName !== undefined) {
      updates.push(`last_name = $${idx++}`);
      params.push(String(resolvedLastName).trim());
      changedFields.push('last_name');
    }
    if (email !== undefined) {
      const normalizedEmail = String(email).trim().toLowerCase();
      const conflict = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [normalizedEmail, id]
      );
      if (conflict.rows.length > 0) {
        return handleError(res, 409, 'Email already in use by another user');
      }
      updates.push(`email = $${idx++}`);
      params.push(normalizedEmail);
      changedFields.push('email');
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${idx++}`);
      params.push(Boolean(is_active));
      changedFields.push('is_active');
    }
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      updates.push(`password_hash = $${idx++}`);
      params.push(passwordHash);
      changedFields.push('password');
    }

    if (updates.length === 0) {
      return handleError(res, 400, 'No fields provided to update');
    }

    updates.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, email, first_name, last_name, role, is_active, created_at, updated_at`,
      params
    );

    await logActivity(
      req.user?.id,
      'admin_user_updated',
      'user',
      result.rows[0].id,
      {
        target_email: result.rows[0].email,
        target_role: result.rows[0].role,
        changed_fields: changedFields,
        previous: {
          email: existing.rows[0].email,
          first_name: existing.rows[0].first_name,
          last_name: existing.rows[0].last_name,
          is_active: existing.rows[0].is_active,
        },
      },
      { req, actorType: 'admin' }
    );

    return handleSuccess(res, 200, 'Admin user updated successfully', result.rows[0]);
  } catch (err) {
    console.error('❌ updateAdminUser error:', err.message);
    return handleError(res, 500, 'Failed to update admin user', err);
  }
};

const deleteAdminUser = async (req, res) => {
  try {
    if (!isSuperAdminRole(req.user.role)) {
      return handleError(res, 403, 'Only superuser can delete admin users');
    }

    const { id } = req.params;

    if (Number(id) === req.user.id) {
      return handleError(res, 400, 'You cannot delete your own account');
    }

    const existing = await pool.query(
      'SELECT id, role, email FROM users WHERE id = $1 AND role = ANY($2)',
      [id, VALID_ROLES]
    );
    if (existing.rows.length === 0) {
      return handleError(res, 404, 'Admin user not found');
    }

    if (isSuperAdminRole(existing.rows[0].role)) {
      return handleError(res, 400, 'Cannot delete a superuser account');
    }

    // Deactivate instead of hard delete to preserve audit trail
    await pool.query(
      'UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1',
      [id]
    );

    await logActivity(
      req.user?.id,
      'admin_user_deactivated',
      'user',
      existing.rows[0].id,
      {
        target_email: existing.rows[0].email,
        target_role: existing.rows[0].role,
      },
      { req, actorType: 'admin' }
    );

    return handleSuccess(res, 200, 'Admin user deactivated successfully');
  } catch (err) {
    console.error('❌ deleteAdminUser error:', err.message);
    return handleError(res, 500, 'Failed to deactivate admin user', err);
  }
};

const updateAdminUserRole = async (req, res) => {
  try {
    if (!isSuperAdminRole(req.user.role)) {
      return handleError(res, 403, 'Only superuser can change user roles');
    }

    const { id } = req.params;
    const { role } = req.body;

    const normalizedRole = normalizeRole(role);
    if (!VALID_ROLES.includes(normalizedRole)) {
      return handleError(res, 400, `role must be one of: ${VALID_ROLES.join(', ')}`);
    }

    if (Number(id) === req.user.id) {
      return handleError(res, 400, 'You cannot change your own role');
    }

    const existing = await pool.query(
      'SELECT id, email, role FROM users WHERE id = $1 AND role = ANY($2)',
      [id, VALID_ROLES]
    );
    if (existing.rows.length === 0) {
      return handleError(res, 404, 'Admin user not found');
    }

    if (isSuperAdminRole(existing.rows[0].role)) {
      return handleError(res, 400, 'The superadmin role cannot be changed');
    }

    const result = await pool.query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, email, first_name, last_name, role, is_active`,
      [normalizedRole, id]
    );

    await logActivity(
      req.user?.id,
      'admin_user_role_changed',
      'user',
      result.rows[0].id,
      {
        target_email: result.rows[0].email,
        previous_role: existing.rows[0].role,
        new_role: result.rows[0].role,
      },
      { req, actorType: 'admin' }
    );

    return handleSuccess(res, 200, 'Admin user role updated successfully', result.rows[0]);
  } catch (err) {
    console.error('❌ updateAdminUserRole error:', err.message);
    return handleError(res, 500, 'Failed to update admin user role', err);
  }
};

module.exports = {
  getAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  updateAdminUserRole,
};
