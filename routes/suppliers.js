const express = require("express");
const { verifyToken, requireAdmin } = require("../middleware/authMiddleware");
const {
  getAllSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} = require("../controllers/supplierController");

const router = express.Router();

// Admin-only (keep it strict)
router.get("/", verifyToken, requireAdmin, getAllSuppliers);
router.get("/:id", verifyToken, requireAdmin, getSupplierById);
router.post("/", verifyToken, requireAdmin, createSupplier);
router.put("/:id", verifyToken, requireAdmin, updateSupplier);
router.delete("/:id", verifyToken, requireAdmin, deleteSupplier);

module.exports = router;
