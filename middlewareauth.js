'use strict';

const jwt = require('jsonwebtoken');
const { handleError } = require('../utils/errorHandler');

function getTokenFromHeader(req) {
  const h = req.headers.authorization || '';
  const parts = h.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') return parts[1];
  return null;
}

function verifyToken(req, res, next) {
  try {
    const token = getTokenFromHeader(req);
    if (!token) return handleError(res, 401, 'Missing Authorization token');

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // attach to req.user
    req.user = {
      id: payload.id,
      role: payload.role,
      email: payload.email,
    };
    return next();
  } catch (err) {
    return handleError(res, 401, 'Invalid or expired token', err.message);
  }
}

function extractToken(req) {
  const h = req.headers.authorization || '';
  if (!h) return null;

  const parts = h.split(' ').filter(Boolean);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2 && /^Bearer$/i.test(parts[0])) return parts[1];
  return null;
}

module.exports = { extractToken };

function verifyAdmin(req, res, next) {
  return verifyToken(req, res, () => {
    if (req.user.role !== 'admin') {
      return handleError(res, 403, 'Admin access required');
    }
    return next();
  });
}

function verifySalesRep(req, res, next) {
  return verifyToken(req, res, () => {
    if (req.user.role !== 'sales_rep' && req.user.role !== 'admin') {
      return handleError(res, 403, 'Sales rep access required');
    }
    return next();
  });
}

module.exports = {
  verifyToken,
  verifyAdmin,
  verifySalesRep,
};