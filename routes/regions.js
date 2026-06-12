const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
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
router.get('/:id/dashboard', verifyToken, requireAdmin, getRegionDashboard);
router.get('/:id', getRegionById);
router.post('/', verifyToken, requireAdmin, createRegion);
router.put('/:id', verifyToken, requireAdmin, updateRegion);
router.delete('/:id', verifyToken, requireAdmin, deleteRegion);

module.exports = router;
