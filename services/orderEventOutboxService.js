'use strict';

const pool = require('../config/database');
const {
  broadcastDashboardUpdated,
  broadcastRouteOperationEvent,
} = require('../websocket');

const DEFAULT_BATCH_SIZE = 50;
let kickScheduled = false;

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return payload;
}

async function enqueueOrderEvent(db, eventType, payload, options = {}) {
  const target = db && typeof db.query === 'function' ? db : pool;
  const normalizedPayload = normalizePayload(payload);
  const aggregateId = options.aggregateId ?? normalizedPayload.order_id ?? normalizedPayload.id ?? null;
  const aggregateType = options.aggregateType || 'order';

  const result = await target.query(
    `
    INSERT INTO order_event_outbox
      (event_type, aggregate_type, aggregate_id, payload, status, next_attempt_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4::jsonb, 'queued', NOW(), NOW(), NOW())
    RETURNING id
    `,
    [eventType, aggregateType, aggregateId, JSON.stringify(normalizedPayload)]
  );

  return result.rows[0];
}

async function dispatchOrderEvent(row) {
  const payload = normalizePayload(row.payload);

  if (row.event_type === 'dashboard_updated') {
    broadcastDashboardUpdated(payload);
    return;
  }

  if (row.event_type === 'route_operation_event') {
    broadcastRouteOperationEvent(payload);
    return;
  }

  throw new Error(`Unsupported order event type: ${row.event_type}`);
}

async function markProcessed(client, id) {
  await client.query(
    `
    UPDATE order_event_outbox
    SET status = 'processed',
        processed_at = NOW(),
        locked_at = NULL,
        last_error = NULL,
        updated_at = NOW()
    WHERE id = $1
    `,
    [id]
  );
}

async function markRetryOrFailed(client, row, err) {
  const nextAttempts = Number(row.attempts || 0) + 1;
  const maxAttempts = Number(row.max_attempts || 5);
  const failed = nextAttempts >= maxAttempts;
  const retryDelaySeconds = Math.min(300, Math.max(5, nextAttempts * 10));

  await client.query(
    `
    UPDATE order_event_outbox
    SET status = $1,
        attempts = $2,
        next_attempt_at = CASE WHEN $1 = 'retry' THEN NOW() + ($3 || ' seconds')::interval ELSE next_attempt_at END,
        locked_at = NULL,
        last_error = $4,
        updated_at = NOW()
    WHERE id = $5
    `,
    [
      failed ? 'failed' : 'retry',
      nextAttempts,
      String(retryDelaySeconds),
      err.message || 'Order event dispatch failed',
      row.id,
    ]
  );
}

async function processOrderEventOutboxBatch(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || DEFAULT_BATCH_SIZE), 250));
  const client = await pool.connect();
  const result = {
    processed: 0,
    failed: 0,
    retried: 0,
  };

  try {
    await client.query('BEGIN');

    await client.query(
      ` 
      UPDATE order_event_outbox
      SET status = 'retry',
          next_attempt_at = NOW(),
          locked_at = NULL,
          updated_at = NOW(),
          last_error = COALESCE(last_error, 'Recovered stale processing lock')
      WHERE status = 'processing'
        AND locked_at < NOW() - INTERVAL '2 minutes'
      ` 
    );

    const rowsResult = await client.query(
      `
      SELECT *
      FROM order_event_outbox
      WHERE status IN ('queued', 'retry')
        AND next_attempt_at <= NOW()
      ORDER BY id ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
      `,
      [limit]
    );

    if (rowsResult.rows.length === 0) {
      await client.query('COMMIT');
      return result;
    }

    const ids = rowsResult.rows.map((row) => row.id);
    await client.query(
      `
      UPDATE order_event_outbox
      SET status = 'processing',
          locked_at = NOW(),
          updated_at = NOW()
      WHERE id = ANY($1::bigint[])
      `,
      [ids]
    );

    await client.query('COMMIT');

    for (const row of rowsResult.rows) {
      const rowClient = await pool.connect();
      try {
        await dispatchOrderEvent(row);
        await markProcessed(rowClient, row.id);
        result.processed += 1;
      } catch (err) {
        await markRetryOrFailed(rowClient, row, err);
        if (Number(row.attempts || 0) + 1 >= Number(row.max_attempts || 5)) {
          result.failed += 1;
        } else {
          result.retried += 1;
        }
      } finally {
        rowClient.release();
      }
    }

    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // ignore rollback failure
    }
    throw err;
  } finally {
    client.release();
  }
}

function kickOrderEventOutbox() {
  if (kickScheduled) return;
  kickScheduled = true;

  setImmediate(async () => {
    kickScheduled = false;
    try {
      await processOrderEventOutboxBatch({
        limit: Number(process.env.ORDER_EVENT_OUTBOX_KICK_BATCH_SIZE || 25),
      });
    } catch (err) {
      console.error('Order event outbox kick error:', err.message);
    }
  });
}

module.exports = {
  enqueueOrderEvent,
  processOrderEventOutboxBatch,
  kickOrderEventOutbox,
};