'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const {
  findCurrentCycle,
  getCycleById,
  getCycleCandles,
  getTerminalData,
  syncExistingOrdersToCycle,
} = require('../services/routeOperationsService');

const ROUTE_TYPES = new Set(['weekly_route', 'mwatate_route', 'custom']);
const ROUTE_STATUSES = new Set(['planned', 'live', 'closed', 'cancelled']);

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositiveId(value, field = 'id') {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const err = new Error(`${field} must be a positive integer`);
    err.status = 400;
    throw err;
  }
  return parsed;
}

function cleanText(value, field, { required = false } = {}) {
  const text = String(value || '').trim();
  if (required && !text) {
    const err = new Error(`${field} is required`);
    err.status = 400;
    throw err;
  }
  return text || null;
}

function cleanRouteType(value) {
  const type = String(value || 'custom').trim().toLowerCase();
  if (!ROUTE_TYPES.has(type)) {
    const err = new Error('route_type must be weekly_route, mwatate_route, or custom');
    err.status = 400;
    throw err;
  }
  return type;
}

function cleanRouteStatus(value, fallback = 'planned') {
  const status = String(value || fallback).trim().toLowerCase();
  if (!ROUTE_STATUSES.has(status)) {
    const err = new Error('status must be planned, live, closed, or cancelled');
    err.status = 400;
    throw err;
  }
  return status;
}

function cleanMoney(value, field, fallback = 0) {
  const amount = value === undefined || value === null || value === ''
    ? fallback
    : Number(value);

  if (!Number.isFinite(amount) || amount < 0) {
    const err = new Error(`${field} must be a non-negative amount`);
    err.status = 400;
    throw err;
  }

  return Number(amount.toFixed(2));
}

function cleanDate(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    const err = new Error(`${field} must be a valid date/time`);
    err.status = 400;
    throw err;
  }
  return date.toISOString();
}

function cleanLocationIds(value) {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0)
  )];
}

async function replaceCycleLocations(client, cycleId, locationIds) {
  await client.query('DELETE FROM route_cycle_locations WHERE route_cycle_id = $1', [cycleId]);

  for (const locationId of locationIds) {
    await client.query(
      `
      INSERT INTO route_cycle_locations (route_cycle_id, location_id)
      VALUES ($1, $2)
      ON CONFLICT (route_cycle_id, location_id) DO NOTHING
      `,
      [cycleId, locationId]
    );
  }
}

const listRouteCycles = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const params = [limit];
    let where = 'WHERE 1 = 1';

    if (req.query.status) {
      params.push(cleanRouteStatus(req.query.status));
      where += ` AND rc.status = $${params.length}`;
    }

    if (req.query.route_type) {
      params.push(cleanRouteType(req.query.route_type));
      where += ` AND rc.route_type = $${params.length}`;
    }

    if (req.query.region_id) {
      params.push(parsePositiveId(req.query.region_id, 'region_id'));
      where += ` AND rc.region_id = $${params.length}`;
    }

    const result = await pool.query(
      `
      SELECT
        rc.*,
        r.name AS region_name,
        COUNT(DISTINCT rco.order_id)::int AS order_count,
        COALESCE(SUM(rco.order_amount), 0)::numeric AS achieved_amount,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT('id', l.id, 'name', l.name)
            ORDER BY l.name
          ) FILTER (WHERE l.id IS NOT NULL),
          '[]'::json
        ) AS locations
      FROM route_cycles rc
      LEFT JOIN regions r ON r.id = rc.region_id
      LEFT JOIN route_cycle_locations rcl ON rcl.route_cycle_id = rc.id
      LEFT JOIN locations l ON l.id = rcl.location_id
      LEFT JOIN route_cycle_orders rco ON rco.route_cycle_id = rc.id
      ${where}
      GROUP BY rc.id, r.name
      ORDER BY
        CASE rc.status WHEN 'live' THEN 0 WHEN 'planned' THEN 1 WHEN 'closed' THEN 2 ELSE 3 END,
        rc.deadline_at DESC
      LIMIT $1
      `,
      params
    );

    return handleSuccess(res, 200, 'Route cycles retrieved', result.rows);
  } catch (err) {
    console.error('List route cycles error:', err.message);
    return handleError(res, err.status || 500, err.message || 'Failed to list route cycles', err);
  }
};

