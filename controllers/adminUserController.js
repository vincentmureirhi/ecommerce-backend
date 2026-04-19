'use strict';

const pool = require('../config/database');

const getAdminUsers = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        email,
        email AS name,
        role,
        'active' AS status
      FROM users
      WHERE role IN ('admin', 'superuser')
      ORDER BY id DESC
    `);

    return res.json({
      success: true,
      data: result.rows,
      message: 'Admin users retrieved successfully',
    });
  } catch (err) {
    console.error('❌ getAdminUsers error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve admin users',
      error: err.message,
    });
  }
};

module.exports = {
  getAdminUsers,
};