'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getBuyingCustomers,
  getBuyingCustomerById,
  getBuyingCustomerOrders,
} = require('../controllers/buyingCustomerController');

const router = express.Router();

router.get('/', verifyToken, requireAdmin, getBuyingCustomers);
router.get('/:id/orders', verifyToken, requireAdmin, getBuyingCustomerOrders);
router.get('/:id', verifyToken, requireAdmin, getBuyingCustomerById);

module.exports = router;