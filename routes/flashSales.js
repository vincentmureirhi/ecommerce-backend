'use strict';

const express = require('express');
const router = express.Router();
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllFlashSales,
  getActiveFlashSales,
  getActiveFlashSaleSummary,
  getPublicFlashSaleFeed,
  createFlashSale,
  updateFlashSale,
  deleteFlashSale,
  addProductsToFlashSale,
  removeProductFromFlashSale,
  getFlashSaleProducts,
  getActiveFlashSaleProducts,
} = require('../controllers/flashSaleController');

function noStoreFlashSaleCache(req, res, next) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  next();
}

// ── Public routes (no auth — used by customer storefront) ─────────────────────
// Returns active sales with products already embedded — one request, zero auth.
router.get('/active-summary', noStoreFlashSaleCache, getActiveFlashSaleSummary);
router.get('/active', noStoreFlashSaleCache, getActiveFlashSales);
router.get('/public', noStoreFlashSaleCache, getPublicFlashSaleFeed);
// Returns products of a specific active sale (public — only works while sale is live)
router.get('/:id/active-products', noStoreFlashSaleCache, getActiveFlashSaleProducts);

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