'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  paymentStkRateLimiter,
  paymentStatusRateLimiter,
} = require('../middleware/rateLimitMiddleware');
const { preventDuplicateActiveStk } = require('../middleware/paymentGuards');
const legacyPaymentController = require('../controllers/paymentController');
const mpesaStkController = require('../controllers/mpesaStkController');

const router = express.Router();

// Public / storefront-facing M-Pesa endpoints.
// STK/callback are intentionally handled by the dedicated configurable controller.
router.post(
  '/stk-push',
  paymentStkRateLimiter,
  preventDuplicateActiveStk,
  mpesaStkController.initiateSTKPush
);
router.post('/callback', mpesaStkController.mpesaCallback);
router.get('/status/:checkoutRequestId', paymentStatusRateLimiter, mpesaStkController.queryPaymentStatus);

// Admin routes keep the existing reconciliation/reporting implementation.
router.get('/summary', verifyToken, requireAdmin, legacyPaymentController.getPaymentSummary);
router.get('/order/:order_id', verifyToken, requireAdmin, legacyPaymentController.getPaymentForOrder);
router.get('/', verifyToken, requireAdmin, legacyPaymentController.getPayments);
router.get('/:id', verifyToken, requireAdmin, legacyPaymentController.getPaymentById);
router.post('/', verifyToken, requireAdmin, legacyPaymentController.createPayment);
router.put('/:id/reconcile', verifyToken, requireAdmin, legacyPaymentController.reconcilePayment);

module.exports = router;
