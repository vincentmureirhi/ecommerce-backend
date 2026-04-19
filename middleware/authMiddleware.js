'use strict';

const jwt = require('jsonwebtoken');

/**
 * Verify JWT token and attach user to request
 */
const verifyToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Authorization header missing or invalid format',
      });
    }

    const token = authHeader.substring(7); // Remove "Bearer " prefix
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
    });
  }
};

/**
 * Check if user is admin or superuser
 */
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
    });
  }

  if (!['admin', 'superuser'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required. This action is restricted to administrators only.',
    });
  }

  next();
};

/**
 * Check if user is admin or sales rep
 */
const requireAdminOrRep = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
    });
  }

  if (!['admin', 'sales_rep'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      error: 'Admin or Sales Rep access required',
    });
  }

  next();
};

module.exports = {
  verifyToken,
  requireAdmin,
  requireAdminOrRep,
};