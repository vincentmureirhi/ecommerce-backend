const express = require('express');
const {
  getAllLocations,
  getLocationById,
  createLocation,
  updateLocation,
  deleteLocation,
} = require('../controllers/locationController');

const router = express.Router();

router.get('/', getAllLocations);
router.get('/:id', getLocationById);
router.post('/', createLocation);
router.put('/:id', updateLocation);
router.delete('/:id', deleteLocation);

module.exports = router;