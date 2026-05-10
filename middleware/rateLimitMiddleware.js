'use strict';

const rateLimit = require('express-rate-limit');

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

module.exports = {
  routeCustomerUpsertRateLimiter,
  salesRepLoginRateLimiter,
  salesRepRateLimiter,
};
