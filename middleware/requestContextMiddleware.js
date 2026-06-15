'use strict';

const { v4: uuidv4 } = require('uuid');

function normalizeRequestId(value) {
  if (!value) return uuidv4();

  const rawValue = Array.isArray(value) ? value[0] : value;
  const candidate = String(rawValue || '').trim();

  if (!candidate) return uuidv4();

  const cleaned = candidate.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 80);
  return cleaned || uuidv4();
}

function requestContextMiddleware(req, res, next) {
  const requestId = normalizeRequestId(
    req.headers['x-request-id'] || req.headers['x-correlation-id']
  );

  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  next();
}

module.exports = {
  requestContextMiddleware,
  normalizeRequestId,
};
