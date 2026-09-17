'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  paymentStkRateLimiter,
  paymentStatusRateLimiter,
} = require('../middleware/rateLimitMiddleware');
const legacyPaymentController = require('../controllers/paymentController');
const mpesaStkController = require('../controllers/mpesaStkController');
const mpesaConfirmationController = require('../controllers/mpesaConfirmationController');

const router = express.Router();

// Public / storefront-facing M-Pesa endpoints.
// STK initiation stays on the configurable controller; confirmation and
// recovery use the hardened confirmation controller with explicit SQL types.
router.post(
  '/stk-push',
  paymentStkRateLimiter,
  mpesaStkController.initiateSTKPush
);
router.post('/callback', mpesaConfirmationController.mpesaCallback);
router.get(
  '/status/:checkoutRequestId',
  paymentStatusRateLimiter,
  mpesaConfirmationController.queryPaymentStatus
);

// Admin routes keep the existing reconciliation/reporting implementation.
router.get('/summary', verifyToken, requireAdmin, legacyPaymentController.getPaymentSummary);
router.get('/order/:order_id', verifyToken, requireAdmin, legacyPaymentController.getPaymentForOrder);
router.get('/', verifyToken, requireAdmin, legacyPaymentController.getPayments);
router.get('/:id', verifyToken, requireAdmin, legacyPaymentController.getPaymentById);
router.post('/', verifyToken, requireAdmin, legacyPaymentController.createPayment);
router.put('/:id/reconcile', verifyToken, requireAdmin, legacyPaymentController.reconcilePayment);

module.exports = router;
