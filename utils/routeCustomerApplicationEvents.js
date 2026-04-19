'use strict';

const pool = require('../config/database');

function getQueryable(queryable) {
  if (queryable && typeof queryable.query === 'function') {
    return queryable;
  }
  return pool;
}

async function logRouteCustomerApplicationEvent(queryable, payload) {
  const db = getQueryable(queryable);

  const applicationId = Number(payload.applicationId);

  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new Error('Invalid applicationId for audit event');
  }

  const eventType = String(payload.eventType || '').trim();
  const eventLabel = String(payload.eventLabel || '').trim();

  if (!eventType) {
    throw new Error('eventType is required for audit event');
  }

  if (!eventLabel) {
    throw new Error('eventLabel is required for audit event');
  }

  const eventNotes =
    payload.eventNotes === undefined || payload.eventNotes === null
      ? null
      : String(payload.eventNotes).trim() || null;

  const actorUserId =
    payload.actorUserId === undefined || payload.actorUserId === null || payload.actorUserId === ''
      ? null
      : Number(payload.actorUserId);

  const metadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : {};

  const result = await db.query(
    `
    INSERT INTO route_customer_application_events
    (
      application_id,
      event_type,
      event_label,
      event_notes,
      actor_user_id,
      metadata_json,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    RETURNING *
    `,
    [
      applicationId,
      eventType,
      eventLabel,
      eventNotes,
      actorUserId,
      metadata,
    ]
  );

  return result.rows[0];
}

async function listRouteCustomerApplicationEvents(queryable, applicationId) {
  const db = getQueryable(queryable);
  const appId = Number(applicationId);

  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error('Invalid applicationId for event listing');
  }

  const result = await db.query(
    `
    SELECT
      e.*,
      u.email AS actor_user_email
    FROM route_customer_application_events e
    LEFT JOIN users u ON e.actor_user_id = u.id
    WHERE e.application_id = $1
    ORDER BY e.created_at DESC, e.id DESC
    `,
    [appId]
  );

  return result.rows;
}

module.exports = {
  logRouteCustomerApplicationEvent,
  listRouteCustomerApplicationEvents,
};