'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllPricingRules,
  getPricingRuleById,
  createPricingRule,
  updatePricingRule,
  deletePricingRule,
} = require('../controllers/pricingRulesController');

const router = express.Router();

// Read endpoints: authenticated users (admins + storefront consumers)
router.get('/', verifyToken, getAllPricingRules);
router.get('/:id', verifyToken, getPricingRuleById);

// Write endpoints: admin only
router.post('/', verifyToken, requireAdmin, createPricingRule);
router.put('/:id', verifyToken, requireAdmin, updatePricingRule);
router.delete('/:id', verifyToken, requireAdmin, deletePricingRule);

module.exports = router;
