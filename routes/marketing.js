'use strict';

const express = require('express');
const controller = require('../controllers/marketingController');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

// Public marketing surface for storefront campaigns and coupon previews.
router.get('/campaigns/public', controller.listPublicCampaigns);
router.post('/coupons/validate', controller.validateCoupon);

// Admin marketing command center APIs.
router.get('/campaigns', verifyToken, requireAdmin, controller.listCampaigns);
router.post('/campaigns', verifyToken, requireAdmin, controller.createCampaign);
router.patch('/campaigns/:id', verifyToken, requireAdmin, controller.updateCampaign);

router.get('/coupons', verifyToken, requireAdmin, controller.listCoupons);
router.post('/coupons', verifyToken, requireAdmin, controller.createCoupon);
router.patch('/coupons/:id', verifyToken, requireAdmin, controller.updateCoupon);

module.exports = router;