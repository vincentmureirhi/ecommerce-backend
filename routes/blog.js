'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');
const {
  getAllBlogPosts,
  getBlogPost,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
} = require('../controllers/blogController');

const router = express.Router();

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  return typeof secret === 'string' && secret.trim() ? secret : null;
}

// Optional auth: attach req.user if a valid token is present, but never block the request
const optionalAuth = (req, res, next) => {
  try {
    const jwtSecret = getJwtSecret();
    const authHeader = req.headers.authorization;

    if (jwtSecret && authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      req.user = jwt.verify(token, jwtSecret);
    } else {
      req.user = null;
    }
  } catch {
    req.user = null;
  }
  next();
};

// Public routes — storefront consumption (admin can see all posts when authenticated)
router.get('/', optionalAuth, getAllBlogPosts);
router.get('/:idOrSlug', optionalAuth, getBlogPost);

// Admin-only routes
router.post('/', verifyToken, requireAdmin, createBlogPost);
router.put('/:id', verifyToken, requireAdmin, updateBlogPost);
router.delete('/:id', verifyToken, requireAdmin, deleteBlogPost);

module.exports = router;
