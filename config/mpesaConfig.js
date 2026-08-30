'use strict';

/**
 * Central M-Pesa configuration.
 * Secrets remain in the deployment environment; never commit credentials.
 */
function getMpesaConfig() {
  const environment = String(process.env.MPESA_ENVIRONMENT || process.env.DARAJA_ENV || 'sandbox').trim().toLowerCase();
  const isProduction = environment === 'production' || environment === 'live';
  const baseUrl = isProduction ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

  const callbackUrl = String(
    process.env.MPESA_CALLBACK_URL ||
    process.env.DARAJA_STK_CALLBACK_URL ||
    (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL.replace(/\\/$/, '')}/api/payments/callback` : '')
  ).trim();

  return {
    environment: isProduction ? 'production' : 'sandbox',
    baseUrl,
    consumerKey: process.env.MPESA_CONSUMER_KEY || process.env.DARAJA_CONSUMER_KEY || '',
    consumerSecret: process.env.MPESA_CONSUMER_SECRET || process.env.DARAJA_CONSUMER_SECRET || '',
    passkey: process.env.MPESA_PASSKEY || process.env.DARAJA_PASSKEY || '',
    shortcode: process.env.MPESA_BUSINESS_SHORTCODE || process.env.DARAJA_STK_BUSINESS_SHORTCODE || process.env.DARAJA_SHORTCODE || '',
    transactionType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerBuyGoodsOnline',
    callbackUrl,
  };
}

module.exports = { getMpesaConfig };
