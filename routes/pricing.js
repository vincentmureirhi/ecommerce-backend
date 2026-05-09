'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');
const {
  evaluatePricing,
  getPricingRuleSummary,
} = require('../controllers/pricingEvaluateController');

// Rate limiter for the public evaluate endpoint (prevents abuse / scraping)
const evaluateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
});

// Rate limiter for the authenticated rule-summary endpoint
const ruleSummaryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
});

// PUBLIC — evaluate cart pricing without placing an order
// Used by the customer frontend to resolve prices and check wholesale eligibility.
router.post('/evaluate', evaluateLimiter, evaluatePricing);

// AUTHENTICATED — human-readable summary for a specific pricing rule
router.get('/rule-summary/:id', ruleSummaryLimiter, verifyToken, getPricingRuleSummary);

module.exports = router;
