'use strict';

const pool = require('../config/database');
const { handleSuccess, handleError } = require('../utils/errorHandler');

const getDateRange = (filter) => {
  const today = new Date();
  let startDate, endDate = new Date();
  switch (filter) {
    case 'today':
      startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      break;
    case 'yesterday':
      startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
      endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      break;
    case '7days':
      startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30days':
      startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case 'thismonth':
      startDate = new Date(today.getFullYear(), today.getMonth(), 1);
      break;
    default:
      startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return { startDate, endDate };
};

function toNumber(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function toInt(value, fallback = 0) {
  const numberValue = Number.parseInt(value, 10);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function parseLimit(value, fallback, max = 50) {
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit <= 0) return fallback;
  return Math.min(limit, max);
}

function percentChange(current, previous) {
  const currentValue = toNumber(current);
  const previousValue = toNumber(previous);
  if (currentValue === 0 && previousValue === 0) return null;
  if (previousValue === 0) return 100;
  return Number((((currentValue - previousValue) / previousValue) * 100).toFixed(1));
}

function getPreviousRange(startDate, endDate) {
  const duration = endDate.getTime() - startDate.getTime();
  return {
    prevStartDate: new Date(startDate.getTime() - duration),
    prevEndDate: new Date(startDate.getTime()),
  };
}

const getDashboardOverview = async (req, res) => {
  try {
    const { filter = '30days' } = req.query;
    const limit = parseLimit(req.query.limit, 10, 50);
    const { startDate, endDate } = getDateRange(filter);
    const { prevStartDate, prevEndDate } = getPreviousRange(startDate, endDate);
    const paidStatuses = ['completed', 'manually_resolved'];
    const failedStatuses = ['failed', 'cancelled', 'timeout'];
    const openPaymentStatuses = ['initiated', 'pending'];

    const [
      kpiResult,
      previousResult,
      trendResult,
      stockResult,
      lowStockResult,
      topProductsResult,
      recentOrdersResult,
      revenueByRegionResult,
      topCustomersResult,
      topSalesRepsResult,
      paymentHealthResult,
      recentActivityResult,
      morningSummaryResult,
    ] = await Promise.all([
      pool.query(
        `
        WITH paid_payments AS (
          SELECT COALESCE(SUM(COALESCE(received_amount, amount, 0)), 0)::numeric(14,2) AS revenue
          FROM payments
          WHERE LOWER(status) = ANY($3::text[])
            AND created_at >= $1
            AND created_at <= $2
        ),
        period_orders AS (
          SELECT
            COUNT(*)::int AS orders,
            COALESCE(SUM(total_amount), 0)::numeric(14,2) AS ordered_value,
            COUNT(DISTINCT COALESCE(NULLIF(customer_phone, ''), NULLIF(customer_name, ''), customer_id::text))::int AS customers,
            COUNT(*) FILTER (WHERE LOWER(COALESCE(order_status, 'pending')) IN ('pending', 'processing'))::int AS awaiting_dispatch
          FROM orders
          WHERE created_at >= $1
            AND created_at <= $2
            AND LOWER(COALESCE(order_status, 'pending')) <> 'cancelled'
        ),
        period_payments AS (
          SELECT
            COUNT(*)::int AS total_payments,
            COUNT(*) FILTER (WHERE LOWER(status) = ANY($3::text[]))::int AS successful_payments,
            COUNT(*) FILTER (WHERE LOWER(status) = ANY($4::text[]))::int AS failed_payments,
            COUNT(*) FILTER (WHERE LOWER(status) = ANY($5::text[]))::int AS pending_payments
          FROM payments
          WHERE created_at >= $1
            AND created_at <= $2
        )
        SELECT
          pp.revenue,
          po.orders,
          po.ordered_value,
          po.customers,
          po.awaiting_dispatch,
          py.total_payments,
          py.successful_payments,
          py.failed_payments,
          py.pending_payments,
          CASE
            WHEN py.total_payments > 0
              THEN ROUND((py.successful_payments::numeric / py.total_payments::numeric) * 100)
            ELSE 0
          END::int AS payment_success_rate
        FROM paid_payments pp, period_orders po, period_payments py
        `,
        [startDate, endDate, paidStatuses, failedStatuses, openPaymentStatuses]
      ),
      pool.query(
        `
        WITH paid_payments AS (
          SELECT COALESCE(SUM(COALESCE(received_amount, amount, 0)), 0)::numeric(14,2) AS revenue
          FROM payments
          WHERE LOWER(status) = ANY($3::text[])
            AND created_at >= $1
            AND created_at < $2
        ),
        period_orders AS (
          SELECT
            COUNT(*)::int AS orders,
            COUNT(DISTINCT COALESCE(NULLIF(customer_phone, ''), NULLIF(customer_name, ''), customer_id::text))::int AS customers
          FROM orders
          WHERE created_at >= $1
            AND created_at < $2
            AND LOWER(COALESCE(order_status, 'pending')) <> 'cancelled'
        ),
        period_payments AS (
          SELECT
            COUNT(*)::int AS total_payments,
            COUNT(*) FILTER (WHERE LOWER(status) = ANY($3::text[]))::int AS successful_payments,
            COUNT(*) FILTER (WHERE LOWER(status) = ANY($4::text[]))::int AS pending_payments
          FROM payments
          WHERE created_at >= $1
            AND created_at < $2
        )
        SELECT
          pp.revenue,
          po.orders,
          po.customers,
          py.pending_payments,
          CASE
            WHEN py.total_payments > 0
              THEN ROUND((py.successful_payments::numeric / py.total_payments::numeric) * 100)
            ELSE 0
          END::int AS payment_success_rate
        FROM paid_payments pp, period_orders po, period_payments py
        `,
        [prevStartDate, prevEndDate, paidStatuses, openPaymentStatuses]
      ),
      pool.query(
        `
        SELECT
          TO_CHAR(day::date, 'Mon DD') AS date,
          COALESCE(SUM(COALESCE(p.received_amount, p.amount, 0)), 0)::numeric(14,2) AS revenue,
          COUNT(DISTINCT o.id)::int AS orders
        FROM generate_series($1::date, $2::date, INTERVAL '1 day') day
        LEFT JOIN payments p
          ON p.created_at >= day
         AND p.created_at < day + INTERVAL '1 day'
         AND LOWER(p.status) = ANY($3::text[])
        LEFT JOIN orders o
          ON o.id = p.order_id
        GROUP BY day
        ORDER BY day ASC
        `,
        [startDate, endDate, paidStatuses]
      ),
      pool.query(
        `
        WITH product_sales AS (
          SELECT
            p.id,
            COALESCE(SUM(oi.quantity) FILTER (WHERE o.created_at >= NOW() - INTERVAL '7 days'), 0) AS units_sold_7d,
            COALESCE(SUM(oi.quantity) FILTER (WHERE o.created_at >= NOW() - INTERVAL '30 days'), 0) AS units_sold_30d,
            COALESCE(SUM(oi.quantity), 0) AS total_units_sold,
            MAX(o.created_at) AS last_sale_at
          FROM products p
          LEFT JOIN order_items oi ON oi.product_id = p.id
          LEFT JOIN orders o
            ON o.id = oi.order_id
           AND LOWER(COALESCE(o.order_status, 'pending')) <> 'cancelled'
          WHERE COALESCE(p.is_active, TRUE) = TRUE
          GROUP BY p.id
        )
        SELECT
          COUNT(*)::int AS total_skus,
          COALESCE(SUM(COALESCE(p.current_stock, 0)), 0)::int AS total_units_in_stock,
          COALESCE(SUM(COALESCE(p.current_stock, 0) * COALESCE(p.cost_price, 0)), 0)::numeric(14,2) AS stock_value,
          COUNT(*) FILTER (WHERE COALESCE(p.current_stock, 0) <= 0)::int AS out_of_stock,
          COUNT(*) FILTER (
            WHERE COALESCE(p.current_stock, 0) > 0
              AND COALESCE(p.current_stock, 0) <= GREATEST(COALESCE(p.reorder_level, 10), 10)
          )::int AS low_stock,
          COUNT(*) FILTER (
            WHERE COALESCE(p.current_stock, 0) > 0
              AND COALESCE(p.reorder_level, 0) > 0
              AND COALESCE(p.current_stock, 0) <= COALESCE(p.reorder_level, 0)
          )::int AS reorder_now,
          COUNT(*) FILTER (WHERE ps.units_sold_7d >= 10 OR ps.units_sold_30d >= 30)::int AS fast_moving,
          COUNT(*) FILTER (
            WHERE ps.total_units_sold = 0
               OR ps.last_sale_at IS NULL
               OR ps.last_sale_at < NOW() - INTERVAL '60 days'
          )::int AS dead_stock,
          COUNT(*) FILTER (
            WHERE ps.total_units_sold > 0
              AND ps.last_sale_at >= NOW() - INTERVAL '60 days'
              AND (ps.last_sale_at < NOW() - INTERVAL '30 days' OR ps.units_sold_30d < 5)
          )::int AS slow_moving,
          COALESCE(SUM(
            CASE
              WHEN ps.total_units_sold = 0
                OR ps.last_sale_at IS NULL
                OR ps.last_sale_at < NOW() - INTERVAL '60 days'
              THEN COALESCE(p.current_stock, 0) * COALESCE(p.cost_price, 0)
              ELSE 0
            END
          ), 0)::numeric(14,2) AS dead_stock_value
        FROM products p
        LEFT JOIN product_sales ps ON ps.id = p.id
        WHERE COALESCE(p.is_active, TRUE) = TRUE
        `
      ),
      pool.query(
        `
        SELECT
          p.id,
          p.name,
          COALESCE(p.current_stock, 0)::int AS current_stock,
          COALESCE(p.retail_price, 0)::numeric(12,2) AS retail_price,
          COALESCE(p.reorder_level, 0)::int AS reorder_level
        FROM products p
        WHERE COALESCE(p.is_active, TRUE) = TRUE
          AND COALESCE(p.current_stock, 0) <= GREATEST(COALESCE(p.reorder_level, 10), 10)
        ORDER BY COALESCE(p.current_stock, 0) ASC, p.name ASC
        LIMIT $1
        `,
        [limit]
      ),
      pool.query(
        `
        SELECT
          p.id,
          p.name,
          COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
          COALESCE(SUM(oi.quantity * oi.price_at_purchase), 0)::numeric(14,2) AS revenue
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        INNER JOIN products p ON p.id = oi.product_id
        WHERE o.created_at >= $1
          AND o.created_at <= $2
          AND LOWER(COALESCE(o.order_status, 'pending')) <> 'cancelled'
        GROUP BY p.id, p.name
        HAVING COALESCE(SUM(oi.quantity), 0) > 0
        ORDER BY units_sold DESC, revenue DESC
        LIMIT $3
        `,
        [startDate, endDate, limit]
      ),
      pool.query(
        `
        SELECT
          o.id,
          o.order_number,
          COALESCE(o.customer_name, c.name, 'Unknown') AS customer_name,
          COALESCE(o.total_amount, 0)::numeric(14,2) AS total_amount,
          COALESCE(o.order_status, 'pending') AS status,
          o.created_at
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        ORDER BY o.created_at DESC
        LIMIT $1
        `,
        [limit]
      ),
      pool.query(
        `
        SELECT
          COALESCE(r.name, l.name, 'Unassigned') AS name,
          COALESCE(SUM(
            CASE
              WHEN LOWER(p.status) = ANY($3::text[])
              THEN COALESCE(p.received_amount, p.amount, 0)
              ELSE 0
            END
          ), 0)::numeric(14,2) AS revenue,
          COUNT(DISTINCT o.id)::int AS orders
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN locations l ON l.id = c.location_id
        LEFT JOIN regions r ON r.id = l.region_id
        LEFT JOIN payments p
          ON p.order_id = o.id
         AND p.created_at >= $1
         AND p.created_at <= $2
        WHERE o.created_at >= $1
          AND o.created_at <= $2
          AND LOWER(COALESCE(o.order_status, 'pending')) <> 'cancelled'
        GROUP BY COALESCE(r.name, l.name, 'Unassigned')
        ORDER BY revenue DESC, orders DESC
        LIMIT $4
        `,
        [startDate, endDate, paidStatuses, limit]
      ),
      pool.query(
        `
        SELECT
          COALESCE(c.name, o.customer_name, 'Unknown') AS name,
          COUNT(DISTINCT o.id)::int AS order_count,
          COALESCE(SUM(o.total_amount), 0)::numeric(14,2) AS total_spent
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.created_at >= $1
          AND o.created_at <= $2
          AND LOWER(COALESCE(o.order_status, 'pending')) <> 'cancelled'
        GROUP BY COALESCE(c.name, o.customer_name, 'Unknown')
        ORDER BY total_spent DESC, order_count DESC
        LIMIT $3
        `,
        [startDate, endDate, limit]
      ),
      pool.query(
        `
        SELECT
          COALESCE(sr.full_name, sr.name, 'Unassigned') AS name,
          COUNT(DISTINCT o.id)::int AS order_count,
          COALESCE(SUM(o.total_amount), 0)::numeric(14,2) AS revenue
        FROM orders o
        LEFT JOIN sales_reps sr ON sr.id = o.sales_rep_id
        WHERE o.created_at >= $1
          AND o.created_at <= $2
          AND LOWER(COALESCE(o.order_status, 'pending')) <> 'cancelled'
        GROUP BY COALESCE(sr.full_name, sr.name, 'Unassigned')
        HAVING COUNT(DISTINCT o.id) > 0
        ORDER BY revenue DESC, order_count DESC
        LIMIT $3
        `,
        [startDate, endDate, limit]
      ),
      pool.query(
        `
        SELECT
          COUNT(*)::int AS total_payments,
          COUNT(*) FILTER (WHERE LOWER(status) = ANY($1::text[]))::int AS successful_payments,
          COUNT(*) FILTER (WHERE LOWER(status) = ANY($2::text[]))::int AS failed_payments,
          COUNT(*) FILTER (WHERE LOWER(status) = ANY($3::text[]))::int AS pending_payments,
          COUNT(*) FILTER (
            WHERE LOWER(status) = ANY($3::text[])
              AND created_at <= NOW() - INTERVAL '10 minutes'
          )::int AS pending_old,
          COUNT(*) FILTER (WHERE order_id IS NULL)::int AS unmatched,
          COUNT(*) FILTER (
            WHERE LOWER(status) = ANY($2::text[])
              AND created_at >= CURRENT_DATE
          )::int AS failed_today
        FROM payments
        WHERE created_at >= $4
          AND created_at <= $5
        `,
        [paidStatuses, failedStatuses, openPaymentStatuses, startDate, endDate]
      ),
      pool.query(
        `
        SELECT *
        FROM (
          SELECT
            'order' AS type,
            'Order #' || COALESCE(order_number, id::text) || ' placed' AS message,
            created_at AS timestamp
          FROM orders
          UNION ALL
          SELECT
            'payment' AS type,
            CASE
              WHEN LOWER(status) = ANY($1::text[]) THEN 'Payment confirmed'
              WHEN LOWER(status) = ANY($2::text[]) THEN 'Payment failed'
              ELSE 'Payment pending'
            END AS message,
            created_at AS timestamp
          FROM payments
        ) activity
        ORDER BY timestamp DESC
        LIMIT $3
        `,
        [paidStatuses, failedStatuses, limit]
      ),
      pool.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE o.created_at >= CURRENT_DATE)::int AS new_orders,
          COALESCE(SUM(
            CASE
              WHEN p.created_at >= CURRENT_DATE
               AND LOWER(p.status) = ANY($1::text[])
              THEN COALESCE(p.received_amount, p.amount, 0)
              ELSE 0
            END
          ), 0)::numeric(14,2) AS revenue,
          COUNT(DISTINCT o.id) FILTER (
            WHERE o.created_at >= CURRENT_DATE
              AND LOWER(COALESCE(o.order_status, 'pending')) IN ('pending', 'processing')
          )::int AS pending_dispatch,
          COUNT(p.id) FILTER (
            WHERE p.created_at >= CURRENT_DATE
              AND LOWER(p.status) = ANY($2::text[])
          )::int AS failed_payments
        FROM orders o
        LEFT JOIN payments p ON p.order_id = o.id
        `,
        [paidStatuses, failedStatuses]
      ),
    ]);

    const kpi = kpiResult.rows[0] || {};
    const previous = previousResult.rows[0] || {};
    const stock = stockResult.rows[0] || {};
    const paymentHealth = paymentHealthResult.rows[0] || {};
    const morning = morningSummaryResult.rows[0] || {};

    const revenue = toNumber(kpi.revenue);
    const orders = toInt(kpi.orders);
    const paymentSuccessRate = toInt(kpi.payment_success_rate);
    const pendingPayments = toInt(kpi.pending_payments);
    const newCustomers = toInt(kpi.customers);

    const inventoryIntelligence = {
      low_stock: toInt(stock.low_stock),
      reorder_now: toInt(stock.reorder_now),
      out_of_stock: toInt(stock.out_of_stock),
      fast_moving: toInt(stock.fast_moving),
      slow_moving: toInt(stock.slow_moving),
      dead_stock: toInt(stock.dead_stock),
      dead_stock_value: Math.round(toNumber(stock.dead_stock_value)),
      total_skus: toInt(stock.total_skus),
      total_units_in_stock: toInt(stock.total_units_in_stock),
      stock_value: toNumber(stock.stock_value),
    };

    const alerts = [];
    if (toInt(kpi.awaiting_dispatch) > 0) {
      alerts.push({
        type: 'dispatch-queue',
        severity: 'warning',
        message: `${toInt(kpi.awaiting_dispatch)} orders are waiting for movement`,
        action: 'Open orders',
        link: '/orders',
      });
    }
    if (toInt(paymentHealth.failed_today) > 0) {
      alerts.push({
        type: 'failed-payments',
        severity: 'error',
        message: `${toInt(paymentHealth.failed_today)} payments failed today`,
        action: 'Open payment desk',
        link: '/payments',
      });
    }
    if (toInt(paymentHealth.pending_old) > 0) {
      alerts.push({
        type: 'old-pending-payments',
        severity: 'warning',
        message: `${toInt(paymentHealth.pending_old)} payments are pending for 10+ minutes`,
        action: 'Check payments',
        link: '/payments',
      });
    }
    if (inventoryIntelligence.out_of_stock > 0) {
      alerts.push({
        type: 'out-of-stock',
        severity: 'error',
        message: `${inventoryIntelligence.out_of_stock} SKUs are out of stock`,
        action: 'Open inventory',
        link: '/inventory',
      });
    }
    if (inventoryIntelligence.reorder_now > 0 || inventoryIntelligence.low_stock > 0) {
      alerts.push({
        type: 'reorder-pressure',
        severity: 'warning',
        message: `${inventoryIntelligence.reorder_now + inventoryIntelligence.low_stock} SKUs need stock attention`,
        action: 'Review reorder list',
        link: '/inventory',
      });
    }

    const data = {
      generated_at: new Date().toISOString(),
      filter,
      range: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      kpis: {
        revenue: Math.round(revenue),
        orders,
        aov: orders > 0 ? Math.round(revenue / orders) : 0,
        payment_success_rate: paymentSuccessRate,
        failed_payments: toInt(kpi.failed_payments),
        pending_payments: pendingPayments,
        low_stock: inventoryIntelligence.low_stock + inventoryIntelligence.reorder_now,
        out_of_stock: inventoryIntelligence.out_of_stock,
        awaiting_dispatch: toInt(kpi.awaiting_dispatch),
        new_customers: newCustomers,
        revenue_trend: percentChange(revenue, previous.revenue),
        orders_trend: percentChange(orders, previous.orders),
        payment_trend: percentChange(paymentSuccessRate, previous.payment_success_rate),
        pending_trend: percentChange(pendingPayments, previous.pending_payments),
        customer_trend: percentChange(newCustomers, previous.customers),
      },
      trend: trendResult.rows.map((row) => ({
        date: row.date,
        orders: toInt(row.orders),
        revenue: Math.round(toNumber(row.revenue)),
      })),
      alerts,
      top_products: topProductsResult.rows.map((row) => ({
        id: row.id,
        name: row.name,
        units_sold: toInt(row.units_sold),
        revenue: Math.round(toNumber(row.revenue)),
      })),
      low_stock: lowStockResult.rows.map((row) => ({
        id: row.id,
        name: row.name,
        current_stock: toInt(row.current_stock),
        retail_price: toNumber(row.retail_price),
        reorder_level: toInt(row.reorder_level),
      })),
      recent_orders: recentOrdersResult.rows.map((row) => ({
        id: row.id,
        order_number: row.order_number || `ORD-${row.id}`,
        customer_name: row.customer_name || 'Unknown',
        total_amount: toNumber(row.total_amount),
        status: row.status || 'pending',
        created_at: row.created_at,
      })),
      revenue_by_region: revenueByRegionResult.rows.map((row) => ({
        name: row.name,
        revenue: Math.round(toNumber(row.revenue)),
        orders: toInt(row.orders),
      })),
      top_customers: topCustomersResult.rows.map((row) => ({
        name: row.name,
        order_count: toInt(row.order_count),
        total_spent: Math.round(toNumber(row.total_spent)),
      })),
      top_sales_reps: topSalesRepsResult.rows.map((row) => ({
        name: row.name,
        order_count: toInt(row.order_count),
        revenue: Math.round(toNumber(row.revenue)),
      })),
      payment_health: {
        success_rate:
          toInt(paymentHealth.total_payments) > 0
            ? Math.round((toInt(paymentHealth.successful_payments) / toInt(paymentHealth.total_payments)) * 100)
            : 0,
        failed_today: toInt(paymentHealth.failed_today),
        pending_old: toInt(paymentHealth.pending_old),
        unmatched: toInt(paymentHealth.unmatched),
        total_payments: toInt(paymentHealth.total_payments),
        successful_payments: toInt(paymentHealth.successful_payments),
        failed_payments: toInt(paymentHealth.failed_payments),
        pending_payments: toInt(paymentHealth.pending_payments),
      },
      recent_activity: recentActivityResult.rows.map((row) => ({
        type: row.type,
        message: row.message,
        timestamp: row.timestamp ? new Date(row.timestamp).toLocaleString() : 'Just now',
      })),
      inventory_intelligence: inventoryIntelligence,
      morning_summary: {
        new_orders: toInt(morning.new_orders),
        revenue: Math.round(toNumber(morning.revenue)),
        pending_dispatch: toInt(morning.pending_dispatch),
        failed_payments: toInt(morning.failed_payments),
        low_stock: inventoryIntelligence.low_stock + inventoryIntelligence.reorder_now,
      },
    };

    return handleSuccess(res, 200, 'Dashboard overview retrieved', data);
  } catch (err) {
    console.error('❌ Get dashboard overview error:', err.message);
    return handleError(res, 500, 'Failed to get dashboard overview', err);
  }
};

const getDashboardKPIs = async (req, res) => {
  try {
    const { filter = '30days' } = req.query;
    const { startDate, endDate } = getDateRange(filter);

    const revenueResult = await pool.query(
      'SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE created_at >= $1 AND created_at <= $2',
      [startDate, endDate]
    );

    const ordersResult = await pool.query(
      'SELECT COUNT(*) as total FROM orders WHERE created_at >= $1 AND created_at <= $2',
      [startDate, endDate]
    );

    const pendingPayments = await pool.query('SELECT COUNT(*) as total FROM payments WHERE status = $1', ['pending']);
    const failedPayments = await pool.query('SELECT COUNT(*) as total FROM payments WHERE status = $1', ['failed']);
    const paymentStats = await pool.query(
      `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE LOWER(status) IN ('completed', 'manually_resolved')) AS successful
      FROM payments
      WHERE created_at >= $1 AND created_at <= $2
      `,
      [startDate, endDate]
    );
    const lowStock = await pool.query('SELECT COUNT(*) as total FROM products WHERE current_stock <= 10 AND current_stock > 0');
    const outOfStock = await pool.query('SELECT COUNT(*) as total FROM products WHERE current_stock = 0');
    const awaitingDispatch = await pool.query('SELECT COUNT(*) as total FROM orders WHERE order_status = $1', ['pending']);
    const customersResult = await pool.query('SELECT COUNT(*) as total FROM customers WHERE created_at >= $1 AND created_at <= $2', [startDate, endDate]);

    // Get previous period for trend calculation
    const prevStartDate = new Date(startDate.getTime() - (endDate.getTime() - startDate.getTime()));
    const prevRevenueResult = await pool.query(
      'SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE created_at >= $1 AND created_at <= $2',
      [prevStartDate, startDate]
    );
    const prevOrdersResult = await pool.query(
      'SELECT COUNT(*) as total FROM orders WHERE created_at >= $1 AND created_at <= $2',
      [prevStartDate, startDate]
    );

    const currentRevenue = parseFloat(revenueResult.rows[0].total) || 0;
    const currentOrders = parseInt(ordersResult.rows[0].total) || 0;
    const previousRevenue = parseFloat(prevRevenueResult.rows[0].total) || 0;
    const previousOrders = parseInt(prevOrdersResult.rows[0].total) || 0;
    const totalPayments = parseInt(paymentStats.rows[0].total) || 0;
    const successfulPayments = parseInt(paymentStats.rows[0].successful) || 0;

    // Calculate trends
    const revenueTrend = previousRevenue > 0 ? ((currentRevenue - previousRevenue) / previousRevenue * 100).toFixed(1) : 0;
    const ordersTrend = previousOrders > 0 ? ((currentOrders - previousOrders) / previousOrders * 100).toFixed(1) : 0;

    const data = {
      revenue: currentRevenue,
      revenue_trend: parseFloat(revenueTrend),
      orders: currentOrders,
      orders_trend: parseFloat(ordersTrend),
      aov: currentOrders > 0 ? (currentRevenue / currentOrders).toFixed(2) : 0,
      pendingPayments: parseInt(pendingPayments.rows[0].total) || 0,
      pending_trend: 0,
      failedPayments: parseInt(failedPayments.rows[0].total) || 0,
      lowStock: parseInt(lowStock.rows[0].total) || 0,
      outOfStock: parseInt(outOfStock.rows[0].total) || 0,
      out_of_stock: parseInt(outOfStock.rows[0].total) || 0,
      awaitingDispatch: parseInt(awaitingDispatch.rows[0].total) || 0,
      newCustomers: parseInt(customersResult.rows[0].total) || 0,
      customer_trend: 0,
      payment_success_rate: totalPayments > 0 ? Math.round((successfulPayments / totalPayments) * 100) : 0,
    };

    console.log('✅ KPIs retrieved:', data);
    return handleSuccess(res, 200, 'KPIs retrieved', data);
  } catch (err) {
    console.error('❌ Get KPIs error:', err.message);
    return handleError(res, 500, 'Failed to get KPIs', err);
  }
};

const getSalesTrend = async (req, res) => {
  try {
    const { filter = '30days' } = req.query;
    const { startDate, endDate } = getDateRange(filter);

    const result = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as orders, COALESCE(SUM(total_amount), 0) as revenue
       FROM orders WHERE created_at >= $1 AND created_at <= $2 GROUP BY DATE(created_at) ORDER BY DATE(created_at) ASC`,
      [startDate, endDate]
    );

    const data = result.rows.map(row => ({
      date: new Date(row.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      orders: parseInt(row.orders),
      revenue: parseFloat(row.revenue),
    }));

    console.log('✅ Trend retrieved:', data.length, 'records');
    return handleSuccess(res, 200, 'Trend data retrieved', data);
  } catch (err) {
    console.error('❌ Get trend error:', err.message);
    return handleError(res, 500, 'Failed to get trend', err);
  }
};

const getAlerts = async (req, res) => {
  try {
    const alerts = [];

    const pendingOrders = await pool.query('SELECT COUNT(*) as total FROM orders WHERE order_status = $1', ['pending']);
    if (pendingOrders.rows[0].total > 0) {
      alerts.push({
        type: 'pending-orders',
        severity: 'warning',
        message: `${pendingOrders.rows[0].total} orders pending`,
        action: 'View',
        link: '/orders',
      });
    }

    const failedPayments = await pool.query('SELECT COUNT(*) as total FROM payments WHERE status = $1', ['failed']);
    if (failedPayments.rows[0].total > 0) {
      alerts.push({
        type: 'failed-payments',
        severity: 'error',
        message: `${failedPayments.rows[0].total} payments failed`,
        action: 'Check',
        link: '/payments',
      });
    }

    const outOfStock = await pool.query('SELECT COUNT(*) as total FROM products WHERE current_stock = 0');
    if (outOfStock.rows[0].total > 0) {
      alerts.push({
        type: 'out-of-stock',
        severity: 'error',
        message: `${outOfStock.rows[0].total} products out of stock`,
        action: 'Review',
        link: '/inventory',
      });
    }

    const lowStock = await pool.query('SELECT COUNT(*) as total FROM products WHERE current_stock <= 10 AND current_stock > 0');
    if (lowStock.rows[0].total > 0) {
      alerts.push({
        type: 'low-stock',
        severity: 'warning',
        message: `${lowStock.rows[0].total} products low stock`,
        action: 'Reorder',
        link: '/inventory',
      });
    }

    console.log('✅ Alerts retrieved:', alerts.length);
    return handleSuccess(res, 200, 'Alerts retrieved', alerts);
  } catch (err) {
    console.error('❌ Get alerts error:', err.message);
    return handleError(res, 500, 'Failed to get alerts', err);
  }
};

const getTopProducts = async (req, res) => {
  try {
    const { limit = 5, filter = '30days' } = req.query;
    const { startDate, endDate } = getDateRange(filter);

    const result = await pool.query(
      `SELECT p.id, p.name, SUM(CAST(oi.quantity AS INTEGER)) as units_sold,
              SUM(CAST(oi.quantity AS INTEGER) * CAST(oi.price_at_purchase AS DECIMAL)) as revenue
       FROM products p
       LEFT JOIN order_items oi ON p.id = oi.product_id
       LEFT JOIN orders o ON oi.order_id = o.id AND o.created_at >= $1 AND o.created_at <= $2
       GROUP BY p.id, p.name HAVING SUM(CAST(oi.quantity AS INTEGER)) > 0
       ORDER BY units_sold DESC LIMIT $3`,
      [startDate, endDate, limit]
    );

    console.log('✅ Top products retrieved:', result.rows.length);
    return handleSuccess(res, 200, 'Top products retrieved', result.rows);
  } catch (err) {
    console.error('❌ Get top products error:', err.message);
    return handleError(res, 500, 'Failed to get top products', err);
  }
};

const getLowStockProducts = async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const result = await pool.query(
      `SELECT id, name, current_stock, cost_price, retail_price FROM products
       WHERE current_stock <= 10 AND current_stock > 0 AND is_active = true
       ORDER BY current_stock ASC LIMIT $1`,
      [limit]
    );

    console.log('✅ Low stock retrieved:', result.rows.length);
    return handleSuccess(res, 200, 'Low stock products retrieved', result.rows);
  } catch (err) {
    console.error('❌ Get low stock error:', err.message);
    return handleError(res, 500, 'Failed to get low stock', err);
  }
};

