const express = require("express");
const { verifyAdmin } = require("../middleware/auth");
const {
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} = require("../controllers/departmentController");

const router = express.Router();

// Admin-only (keep it strict)
router.get("/", verifyAdmin, listDepartments);
router.post("/", verifyAdmin, createDepartment);
router.put("/:id", verifyAdmin, updateDepartment);
router.delete("/:id", verifyAdmin, deleteDepartment);

module.exports = router;