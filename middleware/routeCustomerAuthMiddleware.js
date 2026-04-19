'use strict';

const jwt = require('jsonwebtoken');

const verifyRouteCustomerToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authorization header missing or invalid format',
      });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');

    if (decoded.token_type !== 'route_customer') {
      return res.status(403).json({
        success: false,
        message: 'Route customer token required',
      });
    }

    req.routeCustomerAuth = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired route customer token',
    });
  }
};

module.exports = {
  verifyRouteCustomerToken,
};