const getRecentOrders = async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const result = await pool.query(
      `SELECT o.id, o.order_number, c.name as customer_name, o.total_amount, o.order_status as status, o.created_at
       FROM orders o LEFT JOIN customers c ON o.customer_id = c.id
       ORDER BY o.created_at DESC LIMIT $1`,
      [limit]
    );

    console.log('✅ Recent orders retrieved:', result.rows.length);
    return handleSuccess(res, 200, 'Recent orders retrieved', result.rows);
  } catch (err) {
    console.error('❌ Get recent orders error:', err.message);
    return handleError(res, 500, 'Failed to get recent orders', err);
  }
};

const getRevenueByRegion = async (req, res) => {
  try {
    const { filter = '30days' } = req.query;
    const { startDate, endDate } = getDateRange(filter);

    const result = await pool.query(
      `SELECT r.name, COALESCE(SUM(o.total_amount), 0) as revenue, COUNT(o.id) as orders
       FROM regions r
       LEFT JOIN locations l ON r.id = l.region_id
       LEFT JOIN customers c ON l.id = c.location_id
       LEFT JOIN orders o ON c.id = o.customer_id AND o.created_at >= $1 AND o.created_at <= $2
       GROUP BY r.id, r.name ORDER BY revenue DESC`,
      [startDate, endDate]
    );

    console.log('✅ Revenue by region retrieved:', result.rows.length);
    return handleSuccess(res, 200, 'Revenue by region retrieved', result.rows);
  } catch (err) {
    console.error('❌ Get revenue by region error:', err.message);
    return handleError(res, 500, 'Failed to get revenue by region', err);
  }
};

