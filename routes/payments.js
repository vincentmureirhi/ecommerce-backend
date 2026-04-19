'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');

const {
  createPayment,
  getPayments,
  getPaymentById,
  getPaymentSummary,
  initiateSTKPush,
  mpesaCallback,
  queryPaymentStatus,
  getPaymentForOrder,
  reconcilePayment,
} = require('../controllers/paymentController');

const router = express.Router();

// Public / storefront-facing M-Pesa endpoints
router.post('/stk-push', initiateSTKPush);
router.post('/callback', mpesaCallback);
router.get('/status/:checkoutRequestId', queryPaymentStatus);

// Admin routes
router.get('/summary', verifyToken, requireAdmin, getPaymentSummary);
router.get('/order/:order_id', verifyToken, requireAdmin, getPaymentForOrder);
router.get('/', verifyToken, requireAdmin, getPayments);
router.get('/:id', verifyToken, requireAdmin, getPaymentById);
router.post('/', verifyToken, requireAdmin, createPayment);
router.put('/:id/reconcile', verifyToken, requireAdmin, reconcilePayment);

module.exports = router;