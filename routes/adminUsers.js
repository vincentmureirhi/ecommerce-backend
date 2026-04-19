'use strict';

const express = require('express');
const router = express.Router();

const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  updateAdminUserRole,
} = require('../controllers/adminUserController');

router.get('/', verifyToken, requireAdmin, getAdminUsers);
router.post('/', verifyToken, requireAdmin, createAdminUser);
router.put('/:id/role', verifyToken, requireAdmin, updateAdminUserRole);
router.put('/:id', verifyToken, requireAdmin, updateAdminUser);
router.delete('/:id', verifyToken, requireAdmin, deleteAdminUser);

module.exports = router;