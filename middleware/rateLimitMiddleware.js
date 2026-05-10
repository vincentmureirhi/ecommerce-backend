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

module.exports = {
  routeCustomerUpsertRateLimiter,
};
