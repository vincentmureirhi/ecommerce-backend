'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const { getBuyingCustomers } = require('../controllers/buyingCustomerController');

const router = express.Router();

router.get('/', verifyToken, requireAdmin, getBuyingCustomers);

module.exports = router;