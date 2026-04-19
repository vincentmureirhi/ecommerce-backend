'use strict';

const express = require('express');
const router = express.Router();
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllFlashSales,
  getActiveFlashSales,
  createFlashSale,
  updateFlashSale,
  deleteFlashSale,
  addProductsToFlashSale,
  removeProductFromFlashSale,
  getFlashSaleProducts,
} = require('../controllers/flashSaleController');

// Public — active flash sales (used by customer storefront)
router.get('/active', getActiveFlashSales);

// Admin — full management
router.get('/', verifyToken, requireAdmin, getAllFlashSales);
router.post('/', verifyToken, requireAdmin, createFlashSale);
router.put('/:id', verifyToken, requireAdmin, updateFlashSale);
router.delete('/:id', verifyToken, requireAdmin, deleteFlashSale);

// Product assignment within a flash sale
router.get('/:id/products', verifyToken, requireAdmin, getFlashSaleProducts);
router.post('/:id/products', verifyToken, requireAdmin, addProductsToFlashSale);
router.delete('/:id/products/:productId', verifyToken, requireAdmin, removeProductFromFlashSale);

module.exports = router;