// ===== NEW ENDPOINTS =====

const getTopCustomers = async (req, res) => {
  try {
    const { limit = 5, filter = '30days' } = req.query;
    const { startDate, endDate } = getDateRange(filter);

    const result = await pool.query(
      `SELECT c.id, c.name, COUNT(o.id) as order_count,
              COALESCE(SUM(o.total_amount), 0) as total_spent
       FROM customers c
       LEFT JOIN orders o ON c.id = o.customer_id
              AND o.created_at >= $1 AND o.created_at <= $2
       WHERE c.is_active = true
       GROUP BY c.id, c.name
       HAVING COUNT(o.id) > 0
       ORDER BY total_spent DESC LIMIT $3`,
      [startDate, endDate, limit]
    );

    const data = result.rows.length > 0 ? result.rows : [];

    console.log('✅ Top customers retrieved:', data.length);
    return handleSuccess(res, 200, 'Top customers retrieved', data);
  } catch (err) {
    console.error('❌ Get top customers error:', err.message);
    return handleError(res, 500, 'Failed to get top customers', err);
  }
};

const getTopSalesReps = async (req, res) => {
  try {
    const { limit = 5, filter = '30days' } = req.query;
    const { startDate, endDate } = getDateRange(filter);

    const result = await pool.query(
      `SELECT sr.id, COALESCE(sr.full_name, sr.name) AS name, COUNT(DISTINCT o.id) as order_count,
              COALESCE(SUM(o.total_amount), 0) as revenue
       FROM orders o
       LEFT JOIN sales_reps sr ON sr.id = o.sales_rep_id
       WHERE o.created_at >= $1
         AND o.created_at <= $2
         AND LOWER(COALESCE(o.order_status, 'pending')) <> 'cancelled'
         AND o.sales_rep_id IS NOT NULL
       GROUP BY sr.id, COALESCE(sr.full_name, sr.name)
       HAVING COUNT(DISTINCT o.id) > 0
       ORDER BY revenue DESC LIMIT $3`,
      [startDate, endDate, limit]
    );

    const data = result.rows.length > 0 ? result.rows : [];

    console.log('✅ Top sales reps retrieved:', data.length);
    return handleSuccess(res, 200, 'Top sales reps retrieved', data);
  } catch (err) {
    console.error('❌ Get top sales reps error:', err.message);
    return handleError(res, 500, 'Failed to get top sales reps', err);
  }
};

