'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const authController = require('../controllers/authController');

const router = express.Router();

// Public routes
router.post('/login', authController.login);
router.post('/verify-token', authController.verifyToken);

// SuperUser only routes
router.post('/admin/create', verifyToken, requireAdmin, authController.createAdmin);
router.get('/admin/all', verifyToken, requireAdmin, authController.getAllAdmins);
router.post('/admin/disable/:admin_id', verifyToken, requireAdmin, authController.disableAdmin);

module.exports = router;