'use strict';

const express = require('express');
const router = express.Router();

const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const { getAdminUsers } = require('../controllers/adminUserController');

router.get('/', verifyToken, requireAdmin, getAdminUsers);

module.exports = router;