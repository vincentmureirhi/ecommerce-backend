'use strict';

const pool = require('../config/database');

function firstForwardedIp(value) {
  return String(value || '').split(',')[0].trim() || null;
}

function buildAuditContext(context = {}) {
  const req = context.req || context.request || null;
  const actorType =
    context.actorType ||
    (req?.vendorUser ? 'vendor' : req?.user ? 'admin' : 'system');

  const actorId =
    context.actorId ??
    req?.vendorUser?.id ??
    req?.user?.id ??
    null;

  return {
    requestId: context.requestId || req?.requestId || null,
    ipAddress:
      context.ipAddress ||
      firstForwardedIp(req?.headers?.['x-forwarded-for']) ||
      req?.ip ||
      req?.socket?.remoteAddress ||
      null,
    userAgent: context.userAgent || req?.headers?.['user-agent'] || null,
    actorType,
    actorId,
    status: context.status || 'success',
    metadata: context.metadata || {},
  };
}

/**
 * Log activity to audit trail
 */
const logActivity = async (userId, action, entityType, entityId, details = null, context = {}) => {
  const auditContext = buildAuditContext(context);
  const detailPayload = details && typeof details === 'object' ? { ...details } : details;

  if (detailPayload && typeof detailPayload === 'object') {
    if (auditContext.requestId && !detailPayload.request_id) {
      detailPayload.request_id = auditContext.requestId;
    }
    if (auditContext.actorType && !detailPayload.actor_type) {
      detailPayload.actor_type = auditContext.actorType;
    }
  }

  try {
    await pool.query(
      `
      INSERT INTO activity_logs (
        user_id,
        action,
        entity_type,
        entity_id,
        details,
        request_id,
        ip_address,
        user_agent,
        actor_type,
        actor_id,
        status,
        metadata,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::jsonb, CURRENT_TIMESTAMP)
      `,
      [
        userId || auditContext.actorId || null,
        action,
        entityType,
        entityId || null,
        detailPayload ? JSON.stringify(detailPayload) : null,
        auditContext.requestId,
        auditContext.ipAddress,
        auditContext.userAgent,
        auditContext.actorType,
        auditContext.actorId,
        auditContext.status,
        JSON.stringify(auditContext.metadata || {}),
      ]
    );
  } catch (err) {
    if (err.code === '42703') {
      try {
        await pool.query(
          `
          INSERT INTO activity_logs (user_id, action, entity_type, entity_id, details, created_at)
          VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP)
          `,
          [
            userId || auditContext.actorId || null,
            action,
            entityType,
            entityId || null,
            detailPayload ? JSON.stringify(detailPayload) : null,
          ]
        );
        return;
      } catch (fallbackErr) {
        console.error('Failed to log activity fallback:', fallbackErr.message);
      }
    }

    console.error('Failed to log activity:', err.message);
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
          },
          { req, actorType: req.user ? 'admin' : 'customer' }
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
