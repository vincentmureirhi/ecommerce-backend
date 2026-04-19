const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory
} = require('../controllers/categoryController');

const router = express.Router();

// Public routes
router.get('/', getAllCategories);
router.get('/:id', getCategoryById);

// Admin only routes
router.post('/', verifyToken, requireAdmin, createCategory);
router.put('/:id', verifyToken, requireAdmin, updateCategory);
router.delete('/:id', verifyToken, requireAdmin, deleteCategory);

module.exports = router;
