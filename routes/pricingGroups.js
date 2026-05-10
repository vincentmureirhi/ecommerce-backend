'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllPricingGroups,
  getPricingGroupById,
  createPricingGroup,
  updatePricingGroup,
  deletePricingGroup,
  getGroupProducts,
  addProductToGroup,
  updateGroupProduct,
  removeProductFromGroup,
} = require('../controllers/pricingGroupsController');

const router = express.Router();

// ── Pricing group CRUD ───────────────────────────────────────────────────────
router.get('/', verifyToken, getAllPricingGroups);
router.get('/:id', verifyToken, getPricingGroupById);
router.post('/', verifyToken, requireAdmin, createPricingGroup);
router.put('/:id', verifyToken, requireAdmin, updatePricingGroup);
router.delete('/:id', verifyToken, requireAdmin, deletePricingGroup);

// ── Group membership management ──────────────────────────────────────────────
router.get('/:id/products', verifyToken, getGroupProducts);
router.post('/:id/products', verifyToken, requireAdmin, addProductToGroup);
router.put('/:id/products/:product_id', verifyToken, requireAdmin, updateGroupProduct);
router.delete('/:id/products/:product_id', verifyToken, requireAdmin, removeProductFromGroup);

module.exports = router;
