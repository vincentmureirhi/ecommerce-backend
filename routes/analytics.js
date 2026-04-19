'use strict';

const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');
const {
  getDashboardKPIs,
  getSalesTrend,
  getAlerts,
  getTopProducts,
  getLowStockProducts,
  getRecentOrders,
  getRevenueByRegion,
  getTopCustomers,
  getTopSalesReps,
  getPaymentHealth,
  getRecentActivity,
  getInventoryIntelligence,
  getMorningSummary,
} = require('../controllers/analyticsController');

router.use(verifyToken);

// Existing routes
router.get('/kpis', getDashboardKPIs);
router.get('/trend', getSalesTrend);
router.get('/alerts', getAlerts);
router.get('/top-products', getTopProducts);
router.get('/low-stock', getLowStockProducts);
router.get('/recent-orders', getRecentOrders);
router.get('/revenue-by-region', getRevenueByRegion);

// NEW routes - these were missing!
router.get('/top-customers', getTopCustomers);
router.get('/top-sales-reps', getTopSalesReps);
router.get('/payment-health', getPaymentHealth);
router.get('/recent-activity', getRecentActivity);
router.get('/inventory-intelligence', getInventoryIntelligence);
router.get('/morning-summary', getMorningSummary);

module.exports = router;