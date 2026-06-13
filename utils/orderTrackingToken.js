'use strict';

const jwt = require('jsonwebtoken');

const TOKEN_PURPOSE = 'order_tracking';
const DEFAULT_TOKEN_TTL_DAYS = 180;

function envInt(name, defaultValue, options = {}) {
  const parsed = Number(process.env[name]);
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;

  if (!Number.isInteger(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

function getTrackingSecret() {
  const secret = process.env.ORDER_TRACKING_SECRET || process.env.JWT_SECRET;
  return typeof secret === 'string' && secret.trim() ? secret : null;
}

function getTokenTtlDays() {
  return envInt('ORDER_TRACKING_TOKEN_TTL_DAYS', DEFAULT_TOKEN_TTL_DAYS, {
    min: 1,
    max: 730,
  });
}

function getStorefrontBaseUrl() {
  return String(
    process.env.STOREFRONT_URL ||
      process.env.FRONTEND_URL ||
      'https://xpose-distributors.vercel.app'
  ).replace(/\/$/, '');
}

function buildOrderTrackingToken(order) {
  const secret = getTrackingSecret();
  if (!secret || !order?.id || !order?.order_number) return null;

  return jwt.sign(
    {
      purpose: TOKEN_PURPOSE,
      order_id: Number(order.id),
      order_number: String(order.order_number),
    },
    secret,
    {
      expiresIn: `${getTokenTtlDays()}d`,
      issuer: 'xpose-distributors',
      audience: 'order-tracking',
    }
  );
}

function verifyOrderTrackingToken(token) {
  const secret = getTrackingSecret();
  if (!secret || !token) return null;

  try {
    const decoded = jwt.verify(token, secret, {
      issuer: 'xpose-distributors',
      audience: 'order-tracking',
    });

    if (decoded?.purpose !== TOKEN_PURPOSE) return null;
    if (!decoded.order_id || !decoded.order_number) return null;

    return {
      order_id: Number(decoded.order_id),
      order_number: String(decoded.order_number),
      expires_at: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null,
    };
  } catch (_) {
    return null;
  }
}

function buildOrderTrackingUrl(order) {
  const token = buildOrderTrackingToken(order);
  if (!token) return null;

  return `${getStorefrontBaseUrl()}/track-order?t=${encodeURIComponent(token)}`;
}

function attachOrderTrackingLink(order) {
  if (!order || typeof order !== 'object') return order;

  const trackingToken = buildOrderTrackingToken(order);
  if (!trackingToken) return order;

  return {
    ...order,
    tracking_token: trackingToken,
    tracking_url: `${getStorefrontBaseUrl()}/track-order?t=${encodeURIComponent(trackingToken)}`,
    tracking_token_ttl_days: getTokenTtlDays(),
  };
}

module.exports = {
  attachOrderTrackingLink,
  buildOrderTrackingToken,
  buildOrderTrackingUrl,
  verifyOrderTrackingToken,
};
