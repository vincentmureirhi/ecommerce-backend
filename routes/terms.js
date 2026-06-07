'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const { getTerms, updateTerms } = require('../controllers/termsController');

const router = express.Router();

router.get('/', getTerms);
router.put('/', verifyToken, requireAdmin, updateTerms);

module.exports = router;