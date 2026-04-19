const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  getOutOfStockProducts,
  getLowStockProducts
} = require('../controllers/productController');

const router = express.Router();

// Public routes
router.get('/', getAllProducts);
router.get('/stock/out-of-stock', getOutOfStockProducts);
router.get('/stock/low-stock', getLowStockProducts);
router.get('/:id', getProductById);

// Admin only routes
router.post('/', verifyToken, requireAdmin, createProduct);
router.put('/:id', verifyToken, requireAdmin, updateProduct);
router.delete('/:id', verifyToken, requireAdmin, deleteProduct);

module.exports = router;
