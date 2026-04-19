const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllRoutes,
  getRouteById,
  createRoute,
  updateRoute,
  deleteRoute
} = require('../controllers/routeController');

const router = express.Router();

router.get('/', getAllRoutes);
router.get('/:id', getRouteById);
router.post('/', verifyToken, requireAdmin, createRoute);
router.put('/:id', verifyToken, requireAdmin, updateRoute);
router.delete('/:id', verifyToken, requireAdmin, deleteRoute);

module.exports = router;