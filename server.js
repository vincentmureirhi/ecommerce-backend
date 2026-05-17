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
const httpServer = http.createServer(app);

// ===== WEBSOCKET =====
initializeWebSocket(httpServer);
global.io = require('./websocket');

// =====================================================
// 🔥 FIXED CORS (PRODUCTION SAFE)
// =====================================================

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:8080',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080',

  // ✅ YOUR FRONTEND (VERCEL)
  'https://ecommerce-admin-seven-ashy.vercel.app',
];

const corsOptions = {
  origin: function (origin, callback) {
    // allow server-to-server / mobile apps
    if (!origin) return callback(null, true);

    // normalize origin (fixes trailing slash + weird browser formats)
    const cleanOrigin = origin.replace(/\/$/, '');

    if (allowedOrigins.includes(cleanOrigin)) {
      return callback(null, true);
    }

    console.log('❌ BLOCKED CORS:', origin);

    // ⚠️ IMPORTANT: don't crash server in production
    return callback(null, false);
  },

  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],

  allowedHeaders: ['Content-Type', 'Authorization'],

  credentials: true,
};

// Apply CORS globally
app.use(cors(corsOptions));

// IMPORTANT: preflight must ALWAYS succeed
app.options('*', cors(corsOptions));

// =====================================================
// BODY PARSING
// =====================================================

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// =====================================================
// STATIC FILES
// =====================================================

app.use('/images', express.static(path.join(__dirname, 'public/images')));

// =====================================================
// LOGGING
// =====================================================

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');

    res.json({
      success: true,
      db: true,
      timestamp: result.rows[0].now,
      env: process.env.NODE_ENV,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// =====================================================
// ROUTES
// =====================================================

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/admin-users', adminUsersRoutes);

// (keep the rest exactly as you already had)
app.use('/api/categories', categoryRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/regions', regionRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/customer-locations', customerLocationRoutes);
app.use('/api/sales-reps', salesRepRoutes);
app.use('/api/routes', routeRoutes);
app.use('/api/buying-customers', buyingCustomersRoutes);
app.use('/api/price-tiers', priceTierRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/suppliers', suppliersRouter);
app.use('/api/uploads', uploadRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/route-customer-portal', routeCustomerPortalRoutes);
app.use('/api/flash-sales', flashSalesRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/pricing-rules', pricingRulesRoutes);
app.use('/api/pricing-groups', pricingGroupsRoutes);

// =====================================================
// ERROR HANDLERS
// =====================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'development'
      ? err.message
      : 'Server error',
  });
});

// =====================================================
// BACKGROUND JOBS
// =====================================================

setInterval(async () => {
  try {
    await autoFailStalePendingPayments();
  } catch (err) {
    console.error('Payment job error:', err.message);
  }
}, 60000);

setInterval(async () => {
  try {
    await autoProgressOrders();
  } catch (err) {
    console.error('Order job error:', err.message);
  }
}, 300000);

// =====================================================
// START SERVER (CRITICAL FIX)
// =====================================================

const PORT = process.env.PORT;

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;