const getPaymentHealth = async (req, res) => {
  try {
    const { filter = '30days' } = req.query;
    const { startDate, endDate } = getDateRange(filter);

    // Total payments in period
    const totalPayments = await pool.query(
      `SELECT COUNT(*) as total FROM payments
       WHERE created_at >= $1 AND created_at <= $2`,
      [startDate, endDate]
    );

    // Successful payments
    const successfulPayments = await pool.query(
      `SELECT COUNT(*) as total FROM payments
       WHERE status = 'completed' AND created_at >= $1 AND created_at <= $2`,
      [startDate, endDate]
    );

    // Failed payments
    const failedPayments = await pool.query(
      `SELECT COUNT(*) as total FROM payments
       WHERE status = 'failed' AND created_at >= $1 AND created_at <= $2`,
      [startDate, endDate]
    );

    // Pending payments
    const pendingPayments = await pool.query(
      `SELECT COUNT(*) as total FROM payments
       WHERE status = 'pending' AND created_at >= $1 AND created_at <= $2`,
      [startDate, endDate]
    );

    // Pending payments older than 10 minutes
    const oldPending = await pool.query(
      `SELECT COUNT(*) as total FROM payments
       WHERE status = 'pending' AND created_at <= NOW() - INTERVAL '10 minutes'`
    );

    // Unmatched payments
    const unmatched = await pool.query(
      `SELECT COUNT(*) as total FROM payments
       WHERE order_id IS NULL AND created_at >= $1 AND created_at <= $2`,
      [startDate, endDate]
    );

    const total = parseInt(totalPayments.rows[0].total) || 0;
    const successful = parseInt(successfulPayments.rows[0].total) || 0;
    const failed = parseInt(failedPayments.rows[0].total) || 0;

    const data = {
      success_rate: total > 0 ? Math.round((successful / total) * 100) : 0,
      failed_today: failed,
      pending_old: parseInt(oldPending.rows[0].total) || 0,
      unmatched: parseInt(unmatched.rows[0].total) || 0,
      total_payments: total,
      successful_payments: successful,
    };

    console.log('✅ Payment health retrieved:', data);
    return handleSuccess(res, 200, 'Payment health retrieved', data);
  } catch (err) {
    console.error('❌ Get payment health error:', err.message);
    return handleError(res, 500, 'Failed to get payment health', err);
  }
};

