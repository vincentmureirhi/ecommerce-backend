'use strict';

const express = require('express');
const router = express.Router();
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllFlashSales,
  getActiveFlashSales,
  getPublicFlashSaleFeed,
  createFlashSale,
  updateFlashSale,
  deleteFlashSale,
  addProductsToFlashSale,
  removeProductFromFlashSale,
  getFlashSaleProducts,
  getActiveFlashSaleProducts,
} = require('../controllers/flashSaleController');

// ── Public routes (no auth — used by customer storefront) ─────────────────────
// Returns active sales with products already embedded — one request, zero auth.
router.get('/active', getActiveFlashSales);
router.get('/public', getPublicFlashSaleFeed);
// Returns products of a specific active sale (public — only works while sale is live)
router.get('/:id/active-products', getActiveFlashSaleProducts);

// ── Admin routes ──────────────────────────────────────────────────────────────
router.get('/', verifyToken, requireAdmin, getAllFlashSales);
router.post('/', verifyToken, requireAdmin, createFlashSale);
router.put('/:id', verifyToken, requireAdmin, updateFlashSale);
router.delete('/:id', verifyToken, requireAdmin, deleteFlashSale);

// Product assignment (admin only)
router.get('/:id/products', verifyToken, requireAdmin, getFlashSaleProducts);
router.post('/:id/products', verifyToken, requireAdmin, addProductsToFlashSale);
router.delete('/:id/products/:productId', verifyToken, requireAdmin, removeProductFromFlashSale);

module.exports = router;