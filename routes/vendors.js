'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const { vendorApplicationRateLimiter } = require('../middleware/rateLimitMiddleware');
const controller = require('../controllers/vendorController');

const router = express.Router();

// Public marketplace onboarding
router.get('/plans/public', controller.listPublicVendorPlans);
router.post('/applications/public', vendorApplicationRateLimiter, controller.submitVendorApplication);

// Admin: applications
router.get('/applications', verifyToken, requireAdmin, controller.listVendorApplications);
router.get('/applications/:id', verifyToken, requireAdmin, controller.getVendorApplicationById);
router.post('/applications/:id/approve', verifyToken, requireAdmin, controller.approveVendorApplication);
router.post('/applications/:id/reject', verifyToken, requireAdmin, controller.rejectVendorApplication);

// Admin: vendors and commercial controls
router.get('/', verifyToken, requireAdmin, controller.listVendors);
router.get('/plans', verifyToken, requireAdmin, controller.listVendorPlans);
router.post('/plans', verifyToken, requireAdmin, controller.createVendorPlan);
router.put('/plans/:id', verifyToken, requireAdmin, controller.updateVendorPlan);
router.get('/:id', verifyToken, requireAdmin, controller.getVendorById);
router.patch('/:id', verifyToken, requireAdmin, controller.updateVendor);

module.exports = router;
