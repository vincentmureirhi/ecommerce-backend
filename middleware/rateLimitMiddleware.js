'use strict';

const rateLimit = require('express-rate-limit');

function envInt(name, defaultValue, options = {}) {
  const parsed = Number(process.env[name]);
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;

  if (!Number.isInteger(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

const apiRateLimiter = rateLimit({
  windowMs: envInt('API_RATE_LIMIT_WINDOW_MS', 60 * 1000, { min: 1000 }),
  max: envInt('API_RATE_LIMIT_MAX', 600, { min: 1 }),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
  message: {
    success: false,
    message: 'Too many API requests. Please retry shortly.',
  },
});

const paymentStkRateLimiter = rateLimit({
  windowMs: envInt('PAYMENT_STK_RATE_LIMIT_WINDOW_MS', 5 * 60 * 1000, { min: 1000 }),
  max: envInt('PAYMENT_STK_RATE_LIMIT_MAX', 5, { min: 1 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many M-Pesa payment attempts. Please wait a few minutes before trying again.',
  },
});

const paymentStatusRateLimiter = rateLimit({
  windowMs: envInt('PAYMENT_STATUS_RATE_LIMIT_WINDOW_MS', 60 * 1000, { min: 1000 }),
  max: envInt('PAYMENT_STATUS_RATE_LIMIT_MAX', 60, { min: 1 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many payment status requests. Please retry shortly.',
  },
});

const routeCustomerUpsertRateLimiter = rateLimit({
  windowMs: envInt('ROUTE_CUSTOMER_UPSERT_RATE_LIMIT_WINDOW_MS', 60 * 1000, { min: 1000 }),
  max: envInt('ROUTE_CUSTOMER_UPSERT_RATE_LIMIT_MAX', 30, { min: 1 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many route-customer save requests. Please retry in a minute.',
  },
});

const salesRepLoginRateLimiter = rateLimit({
  windowMs: envInt('SALES_REP_LOGIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, { min: 1000 }),
  max: envInt('SALES_REP_LOGIN_RATE_LIMIT_MAX', 20, { min: 1 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many sales rep login attempts. Please retry later.',
  },
});

const salesRepRateLimiter = rateLimit({
  windowMs: envInt('SALES_REP_RATE_LIMIT_WINDOW_MS', 60 * 1000, { min: 1000 }),
  max: envInt('SALES_REP_RATE_LIMIT_MAX', 60, { min: 1 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many sales rep requests. Please retry in a minute.',
  },
});

const orderTrackingRateLimiter = rateLimit({
  windowMs: envInt('ORDER_TRACKING_RATE_LIMIT_WINDOW_MS', 60 * 1000, { min: 1000 }),
  max: envInt('ORDER_TRACKING_RATE_LIMIT_MAX', 12, { min: 1 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many order tracking attempts. Please retry in a minute.',
  },
});

const vendorApplicationRateLimiter = rateLimit({
  windowMs: envInt('VENDOR_APPLICATION_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, { min: 1000 }),
  max: envInt('VENDOR_APPLICATION_RATE_LIMIT_MAX', 5, { min: 1 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many vendor applications from this device. Please retry later.',
  },
});

const vendorLoginRateLimiter = rateLimit({
  windowMs: envInt('VENDOR_LOGIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, { min: 1000 }),
  max: envInt('VENDOR_LOGIN_RATE_LIMIT_MAX', 20, { min: 1 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many vendor login attempts. Please retry later.',
  },
});

const vendorPortalRateLimiter = rateLimit({
  windowMs: envInt('VENDOR_PORTAL_RATE_LIMIT_WINDOW_MS', 60 * 1000, { min: 1000 }),
  max: envInt('VENDOR_PORTAL_RATE_LIMIT_MAX', 120, { min: 1 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many vendor portal requests. Please retry in a minute.',
  },
});

const vendorMessageRateLimiter = rateLimit({
  windowMs: envInt('VENDOR_MESSAGE_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, { min: 1000 }),
  max: envInt('VENDOR_MESSAGE_RATE_LIMIT_MAX', 8, { min: 1 }),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many vendor message requests from this device. Please retry later.',
  },
});

module.exports = {
  apiRateLimiter,
  paymentStkRateLimiter,
  paymentStatusRateLimiter,
  routeCustomerUpsertRateLimiter,
  salesRepLoginRateLimiter,
  salesRepRateLimiter,
  orderTrackingRateLimiter,
  vendorApplicationRateLimiter,
  vendorLoginRateLimiter,
  vendorPortalRateLimiter,
  vendorMessageRateLimiter,
};
