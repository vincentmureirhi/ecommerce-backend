const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllLocations,
  getLocationById,
  createLocation,
  updateLocation,
  deleteLocation
} = require('../controllers/customerLocationController');

const router = express.Router();

// Public routes
router.get('/', getAllLocations);
router.get('/:id', getLocationById);

// Admin only routes
router.post('/', verifyToken, requireAdmin, createLocation);
router.put('/:id', verifyToken, requireAdmin, updateLocation);
router.delete('/:id', verifyToken, requireAdmin, deleteLocation);

module.exports = router;
