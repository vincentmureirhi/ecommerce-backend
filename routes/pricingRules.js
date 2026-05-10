'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllPricingRules,
  getPricingRuleById,
  createPricingRule,
  updatePricingRule,
  deletePricingRule,
  getRuleTiers,
  createRuleTier,
  updateRuleTier,
  deleteRuleTier,
} = require('../controllers/pricingRulesController');

const router = express.Router();

// ── Pricing rule CRUD ────────────────────────────────────────────────────────
// Read endpoints: authenticated users (admins + storefront consumers)
router.get('/', verifyToken, getAllPricingRules);
router.get('/:id', verifyToken, getPricingRuleById);

// Write endpoints: admin only
router.post('/', verifyToken, requireAdmin, createPricingRule);
router.put('/:id', verifyToken, requireAdmin, updatePricingRule);
router.delete('/:id', verifyToken, requireAdmin, deletePricingRule);

// ── Rule-level tier management (pricing_rule_tiers) ──────────────────────────
// Used by SKU_TIERED and GROUP_TIERED rule types.
router.get('/:id/tiers', verifyToken, getRuleTiers);
router.post('/:id/tiers', verifyToken, requireAdmin, createRuleTier);
router.put('/:id/tiers/:tier_id', verifyToken, requireAdmin, updateRuleTier);
router.delete('/:id/tiers/:tier_id', verifyToken, requireAdmin, deleteRuleTier);

module.exports = router;
