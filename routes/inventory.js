'use strict';

const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');

router.get('/', verifyToken, requireAdmin, inventoryController.getInventoryAnalytics);
router.get('/analytics', verifyToken, requireAdmin, inventoryController.getInventoryAnalytics);
router.put('/:id/reorder-level', verifyToken, requireAdmin, inventoryController.updateInventoryReorderLevel);

module.exports = router;