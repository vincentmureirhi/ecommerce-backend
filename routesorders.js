const express = require('express');
const { verifyToken, verifySalesRep, verifyAdmin } = require('../middleware/auth');
const {
  createOrder,        // public: NO manual pricing allowed
  createOrderAdmin,   // admin: manual pricing allowed
  getAllOrders,
  getOrderById,
  updateOrderStatus,
  getOrderForPrint,
  getOrdersBySalesRep,
  getOrderStatistics
} = require('../controllers/orderController');

const router = express.Router();

/**
 * Create order (PUBLIC)
 * - Allows normal pricing only
 * - If any item is manual-quote => reject
 */
router.post('/', createOrder);

/**
 * Create order (ADMIN)
 * - Allows manual-quote items with manual_unit_price
 */
router.post('/admin', verifyAdmin, createOrderAdmin);

// Get all orders (admin only)
router.get('/', verifyAdmin, getAllOrders);

// Get order statistics (admin only)
router.get('/stats', verifyAdmin, getOrderStatistics);

// Get order for printing (admin only)
router.get('/:id/print', verifyAdmin, getOrderForPrint);

// Get orders by sales rep
router.get('/sales-rep/:sales_rep_id', verifySalesRep, getOrdersBySalesRep);

// Get single order
router.get('/:id', verifyToken, getOrderById);

// Update order status (admin only)
router.put('/:id/status', verifyAdmin, updateOrderStatus);

module.exports = router;