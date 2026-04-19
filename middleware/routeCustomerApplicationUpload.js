'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'route-customer-applications');

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      const applicationId = String(req.params.id || '').trim();

      if (!/^\d+$/.test(applicationId)) {
        const err = new Error('Invalid application id');
        err.status = 400;
        return cb(err);
      }

      const dir = path.join(UPLOAD_ROOT, applicationId);
      ensureDirectory(dir);
      return cb(null, dir);
    } catch (err) {
      return cb(err);
    }
  },

  filename(req, file, cb) {
    try {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ext || '.bin';
      const unique = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`;
      return cb(null, unique);
    } catch (err) {
      return cb(err);
    }
  },
});

const uploader = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      const err = new Error('Only PDF, JPG, PNG, and WEBP files are allowed');
      err.status = 400;
      return cb(err);
    }

    return cb(null, true);
  },
});

function handleRouteCustomerApplicationUpload(req, res, next) {
  const middleware = uploader.single('file');

  middleware(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'File too large. Maximum allowed size is 10MB.',
        });
      }

      return res.status(400).json({
        success: false,
        message: err.message || 'Upload failed',
      });
    }

    return res.status(err.status || 400).json({
      success: false,
      message: err.message || 'Upload failed',
    });
  });
}

module.exports = handleRouteCustomerApplicationUpload;