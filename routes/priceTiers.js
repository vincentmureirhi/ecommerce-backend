const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  listTiersByProduct,
  createTier,
  updateTier,
  deleteTier,
} = require('../controllers/priceTierController');

const router = express.Router();

// all admin only
router.get('/product/:product_id', verifyToken, requireAdmin, listTiersByProduct);
router.post('/', verifyToken, requireAdmin, createTier);
router.put('/:id', verifyToken, requireAdmin, updateTier);
router.delete('/:id', verifyToken, requireAdmin, deleteTier);

module.exports = router;
