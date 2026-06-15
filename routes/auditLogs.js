'use strict';

const express = require('express');
const router = express.Router();
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const { getAuditLogs } = require('../controllers/auditController');

router.use(verifyToken, requireAdmin);

router.get('/', getAuditLogs);

module.exports = router;
