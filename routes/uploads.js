const express = require('express');
const multer = require('multer');
const path = require('path');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const { handleSuccess, handleError } = require('../utils/errorHandler');

const router = express.Router();

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../public/images'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Upload endpoint
router.post('/', verifyToken, requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) {
    return handleError(res, 400, 'No image provided');
  }

  const imageUrl = `/images/${req.file.filename}`;
  return handleSuccess(res, 200, 'Image uploaded', { image_url: imageUrl });
});

module.exports = router;