const getRecentActivity = async (req, res) => {
  try {
    const { limit = 15 } = req.query;

    const activities = [];

    // Recent orders
    const recentOrdersResult = await pool.query(
      `SELECT 'order' as type, 'Order #' || order_number || ' placed' as message,
              created_at as timestamp FROM orders ORDER BY created_at DESC LIMIT $1`,
      [Math.floor(limit / 3)]
    );

    // Successful payments
    const paymentsResult = await pool.query(
      `SELECT 'payment' as type, 'Payment confirmed' as message,
              created_at as timestamp FROM payments
       WHERE status = 'completed' ORDER BY created_at DESC LIMIT $1`,
      [Math.floor(limit / 3)]
    );

    // Failed payments
    const failedResult = await pool.query(
      `SELECT 'failed' as type, 'Payment failed' as message,
              created_at as timestamp FROM payments
       WHERE status = 'failed' ORDER BY created_at DESC LIMIT $1`,
      [Math.floor(limit / 3)]
    );

    activities.push(
      ...recentOrdersResult.rows.map(r => ({
        type: r.type,
        message: r.message,
        timestamp: new Date(r.timestamp).toLocaleTimeString(),
      })),
      ...paymentsResult.rows.map(r => ({
        type: r.type,
        message: r.message,
        timestamp: new Date(r.timestamp).toLocaleTimeString(),
      })),
      ...failedResult.rows.map(r => ({
        type: r.type,
        message: r.message,
        timestamp: new Date(r.timestamp).toLocaleTimeString(),
      }))
    );

    // Sort by timestamp descending and limit
    const sortedActivities = activities
      .sort((a, b) => {
        const timeA = new Date(`2000-01-01 ${a.timestamp}`);
        const timeB = new Date(`2000-01-01 ${b.timestamp}`);
        return timeB - timeA;
      })
      .slice(0, parseInt(limit));

    console.log('✅ Recent activity retrieved:', sortedActivities.length);
    return handleSuccess(res, 200, 'Recent activity retrieved', sortedActivities);
  } catch (err) {
    console.error('❌ Get recent activity error:', err.message);
    return handleError(res, 500, 'Failed to get recent activity', err);
  }
};

