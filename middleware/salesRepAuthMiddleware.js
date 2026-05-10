'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

const verifySalesRepToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authorization header missing or invalid format',
      });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.token_type !== 'sales_rep' || decoded.role !== 'sales_rep' || !decoded.sales_rep_id) {
      return res.status(403).json({
        success: false,
        message: 'Sales rep token required',
      });
    }

    req.salesRepAuth = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired sales rep token',
    });
  }
};

module.exports = {
  verifySalesRepToken,
};
