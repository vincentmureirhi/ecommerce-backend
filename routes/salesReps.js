const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllSalesReps,
  getSalesRepById,
  saveSalesRepLocation,
  getLatestSalesRepLocation,
  getLatestSalesRepLocations,
  createSalesRep,
  updateSalesRep,
  deleteSalesRep
} = require('../controllers/salesRepController');

const router = express.Router();

// latest locations for all reps
router.get('/locations/latest', verifyToken, requireAdmin, getLatestSalesRepLocations);

// single sales rep CRUD/detail
router.get('/', getAllSalesReps);
router.get('/:id', getSalesRepById);

// location ping endpoints
router.get('/:id/location/latest', verifyToken, getLatestSalesRepLocation);
router.post('/:id/location', verifyToken, saveSalesRepLocation);

router.post('/', verifyToken, requireAdmin, createSalesRep);
router.put('/:id', verifyToken, requireAdmin, updateSalesRep);
router.delete('/:id', verifyToken, requireAdmin, deleteSalesRep);

module.exports = router;