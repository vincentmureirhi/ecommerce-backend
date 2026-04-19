const express = require('express');
const {
  getAllRegions,
  getRegionById,
  getRegionDashboard,
  createRegion,
  updateRegion,
  deleteRegion,
} = require('../controllers/regionController');

const router = express.Router();

router.get('/', getAllRegions);
router.get('/:id/dashboard', getRegionDashboard);
router.get('/:id', getRegionById);
router.post('/', createRegion);
router.put('/:id', updateRegion);
router.delete('/:id', deleteRegion);

module.exports = router;