const createRouteCycle = async (req, res) => {
  const client = await pool.connect();

  try {
    const routeType = cleanRouteType(req.body.route_type);
    const name = cleanText(req.body.name, 'name', { required: true });
    const status = cleanRouteStatus(req.body.status, 'planned');
    const targetAmount = cleanMoney(req.body.target_amount, 'target_amount', routeType === 'weekly_route' ? 1200000 : 0);
    const startAt = cleanDate(req.body.start_at, 'start_at');
    const deadlineAt = cleanDate(req.body.deadline_at, 'deadline_at');
    const regionId = req.body.region_id ? parsePositiveId(req.body.region_id, 'region_id') : null;
    const notes = cleanText(req.body.notes, 'notes');
    const locationIds = cleanLocationIds(req.body.location_ids);

    if (new Date(deadlineAt).getTime() <= new Date(startAt).getTime()) {
      return handleError(res, 400, 'deadline_at must be after start_at');
    }

    await client.query('BEGIN');

    const result = await client.query(
      `
      INSERT INTO route_cycles (
        name,
        route_type,
        target_amount,
        start_at,
        deadline_at,
        status,
        region_id,
        created_by_user_id,
        notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
      `,
      [
        name,
        routeType,
        targetAmount,
        startAt,
        deadlineAt,
        status,
        regionId,
        req.user?.id || null,
        notes,
      ]
    );

    const cycle = result.rows[0];
    await replaceCycleLocations(client, cycle.id, locationIds);
    const syncedOrders = await syncExistingOrdersToCycle(client, cycle.id);

    await client.query('COMMIT');

    const terminal = await getTerminalData(pool, cycle.id);

    return handleSuccess(res, 201, 'Route cycle created', {
      cycle: terminal?.cycle || cycle,
      synced_orders: syncedOrders,
      terminal,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create route cycle error:', err.message);
    return handleError(res, err.status || 500, err.message || 'Failed to create route cycle', err);
  } finally {
    client.release();
  }
};

const updateRouteCycle = async (req, res) => {
  const client = await pool.connect();

  try {
    const cycleId = parsePositiveId(req.params.id);
    const current = await getCycleById(client, cycleId);
    if (!current) return handleError(res, 404, 'Route cycle not found');

    const routeType = req.body.route_type ? cleanRouteType(req.body.route_type) : current.route_type;
    const name = req.body.name !== undefined ? cleanText(req.body.name, 'name', { required: true }) : current.name;
    const status = req.body.status ? cleanRouteStatus(req.body.status, current.status) : current.status;
    const targetAmount = req.body.target_amount !== undefined
      ? cleanMoney(req.body.target_amount, 'target_amount')
      : toNumber(current.target_amount);
    const startAt = req.body.start_at ? cleanDate(req.body.start_at, 'start_at') : current.start_at;
    const deadlineAt = req.body.deadline_at ? cleanDate(req.body.deadline_at, 'deadline_at') : current.deadline_at;
    const regionId = req.body.region_id !== undefined && req.body.region_id !== null && req.body.region_id !== ''
      ? parsePositiveId(req.body.region_id, 'region_id')
      : (req.body.region_id === null || req.body.region_id === '' ? null : current.region_id);
    const notes = req.body.notes !== undefined ? cleanText(req.body.notes, 'notes') : current.notes;
    const locationIds = req.body.location_ids !== undefined ? cleanLocationIds(req.body.location_ids) : null;

    if (new Date(deadlineAt).getTime() <= new Date(startAt).getTime()) {
      return handleError(res, 400, 'deadline_at must be after start_at');
    }

    await client.query('BEGIN');

    await client.query(
      `
      UPDATE route_cycles
      SET
        name = $1,
        route_type = $2,
        target_amount = $3,
        start_at = $4,
        deadline_at = $5,
        status = $6,
        region_id = $7,
        notes = $8,
        updated_at = NOW()
      WHERE id = $9
      `,
      [name, routeType, targetAmount, startAt, deadlineAt, status, regionId, notes, cycleId]
    );

    if (locationIds) {
      await replaceCycleLocations(client, cycleId, locationIds);
    }

    const syncedOrders = await syncExistingOrdersToCycle(client, cycleId);
    await client.query('COMMIT');

    const terminal = await getTerminalData(pool, cycleId);

    return handleSuccess(res, 200, 'Route cycle updated', {
      cycle: terminal?.cycle || null,
      synced_orders: syncedOrders,
      terminal,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update route cycle error:', err.message);
    return handleError(res, err.status || 500, err.message || 'Failed to update route cycle', err);
  } finally {
    client.release();
  }
};

const closeRouteCycle = async (req, res) => {
  const client = await pool.connect();

  try {
    const cycleId = parsePositiveId(req.params.id);

    await client.query('BEGIN');

    await syncExistingOrdersToCycle(client, cycleId);

    const totalResult = await client.query(
      `
      SELECT COALESCE(SUM(order_amount), 0)::numeric AS final_amount
      FROM route_cycle_orders
      WHERE route_cycle_id = $1
      `,
      [cycleId]
    );

    const finalAmount = cleanMoney(totalResult.rows[0]?.final_amount, 'final_amount', 0);

    const result = await client.query(
      `
      UPDATE route_cycles
      SET
        status = 'closed',
        closed_at = NOW(),
        final_amount = $1,
        updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [finalAmount, cycleId]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Route cycle not found');
    }

    await client.query(
      `
      INSERT INTO route_cycle_events (
        route_cycle_id,
        event_type,
        title,
        event_amount,
        severity,
        metadata
      )
      VALUES ($1, 'route_cycle_closed', 'Route cycle closed', $2, 'success', $3::jsonb)
      `,
      [
        cycleId,
        finalAmount,
        JSON.stringify({ route_cycle_id: cycleId, final_amount: finalAmount }),
      ]
    );

    await client.query('COMMIT');

    const terminal = await getTerminalData(pool, cycleId);
    return handleSuccess(res, 200, 'Route cycle closed', terminal);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Close route cycle error:', err.message);
    return handleError(res, err.status || 500, err.message || 'Failed to close route cycle', err);
  } finally {
    client.release();
  }
};

const getCurrentRouteCycle = async (req, res) => {
  try {
    const cycle = await findCurrentCycle(pool, {
      route_type: req.query.route_type,
      region_id: req.query.region_id,
    });

    if (!cycle) {
      return handleSuccess(res, 200, 'No live route cycle found', null);
    }

    const terminal = await getTerminalData(pool, cycle.id, {
      limit: req.query.limit,
      interval_minutes: req.query.interval_minutes,
    });

    return handleSuccess(res, 200, 'Current route cycle retrieved', terminal);
  } catch (err) {
    console.error('Get current route cycle error:', err.message);
    return handleError(res, err.status || 500, err.message || 'Failed to get current route cycle', err);
  }
};

const getRouteTerminal = async (req, res) => {
  try {
    const cycleId = parsePositiveId(req.params.id);
    const terminal = await getTerminalData(pool, cycleId, {
      limit: req.query.limit,
      interval_minutes: req.query.interval_minutes,
    });

    if (!terminal) {
      return handleError(res, 404, 'Route cycle not found');
    }

    return handleSuccess(res, 200, 'Route terminal retrieved', terminal);
  } catch (err) {
    console.error('Get route terminal error:', err.message);
    return handleError(res, err.status || 500, err.message || 'Failed to get route terminal', err);
  }
};

const getRouteCandles = async (req, res) => {
  try {
    const cycleId = parsePositiveId(req.params.id);
    const candles = await getCycleCandles(pool, cycleId, req.query.interval_minutes);
    return handleSuccess(res, 200, 'Route candles retrieved', candles);
  } catch (err) {
    console.error('Get route candles error:', err.message);
    return handleError(res, err.status || 500, err.message || 'Failed to get route candles', err);
  }
};

const syncRouteCycleOrders = async (req, res) => {
  try {
    const cycleId = parsePositiveId(req.params.id);
    const syncedOrders = await syncExistingOrdersToCycle(pool, cycleId);
    const terminal = await getTerminalData(pool, cycleId);

    if (!terminal) {
      return handleError(res, 404, 'Route cycle not found');
    }

    return handleSuccess(res, 200, 'Route cycle orders synced', {
      synced_orders: syncedOrders,
      terminal,
    });
  } catch (err) {
    console.error('Sync route cycle orders error:', err.message);
    return handleError(res, err.status || 500, err.message || 'Failed to sync route cycle orders', err);
  }
};

module.exports = {
  listRouteCycles,
  createRouteCycle,
  updateRouteCycle,
  closeRouteCycle,
  getCurrentRouteCycle,
  getRouteTerminal,
  getRouteCandles,
  syncRouteCycleOrders,
};
