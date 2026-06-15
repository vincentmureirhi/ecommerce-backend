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

async function getAuditLogs(req, res) {
  try {
    const page = toPositiveInteger(req.query.page, 1, { min: 1, max: 100000 });
    const limit = toPositiveInteger(req.query.limit, 50, { min: 1, max: 100 });
    const offset = (page - 1) * limit;

    const params = [];
    const where = ['1=1'];

    const action = String(req.query.action || '').trim();
    if (action) {
      where.push(`al.action = ${addParam(params, action)}`);
    }

    const entityType = String(req.query.entity_type || req.query.entityType || '').trim();
    if (entityType) {
      where.push(`al.entity_type = ${addParam(params, entityType)}`);
    }

    const actorType = String(req.query.actor_type || req.query.actorType || '').trim();
    if (actorType) {
      where.push(`COALESCE(al.actor_type, 'admin') = ${addParam(params, actorType)}`);
    }

    const status = String(req.query.status || '').trim();
    if (status) {
      where.push(`COALESCE(al.status, 'success') = ${addParam(params, status)}`);
    }

    const requestId = String(req.query.request_id || req.query.requestId || '').trim();
    if (requestId) {
      where.push(`al.request_id = ${addParam(params, requestId)}`);
    }

    const search = String(req.query.search || '').trim();
    if (search) {
      const value = addParam(params, `%${search}%`);
      where.push(`(
        al.action ILIKE ${value}
        OR al.entity_type ILIKE ${value}
        OR COALESCE(al.request_id, '') ILIKE ${value}
        OR COALESCE(u.email, '') ILIKE ${value}
        OR COALESCE(u.first_name || ' ' || u.last_name, '') ILIKE ${value}
        OR COALESCE(al.details::text, '') ILIKE ${value}
      )`);
    }

    if (req.query.from) {
      where.push(`al.created_at >= ${addParam(params, req.query.from)}`);
    }

    if (req.query.to) {
      where.push(`al.created_at < (${addParam(params, req.query.to)}::timestamptz + INTERVAL '1 day')`);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM activity_logs al LEFT JOIN users u ON u.id = al.user_id WHERE ${where.join(' AND ')}`,
      params
    );

    const listParams = [...params, limit, offset];
    const limitParam = `$${listParams.length - 1}`;
    const offsetParam = `$${listParams.length}`;

    const result = await pool.query(
      `
      SELECT
        al.id,
        al.user_id,
        COALESCE(u.email, 'system') AS actor_email,
        COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email, 'System') AS actor_name,
        al.action,
        al.entity_type,
        al.entity_id,
        al.details,
        al.request_id,
        al.ip_address,
        al.user_agent,
        COALESCE(al.actor_type, 'admin') AS actor_type,
        al.actor_id,
        COALESCE(al.status, 'success') AS status,
        COALESCE(al.metadata, '{}'::jsonb) AS metadata,
        al.created_at
      FROM activity_logs al
      LEFT JOIN users u ON u.id = al.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY al.created_at DESC, al.id DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
      `,
      listParams
    );

    const total = Number(countResult.rows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.json({
      success: true,
      data: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
      meta: {
        requestId: req.requestId,
      },
    });
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve audit logs', err);
  }
}

module.exports = {
  getAuditLogs,
};
