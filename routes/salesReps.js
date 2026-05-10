const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const { verifySalesRepToken } = require('../middleware/salesRepAuthMiddleware');
const { salesRepLoginRateLimiter, salesRepRateLimiter } = require('../middleware/rateLimitMiddleware');
const {
  getAllSalesReps,
  getSalesRepById,
  saveSalesRepLocation,
  saveOwnSalesRepLocation,
  getLatestSalesRepLocation,
  getLatestSalesRepLocations,
  loginSalesRep,
  getSalesRepSession,
  changeSalesRepPassword,
  createSalesRep,
  updateSalesRep,
  resetSalesRepPassword,
  deleteSalesRep
} = require('../controllers/salesRepController');

const router = express.Router();

// sales rep auth/session endpoints
router.post('/auth/login', salesRepLoginRateLimiter, loginSalesRep);
router.get('/auth/me', salesRepRateLimiter, verifySalesRepToken, getSalesRepSession);
router.post('/auth/change-password', salesRepRateLimiter, verifySalesRepToken, changeSalesRepPassword);
router.post('/me/location', salesRepRateLimiter, verifySalesRepToken, saveOwnSalesRepLocation);

// latest locations for all reps
router.get('/locations/latest', salesRepRateLimiter, verifyToken, requireAdmin, getLatestSalesRepLocations);

// single sales rep CRUD/detail
router.get('/', salesRepRateLimiter, verifyToken, requireAdmin, getAllSalesReps);
router.get('/:id', salesRepRateLimiter, verifyToken, requireAdmin, getSalesRepById);

// location ping endpoints
router.get('/:id/location/latest', salesRepRateLimiter, verifyToken, getLatestSalesRepLocation);
router.post('/:id/location', salesRepRateLimiter, verifyToken, saveSalesRepLocation);

router.post('/', salesRepRateLimiter, verifyToken, requireAdmin, createSalesRep);
router.put('/:id', salesRepRateLimiter, verifyToken, requireAdmin, updateSalesRep);
router.post('/:id/reset-password', salesRepRateLimiter, verifyToken, requireAdmin, resetSalesRepPassword);
router.delete('/:id', verifyToken, requireAdmin, deleteSalesRep);

module.exports = router;
