const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomersWithPurchases,
  getCustomerPurchaseHistory,
  getPurchaseStats
} = require('../controllers/customerController');

const router = express.Router();

// Public routes (customers can be viewed/created by anyone)
router.get('/purchases/stats', getPurchaseStats);
router.get('/purchases', getCustomersWithPurchases);
router.get('/', getAllCustomers);
router.get('/:id/purchases', getCustomerPurchaseHistory);
router.get('/:id', getCustomerById);
router.post('/', createCustomer);

// Admin only routes
router.put('/:id', verifyToken, requireAdmin, updateCustomer);
router.delete('/:id', verifyToken, requireAdmin, deleteCustomer);

module.exports = router;