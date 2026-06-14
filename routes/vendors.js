'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const { verifyVendorToken, requireVendorOwnerOrManager } = require('../middleware/vendorAuthMiddleware');
const {
  vendorApplicationRateLimiter,
  vendorLoginRateLimiter,
  vendorPortalRateLimiter,
} = require('../middleware/rateLimitMiddleware');
const controller = require('../controllers/vendorController');

const router = express.Router();

// Public marketplace onboarding
router.get('/plans/public', controller.listPublicVendorPlans);
router.post('/applications/public', vendorApplicationRateLimiter, controller.submitVendorApplication);
router.get('/public/stores', controller.listPublicVendorStores);
router.get('/public/stores/:slug', controller.getPublicVendorStoreBySlug);

// Vendor portal
router.post('/auth/login', vendorLoginRateLimiter, controller.loginVendor);
router.get('/me', vendorPortalRateLimiter, verifyVendorToken, controller.getVendorMe);
router.put('/me/password', vendorPortalRateLimiter, verifyVendorToken, controller.changeVendorPassword);
router.patch('/me/store', vendorPortalRateLimiter, verifyVendorToken, requireVendorOwnerOrManager, controller.updateMyVendorProfile);
router.get('/me/products', vendorPortalRateLimiter, verifyVendorToken, controller.listMyVendorProductSubmissions);
router.post('/me/products', vendorPortalRateLimiter, verifyVendorToken, requireVendorOwnerOrManager, controller.createMyVendorProductSubmission);
router.put('/me/products/:id', vendorPortalRateLimiter, verifyVendorToken, requireVendorOwnerOrManager, controller.updateMyVendorProductSubmission);
router.post('/me/products/:id/submit', vendorPortalRateLimiter, verifyVendorToken, requireVendorOwnerOrManager, controller.submitMyVendorProductSubmission);

// Admin: applications
router.get('/applications', verifyToken, requireAdmin, controller.listVendorApplications);
router.get('/applications/:id', verifyToken, requireAdmin, controller.getVendorApplicationById);
router.post('/applications/:id/approve', verifyToken, requireAdmin, controller.approveVendorApplication);
router.post('/applications/:id/reject', verifyToken, requireAdmin, controller.rejectVendorApplication);

// Admin: vendor product submissions
router.get('/product-submissions', verifyToken, requireAdmin, controller.listVendorProductSubmissions);
router.get('/product-submissions/:id', verifyToken, requireAdmin, controller.getVendorProductSubmissionById);
router.post('/product-submissions/:id/approve', verifyToken, requireAdmin, controller.approveVendorProductSubmission);
router.post('/product-submissions/:id/request-changes', verifyToken, requireAdmin, controller.requestVendorProductChanges);
router.post('/product-submissions/:id/reject', verifyToken, requireAdmin, controller.rejectVendorProductSubmission);

// Admin: vendors and commercial controls
router.get('/', verifyToken, requireAdmin, controller.listVendors);
router.get('/plans', verifyToken, requireAdmin, controller.listVendorPlans);
router.post('/plans', verifyToken, requireAdmin, controller.createVendorPlan);
router.put('/plans/:id', verifyToken, requireAdmin, controller.updateVendorPlan);
router.get('/:id', verifyToken, requireAdmin, controller.getVendorById);
router.patch('/:id', verifyToken, requireAdmin, controller.updateVendor);

module.exports = router;
