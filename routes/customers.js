'use strict';

const express = require('express');
const router = express.Router();

const {
  getAllCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerSummary,
  getCustomerOrders,
  getCustomerPayments,
} = require('../controllers/customerController');

const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');

router.get('/', verifyToken, getAllCustomers);

// more specific routes first
router.get('/:id/summary', verifyToken, getCustomerSummary);
router.get('/:id/orders', verifyToken, getCustomerOrders);
router.get('/:id/payments', verifyToken, getCustomerPayments);

router.get('/:id', verifyToken, getCustomerById);

router.post('/', verifyToken, requireAdmin, createCustomer);
router.put('/:id', verifyToken, requireAdmin, updateCustomer);
router.delete('/:id', verifyToken, requireAdmin, deleteCustomer);

module.exports = router;