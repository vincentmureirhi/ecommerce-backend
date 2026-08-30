'use strict';

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function environment() {
  return firstEnv('MPESA_ENVIRONMENT', 'DARAJA_ENV', 'DARAJA_ENVIRONMENT') || 'sandbox';
}

function isProduction() {
  const env = environment().toLowerCase();
  return env === 'production' || env === 'live' || env === 'prod';
}

function baseUrl() {
  return isProduction() ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

function callbackUrl() {
  const configured = firstEnv('MPESA_CALLBACK_URL', 'DARAJA_STK_CALLBACK_URL');
  if (configured) return configured;

  const renderUrl = firstEnv('RENDER_EXTERNAL_URL');
  if (renderUrl) return `${renderUrl.replace(/\/$/, '')}/api/payments/callback`;

  return '';
}

module.exports = {
  environment,
  isProduction,
  baseUrl,
  callbackUrl,
  consumerKey: () => firstEnv('MPESA_CONSUMER_KEY', 'DARAJA_CONSUMER_KEY'),
  consumerSecret: () => firstEnv('MPESA_CONSUMER_SECRET', 'DARAJA_CONSUMER_SECRET'),
  passkey: () => firstEnv('MPESA_PASSKEY', 'DARAJA_PASSKEY'),
  businessShortcode: () => firstEnv('MPESA_BUSINESS_SHORTCODE', 'DARAJA_STK_BUSINESS_SHORTCODE', 'DARAJA_SHORTCODE'),
  transactionType: () => firstEnv('MPESA_TRANSACTION_TYPE', 'DARAJA_TRANSACTION_TYPE') || 'CustomerBuyGoodsOnline',
  callbackUrl,
  realTillNumber: () => firstEnv('MPESA_REAL_TILL_NUMBER', 'DARAJA_REAL_TILL_NUMBER'),
};
