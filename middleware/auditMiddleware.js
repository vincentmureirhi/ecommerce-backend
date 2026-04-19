'use strict';

const pool = require('../config/database');

/**
 * Log activity to audit trail
 */
const logActivity = async (userId, action, entityType, entityId, details = null) => {
  try {
    await pool.query(
      `
      INSERT INTO activity_logs (user_id, action, entity_type, entity_id, details, created_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      `,
      [userId, action, entityType, entityId, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    console.error('Failed to log activity:', err);
    // Don't throw - logging failure shouldn't break the main operation
  }
};

/**
 * Middleware to log price changes
 */
const auditPriceChange = async (req, res, next) => {
  // Store original send function
  const originalSend = res.json;

  // Override send to capture response
  res.json = function (data) {
    if (data && data.success && req.body) {
      const action = req.path.includes('admin') ? 'create_order_admin' : 'create_order';
      
      // Log order creation with items
      if (data.data && data.data.id) {
        logActivity(
          req.user?.id,
          action,
          'order',
          data.data.id,
          {
            customer_name: req.body.customer_name,
            items_count: req.body.items?.length,
            total_amount: data.data.total_amount,
          }
        );
      }
    }

    // Call original send
    return originalSend.call(this, data);
  };

  next();
};

module.exports = {
  logActivity,
  auditPriceChange,
};