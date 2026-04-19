'use strict';

const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const { auditPriceChange } = require('../middleware/auditMiddleware');

// PUBLIC — GUEST CHECKOUT (no auth required)
router.post(
  '/guest-checkout',
  orderController.guestCheckout
);

// PUBLIC CUSTOMER CHECKOUT
router.post(
  '/',
  auditPriceChange,
  orderController.createOrder
);

// PUBLIC ORDER TRACKING
router.get(
  '/track',
  orderController.trackPublicOrder
);

// ADMIN ORDER CREATION
router.post(
  '/admin',
  verifyToken,
  auditPriceChange,
  orderController.createOrder
);

// ADMIN / STAFF ORDER MANAGEMENT
router.get(
  '/stats/all',
  verifyToken,
  requireAdmin,
  orderController.getOrderStatistics
);

router.get(
  '/sales-rep/:sales_rep_id',
  verifyToken,
  orderController.getOrdersBySalesRep
);

router.get(
  '/:id/print',
  verifyToken,
  orderController.getOrderForPrint
);

router.put(
  '/:id/status',
  verifyToken,
  requireAdmin,
  orderController.updateOrderStatus
);

router.get(
  '/:id',
  verifyToken,
  orderController.getOrderById
);

router.get(
  '/',
  verifyToken,
  orderController.getAllOrders
);

module.exports = router;