const getInventoryIntelligence = async (req, res) => {
  try {
    // Low stock items
    const lowStock = await pool.query(
      `SELECT COUNT(*) as total FROM products
       WHERE current_stock <= 10 AND current_stock > 0 AND is_active = true`
    );

    // Out of stock
    const outOfStock = await pool.query(
      `SELECT COUNT(*) as total FROM products
       WHERE current_stock = 0 AND is_active = true`
    );

    // Fast moving (high sales in last 7 days) - SIMPLIFIED
    const fastMoving = await pool.query(
      `SELECT COUNT(DISTINCT oi.product_id) as total 
       FROM order_items oi
       LEFT JOIN orders o ON oi.order_id = o.id
       WHERE o.created_at >= NOW() - INTERVAL '7 days'
       GROUP BY oi.product_id HAVING SUM(CAST(oi.quantity AS INTEGER)) > 5`
    );

    // Slow moving - SIMPLIFIED (products with no sales in 30 days)
    const slowMoving = await pool.query(
      `SELECT COUNT(*) as total FROM products p
       WHERE p.is_active = true 
       AND p.id NOT IN (
         SELECT DISTINCT oi.product_id FROM order_items oi
         LEFT JOIN orders o ON oi.order_id = o.id
         WHERE o.created_at >= NOW() - INTERVAL '30 days'
       )`
    );

    const data = {
      low_stock: parseInt(lowStock.rows[0].total) || 0,
      out_of_stock: parseInt(outOfStock.rows[0].total) || 0,
      fast_moving: fastMoving.rows.length || 0,
      slow_moving: parseInt(slowMoving.rows[0].total) || 0,
    };

    console.log('✅ Inventory intelligence retrieved:', data);
    return handleSuccess(res, 200, 'Inventory intelligence retrieved', data);
  } catch (err) {
    console.error('❌ Get inventory intelligence error:', err.message);
    return handleError(res, 500, 'Failed to get inventory intelligence', err);
  }
};

