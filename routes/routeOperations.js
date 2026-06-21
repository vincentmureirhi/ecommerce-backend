'use strict';

const express = require('express');
const router = express.Router();
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  listRouteCycles,
  createRouteCycle,
  updateRouteCycle,
  closeRouteCycle,
  getCurrentRouteCycle,
  getRouteTerminal,
  getRouteCandles,
  syncRouteCycleOrders,
} = require('../controllers/routeOperationsController');

router.use(verifyToken, requireAdmin);

router.get('/cycles/current', getCurrentRouteCycle);
router.get('/cycles', listRouteCycles);
router.post('/cycles', createRouteCycle);
router.put('/cycles/:id', updateRouteCycle);
router.post('/cycles/:id/close', closeRouteCycle);
router.post('/cycles/:id/sync-orders', syncRouteCycleOrders);
router.get('/cycles/:id/terminal', getRouteTerminal);
router.get('/cycles/:id/candles', getRouteCandles);

module.exports = router;
