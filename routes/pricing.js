'use strict';

const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');
const {
  evaluatePricing,
  getPricingRuleSummary,
} = require('../controllers/pricingEvaluateController');

// PUBLIC — evaluate cart pricing without placing an order
// Used by the customer frontend to resolve prices and check wholesale eligibility.
router.post('/evaluate', evaluatePricing);

// AUTHENTICATED — human-readable summary for a specific pricing rule
router.get('/rule-summary/:id', verifyToken, getPricingRuleSummary);

module.exports = router;
