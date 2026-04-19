'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const { verifyRouteCustomerToken } = require('../middleware/routeCustomerAuthMiddleware');
const controller = require('../controllers/routeCustomerPortalController');
const applicationFileController = require('../controllers/routeCustomerApplicationFileController');
const handleRouteCustomerApplicationUpload = require('../middleware/routeCustomerApplicationUpload');

const router = express.Router();

// Public
router.post('/applications/public', controller.submitApplication);
router.post('/auth/login', controller.loginRouteCustomer);

// Route customer protected
router.post('/auth/change-password', verifyRouteCustomerToken, controller.changeRouteCustomerPassword);
router.get('/dashboard/me', verifyRouteCustomerToken, controller.getRouteCustomerDashboard);

// Admin protected - application workflow
router.get('/applications', verifyToken, requireAdmin, controller.getApplications);
router.get('/applications/:id/events', verifyToken, requireAdmin, controller.getApplicationEvents);
router.post('/applications/:id/approve', verifyToken, requireAdmin, controller.approveApplication);
router.post('/applications/:id/reject', verifyToken, requireAdmin, controller.rejectApplication);
router.post('/applications/:id/workflow', verifyToken, requireAdmin, controller.saveApplicationWorkflow);

// Admin protected - application files
router.get('/applications/:id/files', verifyToken, requireAdmin, applicationFileController.listApplicationFiles);
router.post(
  '/applications/:id/files',
  verifyToken,
  requireAdmin,
  handleRouteCustomerApplicationUpload,
  applicationFileController.uploadApplicationFile
);
router.get(
  '/applications/:id/files/:fileId/download',
  verifyToken,
  requireAdmin,
  applicationFileController.downloadApplicationFile
);
router.delete(
  '/applications/:id/files/:fileId',
  verifyToken,
  requireAdmin,
  applicationFileController.deleteApplicationFile
);

// Admin protected - existing/current route customers
router.get('/admin/customers', verifyToken, requireAdmin, controller.listRouteCustomers);
router.post('/admin/customers/:customerId/create-account', verifyToken, requireAdmin, controller.createAccountForExistingCustomer);
router.post('/admin/customers/:customerId/access', verifyToken, requireAdmin, controller.saveRouteCustomerAccess);

module.exports = router;