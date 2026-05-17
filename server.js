'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');

require('dotenv').config();

// ===== DATABASE =====
const pool = require('./config/database');

// ===== WEBSOCKET =====
const { initializeWebSocket } = require('./websocket');

// ===== JOBS =====
const { autoFailStalePendingPayments } = require('./jobs/paymentAutoFail');
const { autoProgressOrders } = require('./jobs/orderProgressionJob');

// ===== ROUTES =====
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
const pricingRoutes = require('./routes/pricing');
const pricingRulesRoutes = require('./routes/pricingRules');
const pricingGroupsRoutes = require('./routes/pricingGroups');

const app = express();

// ===== CREATE HTTP SERVER =====
const httpServer = http.createServer(app);

// ===== INITIALIZE WEBSOCKET =====
initializeWebSocket(httpServer);

// Make websocket globally available
global.io = require('./websocket');

// =====================================================
// CORS CONFIG
// =====================================================

const allowedOrigins = [
  'http://localhost:8080',
  'http://localhost:5173',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:5173',

  // REPLACE THIS WITH YOUR REAL FRONTEND URL LATER
  'https://your-frontend.onrender.com',
];

const corsOptions = {
  origin(origin, callback) {
    // allow postman/mobile apps/server-side requests
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log('❌ BLOCKED CORS:', origin);

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },

  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],

  allowedHeaders: [
    'Content-Type',
    'Authorization',
  ],

  credentials: true,
};

// Apply CORS
app.use(cors(corsOptions));

// IMPORTANT: Handle preflight requests
app.options('*', cors(corsOptions));

// =====================================================
// BODY PARSERS
// =====================================================

app.use(express.json({ limit: '10mb' }));

app.use(express.urlencoded({
  extended: true,
  limit: '10mb',
}));

// =====================================================
// STATIC FILES
// =====================================================

app.use(
  '/images',
  express.static(path.join(__dirname, 'public/images'))
);

// =====================================================
// REQUEST LOGGER
// =====================================================

app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`
  );

  next();
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');

    return res.status(200).json({
      success: true,
      message: 'Server and database are running',
      timestamp: result.rows[0].now,
      environment: process.env.NODE_ENV,
    });

  } catch (err) {
    console.error('❌ HEALTH CHECK FAILED:', err.message);

    return res.status(500).json({
      success: false,
      message: 'Database connection failed',
      error: err.message,
    });
  }
});

// =====================================================
// API ROUTES
// =====================================================

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

app.use('/api/pricing', pricingRoutes);

app.use('/api/pricing-rules', pricingRulesRoutes);

app.use('/api/pricing-groups', pricingGroupsRoutes);

// =====================================================
// 404 HANDLER
// =====================================================

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path,
    method: req.method,
  });
});

// =====================================================
// GLOBAL ERROR HANDLER
// =====================================================

app.use((err, req, res, next) => {
  console.error('❌ GLOBAL ERROR:', err);

  return res.status(500).json({
    success: false,
    error: 'Internal server error',

    message:
      process.env.NODE_ENV === 'development'
        ? err.message
        : 'Something went wrong',
  });
});

// =====================================================
// BACKGROUND JOBS
// =====================================================

// Auto-fail stale payments every 60 seconds
setInterval(async () => {
  try {
    await autoFailStalePendingPayments();

  } catch (err) {
    console.error(
      '❌ Auto-fail payment job error:',
      err.message
    );
  }
}, 60000);

console.log(
  '✅ Payment auto-fail job started'
);

// Auto-progress orders every 5 minutes
setInterval(async () => {
  try {
    await autoProgressOrders();

  } catch (err) {
    console.error(
      '❌ Order progression job error:',
      err.message
    );
  }
}, 5 * 60 * 1000);

console.log(
  '✅ Order auto-progression job started'
);

// =====================================================
// START SERVER
// =====================================================

const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
  console.log('\n');

  console.log('┌──────────────────────────────────────┐');
  console.log('│   E-COMMERCE BACKEND STARTED        │');
  console.log('├──────────────────────────────────────┤');

  console.log(
    `│ Server: http://localhost:${PORT}`
      .padEnd(39) + '│'
  );

  console.log(
    `│ Environment: ${process.env.NODE_ENV}`
      .padEnd(39) + '│'
  );

  console.log('└──────────────────────────────────────┘');

  console.log('\n');
});

module.exports = app;