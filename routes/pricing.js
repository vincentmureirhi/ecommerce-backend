'use strict';

const express = require('express');
const { evaluatePricing } = require('../controllers/pricingEvaluateController');

const router = express.Router();

router.post('/evaluate', evaluatePricing);

module.exports = router;
