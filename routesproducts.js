const express = require('express');
const { verifyAdmin } = require('../middleware/auth');
const {
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
} = require('../controllers/productController');

const router = express.Router();

router.get('/', verifyAdmin, listProducts);
router.get('/:id', verifyAdmin, getProductById);
router.post('/', verifyAdmin, createProduct);
router.put('/:id', verifyAdmin, updateProduct);
router.delete('/:id', verifyAdmin, deleteProduct);

module.exports = router;