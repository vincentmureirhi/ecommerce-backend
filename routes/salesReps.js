const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const { verifySalesRepToken } = require('../middleware/salesRepAuthMiddleware');
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
router.post('/auth/login', loginSalesRep);
router.get('/auth/me', verifySalesRepToken, getSalesRepSession);
router.post('/auth/change-password', verifySalesRepToken, changeSalesRepPassword);
router.post('/me/location', verifySalesRepToken, saveOwnSalesRepLocation);

// latest locations for all reps
router.get('/locations/latest', verifyToken, requireAdmin, getLatestSalesRepLocations);

// single sales rep CRUD/detail
router.get('/', verifyToken, requireAdmin, getAllSalesReps);
router.get('/:id', verifyToken, requireAdmin, getSalesRepById);

// location ping endpoints
router.get('/:id/location/latest', verifyToken, getLatestSalesRepLocation);
router.post('/:id/location', verifyToken, saveSalesRepLocation);

router.post('/', verifyToken, requireAdmin, createSalesRep);
router.put('/:id', verifyToken, requireAdmin, updateSalesRep);
router.post('/:id/reset-password', verifyToken, requireAdmin, resetSalesRepPassword);
router.delete('/:id', verifyToken, requireAdmin, deleteSalesRep);

module.exports = router;