const getMorningSummary = async (req, res) => {
  try {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    // New orders today
    const ordersToday = await pool.query(
      `SELECT COUNT(*) as total, COALESCE(SUM(total_amount), 0) as revenue
       FROM orders WHERE created_at >= $1 AND created_at < $2`,
      [startOfDay, endOfDay]
    );

    // Pending dispatch
    const pendingDispatch = await pool.query(
      `SELECT COUNT(*) as total FROM orders
       WHERE order_status = 'pending' AND created_at >= $1 AND created_at < $2`,
      [startOfDay, endOfDay]
    );

    // Failed payments today
    const failedPayments = await pool.query(
      `SELECT COUNT(*) as total FROM payments
       WHERE status = 'failed' AND created_at >= $1 AND created_at < $2`,
      [startOfDay, endOfDay]
    );

    // Low stock items
    const lowStock = await pool.query(
      `SELECT COUNT(*) as total FROM products
       WHERE current_stock <= 10 AND current_stock > 0 AND is_active = true`
    );

    const data = {
      new_orders: parseInt(ordersToday.rows[0].total) || 0,
      revenue: parseFloat(ordersToday.rows[0].revenue) || 0,
      pending_dispatch: parseInt(pendingDispatch.rows[0].total) || 0,
      failed_payments: parseInt(failedPayments.rows[0].total) || 0,
      low_stock: parseInt(lowStock.rows[0].total) || 0,
    };

    console.log('✅ Morning summary retrieved:', data);
    return handleSuccess(res, 200, 'Morning summary retrieved', data);
  } catch (err) {
    console.error('❌ Get morning summary error:', err.message);
    return handleError(res, 500, 'Failed to get morning summary', err);
  }
};

module.exports = {
  getDashboardOverview,
  getDashboardKPIs,
  getSalesTrend,
  getAlerts,
  getTopProducts,
  getLowStockProducts,
  getRecentOrders,
  getRevenueByRegion,
  getTopCustomers,
  getTopSalesReps,
  getPaymentHealth,
  getRecentActivity,
  getInventoryIntelligence,
  getMorningSummary,
};
