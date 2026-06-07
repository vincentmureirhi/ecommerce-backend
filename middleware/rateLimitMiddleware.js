'use strict';

const rateLimit = require('express-rate-limit');

const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
  message: {
    success: false,
    message: 'Too many API requests. Please retry shortly.',
  },
});

const routeCustomerUpsertRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many route-customer save requests. Please retry in a minute.',
  },
});

const salesRepLoginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many sales rep login attempts. Please retry later.',
  },
});

const salesRepRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many sales rep requests. Please retry in a minute.',
  },
});

const orderTrackingRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many order tracking attempts. Please retry in a minute.',
  },
});

module.exports = {
  apiRateLimiter,
  routeCustomerUpsertRateLimiter,
  salesRepLoginRateLimiter,
  salesRepRateLimiter,
  orderTrackingRateLimiter,
};