'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
require('dotenv').config();

// Import database
const pool = require('./config/database');

// Import WebSocket
const { initializeWebSocket } = require('./websocket');
const { autoFailStalePendingPayments } = require('./jobs/paymentAutoFail');
const { autoProgressOrders } = require('./jobs/orderProgressionJob');

// ===== IMPORT ROUTES =====
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const adminUsersRoutes = require('./routes/adminUsers');
const categoryRoutes = require('./routes/categories');
const departmentRoutes = require('./routes/departments');
const regionRoutes = require('./routes/regions');
const locationRoutes = require('./routes/locations');
const customerLocationRoutes = require('./routes/customerLocations');
const customerRoutes = require('./routes/customers');
const salesRepRoutes = require('./routes/salesReps');
const routeRoutes = require('./routes/routes');
const buyingCustomersRoutes = require('./routes/buyingCustomers');
const orderRoutes = require('./routes/orders');
const paymentRoutes = require('./routes/payments');
const priceTierRoutes = require('./routes/priceTiers');
const inventoryRoutes = require('./routes/inventory');
const suppliersRouter = require('./routes/suppliers');
const uploadRoutes = require('./routes/uploads');
const analyticsRoutes = require('./routes/analytics');
const routeCustomerPortalRoutes = require('./routes/routeCustomerPortal');
const flashSalesRoutes = require('./routes/flashSales');
const blogRoutes = require('./routes/blog');
const pricingRulesRoutes = require('./routes/pricingRules');

const app = express();

// Create HTTP server for WebSocket support
const httpServer = http.createServer(app);

// Initialize WebSocket
initializeWebSocket(httpServer);

// Make WebSocket available globally
global.io = require('./websocket');

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ✅ SERVE STATIC FILES (images)
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ===== HEALTH CHECK =====
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    return res.json({
      success: true,
      message: 'Server and database are running',
      timestamp: result.rows[0].now,
      env: process.env.NODE_ENV,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Database connection failed',
      error: err.message,
    });
  }
});

// ===== API ROUTES =====
app.use('/api/auth', authRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/regions', regionRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/customer-locations', customerLocationRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/sales-reps', salesRepRoutes);
app.use('/api/routes', routeRoutes);
app.use('/api/buying-customers', buyingCustomersRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/price-tiers', priceTierRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/suppliers', suppliersRouter);
app.use('/api/uploads', uploadRoutes);
app.use('/api/admin-users', adminUsersRoutes);
app.use('/api/route-customer-portal', routeCustomerPortalRoutes);
app.use('/api/flash-sales', flashSalesRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/pricing-rules', pricingRulesRoutes);

// ===== 404 =====
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path,
    method: req.method,
  });
});

// ===== GLOBAL ERROR =====
app.use((err, req, res, next) => {
  console.error('Global Error:', err);

  return res.status(500).json({
    success: false,
    error: 'Internal server error',
    message:
      process.env.NODE_ENV === 'development'
        ? err.message
        : 'Something went wrong',
  });
});

// ===== START BACKGROUND JOBS =====
// Auto-fail stale pending payments every 60 seconds
setInterval(async () => {
  try {
    await autoFailStalePendingPayments();
  } catch (err) {
    console.error('❌ Auto-fail job error:', err.message);
  }
}, 60000);

console.log('✅ Payment auto-fail job started (15-minute timeout)');

// Auto-progress stale orders every 5 minutes
// processing -> dispatched after 4 h without a manual status change
// dispatched  -> completed  after 8 h without a manual status change
setInterval(async () => {
  try {
    await autoProgressOrders();
  } catch (err) {
    console.error('❌ Order progression job error:', err.message);
  }
}, 5 * 60 * 1000);

console.log('✅ Order auto-progression job started (4 h processing→dispatched, 8 h dispatched→completed)');

// ===== START SERVER =====
const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
  console.log('\n');
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│  E-COMMERCE BACKEND SERVER STARTED          │');
  console.log('├─────────────────────────────────────────────┤');
  console.log(`│  Server: http://localhost:${PORT}`.padEnd(46) + '│');
  console.log(`│  WebSocket: ws://localhost:${PORT}`.padEnd(46) + '│');
  console.log(`│  Environment: ${process.env.NODE_ENV}`.padEnd(46) + '│');
  console.log(`│  Database: ${process.env.DB_NAME}`.padEnd(46) + '│');
  console.log('│                                             │');
  console.log('│  API Ready for Testing!                     │');
  console.log('└─────────────────────────────────────────────┘');
  console.log('\n');
});

module.exports = app;