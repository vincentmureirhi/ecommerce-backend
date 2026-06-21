'use strict';

const ROUTE_ORDER_FILTER = `
  (
    o.order_type = 'route'
    OR o.order_workflow_type IN ('route_self_service', 'route_sales_rep_capture')
    OR c.customer_type = 'route'
    OR o.notes ILIKE '%[ROUTE_CUSTOMER_ORDER]%'
  )
`;

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isMissingRouteOpsSchema(err) {
  return err && ['42P01', '42703'].includes(err.code);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function calculatePace(cycle, achievedValue) {
  const target = toNumber(cycle.target_amount);
  const achieved = toNumber(achievedValue);
  const start = new Date(cycle.start_at).getTime();
  const deadline = new Date(cycle.deadline_at).getTime();
  const now = cycle.status === 'closed' && cycle.closed_at
    ? new Date(cycle.closed_at).getTime()
    : Date.now();

  const durationMs = Math.max(deadline - start, 1);
  const elapsedMs = clamp(now - start, 0, durationMs);
  const remainingMs = Math.max(deadline - now, 0);
  const elapsedHours = Math.max(elapsedMs / 3600000, 0.01);
  const remainingHours = Math.max(remainingMs / 3600000, 0);
  const totalHours = durationMs / 3600000;
  const remainingAmount = Math.max(target - achieved, 0);
  const currentPacePerHour = achieved / elapsedHours;
  const requiredPacePerHour = remainingHours > 0 ? remainingAmount / remainingHours : 0;
  const projectedClose = currentPacePerHour * totalHours;
  const achievedPercent = target > 0 ? (achieved / target) * 100 : 0;
  const elapsedPercent = (elapsedMs / durationMs) * 100;
  const confidencePercent = target > 0 ? Math.min((projectedClose / target) * 100, 999) : 0;

  let signal = 'watch';
  if (achieved >= target && target > 0) signal = 'target_hit';
  else if (confidencePercent >= 100) signal = 'on_pace';
  else if (confidencePercent >= 80) signal = 'needs_push';
  else signal = 'behind_pace';

  return {
    target_amount: Number(target.toFixed(2)),
    achieved_amount: Number(achieved.toFixed(2)),
    remaining_amount: Number(remainingAmount.toFixed(2)),
    achieved_percent: Number(achievedPercent.toFixed(2)),
    elapsed_percent: Number(elapsedPercent.toFixed(2)),
    current_pace_per_hour: Number(currentPacePerHour.toFixed(2)),
    required_pace_per_hour: Number(requiredPacePerHour.toFixed(2)),
    projected_close_amount: Number(projectedClose.toFixed(2)),
    confidence_percent: Number(confidencePercent.toFixed(2)),
    hours_remaining: Number(remainingHours.toFixed(2)),
    seconds_remaining: Math.max(Math.floor(remainingMs / 1000), 0),
    signal,
  };
}

async function getCycleById(db, cycleId) {
  const result = await db.query(
    `
    SELECT
      rc.*,
      r.name AS region_name,
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
    WHERE rc.id = $1
    GROUP BY rc.id, r.name
    `,
    [cycleId]
  );

  return result.rows[0] || null;
}

async function findCurrentCycle(db, options = {}) {
  const params = [];
  let filter = '';

  if (options.route_type) {
    params.push(options.route_type);
    filter += ` AND rc.route_type = $${params.length}`;
  }

  if (options.region_id) {
    params.push(Number(options.region_id));
    filter += ` AND rc.region_id = $${params.length}`;
  }

  const result = await db.query(
    `
    SELECT rc.id
    FROM route_cycles rc
    WHERE rc.status = 'live'
      AND rc.start_at <= NOW()
      AND rc.deadline_at >= NOW()
      ${filter}
    ORDER BY rc.deadline_at ASC, rc.start_at DESC
    LIMIT 1
    `,
    params
  );

  if (!result.rows[0]) return null;
  return getCycleById(db, result.rows[0].id);
}

async function syncExistingOrdersToCycle(db, cycleId) {
  const result = await db.query(
    `
    WITH matched_orders AS (
      SELECT
        rc.id AS route_cycle_id,
        o.id AS order_id,
        o.sales_rep_id,
        o.customer_id AS route_customer_id,
        COALESCE(o.total_amount, 0)::numeric AS order_amount,
        o.created_at AS captured_at
      FROM route_cycles rc
      JOIN orders o
        ON o.created_at >= rc.start_at
       AND o.created_at <= rc.deadline_at
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN locations l ON l.id = c.location_id
      WHERE rc.id = $1
        AND ${ROUTE_ORDER_FILTER}
        AND (
          rc.region_id IS NULL
          OR l.region_id = rc.region_id
        )
        AND (
          NOT EXISTS (
            SELECT 1 FROM route_cycle_locations rcl
            WHERE rcl.route_cycle_id = rc.id
          )
          OR EXISTS (
            SELECT 1 FROM route_cycle_locations rcl
            WHERE rcl.route_cycle_id = rc.id
              AND rcl.location_id = c.location_id
          )
        )
    )
    INSERT INTO route_cycle_orders (
      route_cycle_id,
      order_id,
      sales_rep_id,
      route_customer_id,
      order_amount,
      captured_at
    )
    SELECT
      route_cycle_id,
      order_id,
      sales_rep_id,
      route_customer_id,
      order_amount,
      captured_at
    FROM matched_orders
    ON CONFLICT (order_id) DO NOTHING
    RETURNING id
    `,
    [cycleId]
  );

  return result.rowCount;
}

async function attachOrderToActiveRouteCycle(db, { orderId }) {
  try {
    const candidate = await db.query(
      `
      SELECT
        rc.id AS route_cycle_id,
        rc.name AS route_cycle_name,
        rc.target_amount,
        rc.deadline_at,
        o.id AS order_id,
        o.order_number,
        o.sales_rep_id,
        o.customer_id AS route_customer_id,
        COALESCE(o.customer_name, c.name) AS customer_name,
        COALESCE(o.total_amount, 0)::numeric AS order_amount,
        o.created_at AS captured_at,
        COALESCE(sr.full_name, sr.name) AS sales_rep_name,
        c.phone AS customer_phone,
        l.name AS location_name,
        r.name AS region_name,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM route_cycle_locations rcl
            WHERE rcl.route_cycle_id = rc.id
              AND rcl.location_id = c.location_id
          ) THEN 1
          ELSE 0
        END AS location_match
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN locations l ON l.id = c.location_id
      LEFT JOIN regions r ON r.id = l.region_id
      LEFT JOIN sales_reps sr ON sr.id = o.sales_rep_id
      JOIN route_cycles rc
        ON rc.status = 'live'
       AND o.created_at >= rc.start_at
       AND o.created_at <= rc.deadline_at
       AND (
         rc.region_id IS NULL
         OR rc.region_id = l.region_id
       )
       AND (
         NOT EXISTS (
           SELECT 1 FROM route_cycle_locations rcl
           WHERE rcl.route_cycle_id = rc.id
         )
         OR EXISTS (
           SELECT 1 FROM route_cycle_locations rcl
           WHERE rcl.route_cycle_id = rc.id
             AND rcl.location_id = c.location_id
         )
       )
      WHERE o.id = $1
        AND ${ROUTE_ORDER_FILTER}
      ORDER BY location_match DESC, rc.deadline_at ASC, rc.start_at DESC
      LIMIT 1
      `,
      [orderId]
    );

    const row = candidate.rows[0];
    if (!row) return null;

    const insert = await db.query(
      `
      INSERT INTO route_cycle_orders (
        route_cycle_id,
        order_id,
        sales_rep_id,
        route_customer_id,
        order_amount,
        captured_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (order_id) DO NOTHING
      RETURNING id
      `,
      [
        row.route_cycle_id,
        row.order_id,
        row.sales_rep_id,
        row.route_customer_id,
        row.order_amount,
        row.captured_at,
      ]
    );

    if (insert.rowCount === 0) return null;

    const orderAmount = toNumber(row.order_amount);
    const targetAmount = toNumber(row.target_amount);
    const isLargeOrder = orderAmount >= Math.max(50000, targetAmount * 0.08);

    const event = {
      route_cycle_id: row.route_cycle_id,
      route_cycle_name: row.route_cycle_name,
      order_id: row.order_id,
      order_number: row.order_number,
      event_type: isLargeOrder ? 'large_route_order' : 'route_order_created',
      title: isLargeOrder ? 'Large route order captured' : 'Route order captured',
      event_amount: Number(orderAmount.toFixed(2)),
      severity: isLargeOrder ? 'success' : 'info',
      customer_name: row.customer_name,
      sales_rep_name: row.sales_rep_name,
      location_name: row.location_name,
      region_name: row.region_name,
      captured_at: toIso(row.captured_at),
    };

    await db.query(
      `
      INSERT INTO route_cycle_events (
        route_cycle_id,
        order_id,
        event_type,
        title,
        event_amount,
        severity,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `,
      [
        event.route_cycle_id,
        event.order_id,
        event.event_type,
        event.title,
        event.event_amount,
        event.severity,
        JSON.stringify(event),
      ]
    );

    return event;
  } catch (err) {
    if (isMissingRouteOpsSchema(err)) {
      console.warn('Route operations schema missing; order was not attached to a route cycle.');
      return null;
    }

    throw err;
  }
}

async function getCycleCandles(db, cycleId, intervalMinutes = 30) {
  const safeInterval = [15, 30, 60, 120].includes(Number(intervalMinutes))
    ? Number(intervalMinutes)
    : 30;

  const result = await db.query(
    `
    SELECT
      (
        DATE_TRUNC('hour', rco.captured_at)
        + FLOOR(EXTRACT(MINUTE FROM rco.captured_at) / $2)::int * ($2 * INTERVAL '1 minute')
      ) AS bucket_start,
      COUNT(DISTINCT rco.order_id)::int AS order_count,
      COUNT(DISTINCT rco.route_customer_id)::int AS customer_count,
      COALESCE(SUM(rco.order_amount), 0)::numeric AS route_value,
      COALESCE(MAX(rco.order_amount), 0)::numeric AS largest_order_amount
    FROM route_cycle_orders rco
    WHERE rco.route_cycle_id = $1
    GROUP BY bucket_start
    ORDER BY bucket_start ASC
    `,
    [cycleId, safeInterval]
  );

  let running = 0;

  return result.rows.map((row) => {
    const open = running;
    const value = toNumber(row.route_value);
    running += value;
    const close = running;
    const high = Math.max(open, close);
    const low = Math.min(open, close);

    return {
      time: row.bucket_start,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: toNumber(row.order_count),
      customer_count: toNumber(row.customer_count),
      interval_value: Number(value.toFixed(2)),
      largest_order_amount: Number(toNumber(row.largest_order_amount).toFixed(2)),
    };
  });
}

async function getTerminalData(db, cycleId, options = {}) {
  const cycle = await getCycleById(db, cycleId);
  if (!cycle) return null;

  const limit = Math.min(Math.max(Number(options.limit) || 12, 1), 50);

  const [
    summaryResult,
    topProductsResult,
    topSalesRepsResult,
    topCustomersResult,
    locationResult,
    recentOrdersResult,
    eventsResult,
    candles,
  ] = await Promise.all([
    db.query(
      `
      SELECT
        COUNT(DISTINCT rco.order_id)::int AS order_count,
        COUNT(DISTINCT rco.route_customer_id)::int AS customer_count,
        COUNT(DISTINCT rco.sales_rep_id)::int AS sales_rep_count,
        COALESCE(SUM(rco.order_amount), 0)::numeric AS achieved_amount,
        COALESCE(AVG(rco.order_amount), 0)::numeric AS average_order_value,
        COALESCE(MAX(rco.order_amount), 0)::numeric AS largest_order_amount,
        MAX(rco.captured_at) AS last_order_at
      FROM route_cycle_orders rco
      WHERE rco.route_cycle_id = $1
      `,
      [cycleId]
    ),
    db.query(
      `
      SELECT
        p.id,
        p.name,
        p.sku,
        COALESCE(SUM(oi.quantity), 0)::int AS units_ordered,
        COUNT(DISTINCT oi.order_id)::int AS order_count,
        COALESCE(SUM(COALESCE(oi.line_total, oi.quantity * oi.price_at_purchase)), 0)::numeric AS route_value
      FROM route_cycle_orders rco
      JOIN order_items oi ON oi.order_id = rco.order_id
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE rco.route_cycle_id = $1
      GROUP BY p.id, p.name, p.sku
      ORDER BY route_value DESC, units_ordered DESC
      LIMIT $2
      `,
      [cycleId, limit]
    ),
    db.query(
      `
      SELECT
        sr.id,
        COALESCE(sr.full_name, sr.name, 'Unassigned') AS name,
        COALESCE(sr.phone, sr.phone_number) AS phone,
        COUNT(DISTINCT rco.order_id)::int AS order_count,
        COUNT(DISTINCT rco.route_customer_id)::int AS customer_count,
        COALESCE(SUM(rco.order_amount), 0)::numeric AS route_value,
        COALESCE(AVG(rco.order_amount), 0)::numeric AS average_order_value,
        MAX(rco.captured_at) AS last_order_at
      FROM route_cycle_orders rco
      LEFT JOIN sales_reps sr ON sr.id = rco.sales_rep_id
      WHERE rco.route_cycle_id = $1
      GROUP BY sr.id, sr.full_name, sr.name, sr.phone, sr.phone_number
      ORDER BY route_value DESC, order_count DESC
      LIMIT $2
      `,
      [cycleId, limit]
    ),
    db.query(
      `
      SELECT
        c.id,
        COALESCE(c.name, o.customer_name) AS name,
        COALESCE(c.phone, o.customer_phone) AS phone,
        l.name AS location_name,
        COUNT(DISTINCT rco.order_id)::int AS order_count,
        COALESCE(SUM(rco.order_amount), 0)::numeric AS route_value,
        COALESCE(AVG(rco.order_amount), 0)::numeric AS average_order_value,
        MAX(rco.captured_at) AS last_order_at
      FROM route_cycle_orders rco
      JOIN orders o ON o.id = rco.order_id
      LEFT JOIN customers c ON c.id = rco.route_customer_id
      LEFT JOIN locations l ON l.id = c.location_id
      WHERE rco.route_cycle_id = $1
      GROUP BY c.id, c.name, c.phone, o.customer_name, o.customer_phone, l.name
      ORDER BY route_value DESC, order_count DESC
      LIMIT $2
      `,
      [cycleId, limit]
    ),
    db.query(
      `
      SELECT
        l.id,
        COALESCE(l.name, 'Unassigned') AS name,
        COUNT(DISTINCT rco.order_id)::int AS order_count,
        COUNT(DISTINCT rco.route_customer_id)::int AS customer_count,
        COALESCE(SUM(rco.order_amount), 0)::numeric AS route_value
      FROM route_cycle_orders rco
      JOIN orders o ON o.id = rco.order_id
      LEFT JOIN customers c ON c.id = rco.route_customer_id
      LEFT JOIN locations l ON l.id = c.location_id
      WHERE rco.route_cycle_id = $1
      GROUP BY l.id, l.name
      ORDER BY route_value DESC, order_count DESC
      LIMIT $2
      `,
      [cycleId, limit]
    ),
    db.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.customer_name,
        o.customer_phone,
        o.total_amount,
        o.order_status,
        o.created_at,
        COALESCE(sr.full_name, sr.name) AS sales_rep_name,
        l.name AS location_name
      FROM route_cycle_orders rco
      JOIN orders o ON o.id = rco.order_id
      LEFT JOIN sales_reps sr ON sr.id = rco.sales_rep_id
      LEFT JOIN customers c ON c.id = rco.route_customer_id
      LEFT JOIN locations l ON l.id = c.location_id
      WHERE rco.route_cycle_id = $1
      ORDER BY rco.captured_at DESC
      LIMIT $2
      `,
      [cycleId, limit]
    ),
    db.query(
      `
      SELECT *
      FROM route_cycle_events
      WHERE route_cycle_id = $1
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [cycleId, limit]
    ),
    getCycleCandles(db, cycleId, options.interval_minutes || 30),
  ]);

  const summary = summaryResult.rows[0] || {};
  const achieved = toNumber(summary.achieved_amount);
  const pace = calculatePace(cycle, achieved);

  return {
    cycle,
    summary: {
      order_count: toNumber(summary.order_count),
      customer_count: toNumber(summary.customer_count),
      sales_rep_count: toNumber(summary.sales_rep_count),
      average_order_value: Number(toNumber(summary.average_order_value).toFixed(2)),
      largest_order_amount: Number(toNumber(summary.largest_order_amount).toFixed(2)),
      last_order_at: summary.last_order_at || null,
      ...pace,
    },
    target_line: Number(toNumber(cycle.target_amount).toFixed(2)),
    candles,
    top_products: topProductsResult.rows,
    top_sales_reps: topSalesRepsResult.rows,
    top_route_customers: topCustomersResult.rows,
    location_leaderboard: locationResult.rows,
    live_order_tape: recentOrdersResult.rows,
    events: eventsResult.rows,
  };
}

module.exports = {
  attachOrderToActiveRouteCycle,
  calculatePace,
  findCurrentCycle,
  getCycleById,
  getCycleCandles,
  getTerminalData,
  syncExistingOrdersToCycle,
};
