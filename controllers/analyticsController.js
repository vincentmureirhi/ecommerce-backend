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
      payment_success_rate: 85, // Default value - will be calculated in payment health
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
      `SELECT sr.id, sr.name, COUNT(DISTINCT o.id) as order_count,
              COALESCE(SUM(o.total_amount), 0) as revenue
       FROM sales_reps sr
       LEFT JOIN routes rt ON sr.id = rt.sales_rep_id
       LEFT JOIN customers c ON rt.id = c.route_id
       LEFT JOIN orders o ON c.id = o.customer_id
              AND o.created_at >= $1 AND o.created_at <= $2
       WHERE sr.status = 'active'
       GROUP BY sr.id, sr.name
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