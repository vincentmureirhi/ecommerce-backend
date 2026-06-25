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
const { processQueuedSmsNotifications } = require('./jobs/smsOutboxJob');
const { processQueuedOrderEvents } = require('./jobs/orderEventOutboxJob');
const { apiRateLimiter } = require('./middleware/rateLimitMiddleware');
const { requestContextMiddleware } = require('./middleware/requestContextMiddleware');
const { handleError } = require('./utils/errorHandler');

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
const vendorRoutes = require('./routes/vendors');
const uploadRoutes = require('./routes/uploads');
const analyticsRoutes = require('./routes/analytics');
const auditLogRoutes = require('./routes/auditLogs');
const routeOperationsRoutes = require('./routes/routeOperations');
const routeCustomerPortalRoutes = require('./routes/routeCustomerPortal');
const flashSalesRoutes = require('./routes/flashSales');
const blogRoutes = require('./routes/blog');
const termsRoutes = require('./routes/terms');
const pricingRoutes = require('./routes/pricing');
const pricingRulesRoutes = require('./routes/pricingRules');
const pricingGroupsRoutes = require('./routes/pricingGroups');
const storefrontRoutes = require('./routes/storefront');

const app = express();
const httpServer = http.createServer(app);

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return defaultValue;

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function envInt(name, defaultValue, options = {}) {
  const parsed = Number(process.env[name]);
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;

  if (!Number.isInteger(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

app.disable('x-powered-by');
app.set('trust proxy', envInt('TRUST_PROXY_HOPS', 1, { min: 0, max: 10 }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  next();
});

app.use(requestContextMiddleware);

// ===== WEBSOCKET =====
initializeWebSocket(httpServer);
global.io = require('./websocket');

// =====================================================
// 🔥 FIXED CORS (PRODUCTION SAFE)
// =====================================================

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:8080',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:8080',

  // ✅ YOUR FRONTEND (VERCEL)
  'https://ecommerce-admin-seven-ashy.vercel.app',
  'https://xpose-distributors.vercel.app',
];

for (const value of [
  process.env.CORS_ORIGINS,
  process.env.ADMIN_URL,
  process.env.STOREFRONT_URL,
  process.env.FRONTEND_URL,
]) {
  if (!value) continue;
  value
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
    .forEach((origin) => allowedOrigins.push(origin));
}

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
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const userId = req.user?.id ? ` user=${req.user.id}` : '';

    console.log(
      `[${new Date().toISOString()}] requestId=${req.requestId} ${req.method} ${req.originalUrl} status=${res.statusCode} durationMs=${durationMs.toFixed(1)}${userId}`
    );
  });

  next();
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'XPOSE Distributors API',
    status: 'online',
    health: '/api/health',
    requestId: req.requestId,
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'XPOSE Distributors API',
    status: 'online',
    health: '/api/health',
    requestId: req.requestId,
  });
});

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');

    res.json({
      success: true,
      db: true,
      timestamp: result.rows[0].now,
      pool: typeof pool.getPoolStats === 'function' ? pool.getPoolStats() : undefined,
      requestId: req.requestId,
    });

  } catch (err) {
    return handleError(res, 500, 'Health check failed', err);
  }
});

// =====================================================
// ROUTES
// =====================================================

app.use('/api', apiRateLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/v1/storefront', storefrontRoutes);
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
app.use('/api/vendors', vendorRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/audit-logs', auditLogRoutes);
app.use('/api/route-operations', routeOperationsRoutes);
app.use('/api/route-customer-portal', routeCustomerPortalRoutes);
app.use('/api/flash-sales', flashSalesRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/terms', termsRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/pricing-rules', pricingRulesRoutes);
app.use('/api/pricing-groups', pricingGroupsRoutes);

// =====================================================
// ERROR HANDLERS
// =====================================================

app.use((req, res) => {
  return handleError(res, 404, 'Route not found');
});

app.use((err, req, res, next) => {
  console.error(`[UNHANDLED] requestId=${req.requestId || '-'} ${err.message}`, err);

  const statusCode = err.statusCode || err.status || 500;
  const message = statusCode >= 500 && process.env.NODE_ENV !== 'development'
    ? 'Server error'
    : (err.message || 'Server error');

  return handleError(res, statusCode, message, err);
});

// =====================================================
// BACKGROUND JOBS
// =====================================================

function scheduleRepeatingJob(name, job, intervalMs) {
  const safeIntervalMs = Math.max(Number(intervalMs) || 60000, 5000);

  const timer = setInterval(async () => {
    try {
      await job();
    } catch (err) {
      console.error(`${name} job error:`, err.message);
    }
  }, safeIntervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return timer;
}

if (envFlag('RUN_BACKGROUND_JOBS', true)) {
  scheduleRepeatingJob(
    'Payment',
    async () => autoFailStalePendingPayments(),
    envInt('PAYMENT_AUTO_FAIL_JOB_INTERVAL_MS', 60000, { min: 5000 })
  );

  scheduleRepeatingJob(
    'Order progression',
    async () => autoProgressOrders(),
    envInt('ORDER_PROGRESSION_JOB_INTERVAL_MS', 300000, { min: 60000 })
  );

  scheduleRepeatingJob(
    'SMS',
    async () => {
      const result = await processQueuedSmsNotifications();
      if (result.processed || result.sent || result.failed) {
        console.log('SMS job result:', result);
      }
    },
    envInt('SMS_JOB_INTERVAL_MS', 60000, { min: 5000 })
  );

  scheduleRepeatingJob(
    'Order event outbox',
    async () => {
      const result = await processQueuedOrderEvents();
      if (result.processed || result.retried || result.failed) {
        console.log('Order event outbox result:', result);
      }
    },
    envInt('ORDER_EVENT_OUTBOX_INTERVAL_MS', 10000, { min: 5000 })
  );
} else {
  console.log('Background jobs are disabled for this instance');
}

// =====================================================
// START SERVER (CRITICAL FIX)
// =====================================================

const PORT = process.env.PORT;

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
