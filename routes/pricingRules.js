'use strict';

const express = require('express');
const router = express.Router();
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  listPricingRules,
  getPricingRule,
  createPricingRule,
  updatePricingRule,
  deletePricingRule,
} = require('../controllers/pricingRulesController');

// Public: list all active pricing rules (used by storefront for rule context)
router.get('/', listPricingRules);

// Admin only: full CRUD
router.get('/:id', verifyToken, requireAdmin, getPricingRule);
router.post('/', verifyToken, requireAdmin, createPricingRule);
router.put('/:id', verifyToken, requireAdmin, updatePricingRule);
router.delete('/:id', verifyToken, requireAdmin, deletePricingRule);

module.exports = router;
