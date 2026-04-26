'use strict';

const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllDepartments,
  getDepartmentById,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} = require('../controllers/departmentController');

const router = express.Router();

// Public read – admins and authenticated clients can list departments
router.get('/', getAllDepartments);
router.get('/:id', getDepartmentById);

// Admin-only mutations
router.post('/', verifyToken, requireAdmin, createDepartment);
router.put('/:id', verifyToken, requireAdmin, updateDepartment);
router.delete('/:id', verifyToken, requireAdmin, deleteDepartment);

module.exports = router;
