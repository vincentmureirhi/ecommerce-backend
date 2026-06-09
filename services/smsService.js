'use strict';

const axios = require('axios');
const pool = require('../config/database');

const LIVE_SMS_ENDPOINT = 'https://api.africastalking.com/version1/messaging';
const SANDBOX_SMS_ENDPOINT = 'https://api.sandbox.africastalking.com/version1/messaging';

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function envInt(name, defaultValue) {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function normalizeSmsPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');

  if (digits.length === 9) return `+254${digits}`;
  if (digits.length === 10 && digits.startsWith('0')) return `+254${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('254')) return `+${digits}`;

  if (String(phone || '').trim().startsWith('+') && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }

  return null;
}

function getStorefrontBaseUrl() {
  return String(
    process.env.STOREFRONT_URL ||
      process.env.FRONTEND_URL ||
      'https://xpose-distributors.vercel.app'
  ).replace(/\/$/, '');
}

function buildTrackOrderUrl(orderNumber) {
  const base = getStorefrontBaseUrl();
  return `${base}/track-order?id=${encodeURIComponent(orderNumber || '')}`;
}

function compactSmsText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}

function buildPaymentConfirmedMessage(order) {
  const orderNumber = order.order_number || `#${order.id}`;
  const trackUrl = buildTrackOrderUrl(orderNumber);

  return compactSmsText(
    `XPOSE: Payment confirmed for order ${orderNumber}. Track: ${trackUrl}. Use the phone used when ordering. Thank you.`
  );
}

function getSmsConfig() {
  const smsEnv = String(process.env.AFRICASTALKING_ENV || 'live').trim().toLowerCase();
  const endpoint =
    process.env.AFRICASTALKING_SMS_URL ||
    (smsEnv === 'sandbox' ? SANDBOX_SMS_ENDPOINT : LIVE_SMS_ENDPOINT);

  return {
    enabled: envFlag('SMS_ENABLED', false),
    dryRun: envFlag('SMS_DRY_RUN', false),
    paymentConfirmationEnabled: envFlag('SMS_PAYMENT_CONFIRMATION_ENABLED', false),
    username: process.env.AFRICASTALKING_USERNAME,
    apiKey: process.env.AFRICASTALKING_API_KEY,
    senderId: process.env.AFRICASTALKING_SENDER_ID || null,
    endpoint,
    timeoutMs: envInt('SMS_HTTP_TIMEOUT_MS', 15000),
    maxAttempts: envInt('SMS_MAX_ATTEMPTS', 3) || 3,
    dailyLimit: envInt('SMS_DAILY_LIMIT', 20),
  };
}

async function enqueueSms(db, payload) {
  const config = getSmsConfig();
  const phone = normalizeSmsPhone(payload.phone);

  if (!config.paymentConfirmationEnabled) {
    return { queued: false, reason: 'sms_payment_confirmation_disabled' };
  }

  if (!phone) {
    return { queued: false, reason: 'invalid_phone' };
  }

  const result = await db.query(
    `
    INSERT INTO sms_outbox
    (
      event_type,
      dedupe_key,
      order_id,
      payment_id,
      phone,
      message,
      provider,
      status,
      max_attempts,
      next_attempt_at,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'africastalking', 'queued', $7, NOW(), NOW(), NOW())
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
    `,
    [
      payload.eventType,
      payload.dedupeKey,
      payload.orderId || null,
      payload.paymentId || null,
      phone,
      compactSmsText(payload.message),
      config.maxAttempts,
    ]
  );

  if (result.rows.length === 0) {
    return { queued: false, reason: 'duplicate' };
  }

  return { queued: true, id: result.rows[0].id };
}

async function enqueuePaymentConfirmedSms(db, order, options = {}) {
  if (!order || !order.id) {
    return { queued: false, reason: 'missing_order' };
  }

  return enqueueSms(db, {
    eventType: 'payment_confirmed',
    dedupeKey: `payment_confirmed:order:${order.id}`,
    orderId: order.id,
    paymentId: options.paymentId || null,
    phone: order.customer_phone || order.order_customer_phone,
    message: buildPaymentConfirmedMessage(order),
  });
}

async function countSmsSentToday() {
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM sms_outbox
    WHERE status = 'sent'
      AND sent_at >= CURRENT_DATE
      AND provider = 'africastalking'
    `
  );

  return Number(result.rows[0]?.count || 0);
}

async function sendViaAfricasTalking({ to, message }) {
  const config = getSmsConfig();

  if (!config.enabled) {
    return { skipped: true, reason: 'sms_disabled' };
  }

  if (config.dryRun) {
    return {
      dryRun: true,
      SMSMessageData: {
        Message: 'Dry run - SMS not sent',
        Recipients: [
          {
            number: to,
            status: 'Success',
            statusCode: 102,
            messageId: `dry_run_${Date.now()}`,
            cost: 'KES 0.0000',
          },
        ],
      },
    };
  }

  if (!config.username || !config.apiKey) {
    throw new Error('Africa\'s Talking SMS credentials are not configured');
  }

  const params = new URLSearchParams();
  params.append('username', config.username);
  params.append('to', to);
  params.append('message', message);
  if (config.senderId) params.append('from', config.senderId);

  const response = await axios.post(config.endpoint, params.toString(), {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      apiKey: config.apiKey,
    },
    timeout: config.timeoutMs,
  });

  return response.data;
}

function getFirstRecipient(providerResponse) {
  const recipients = providerResponse?.SMSMessageData?.Recipients;
  return Array.isArray(recipients) ? recipients[0] : null;
}

function isProviderSuccess(providerResponse) {
  const recipient = getFirstRecipient(providerResponse);
  if (!recipient) return false;

  const status = String(recipient.status || '').toLowerCase();
  const statusCode = Number(recipient.statusCode);
  return status === 'success' || statusCode === 101 || statusCode === 102;
}

async function claimQueuedSms(limit) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `
      SELECT *
      FROM sms_outbox
      WHERE status IN ('queued', 'retry')
        AND attempts < max_attempts
        AND next_attempt_at <= NOW()
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
      `,
      [limit]
    );

    const rows = result.rows;

    for (const row of rows) {
      await client.query(
        `
        UPDATE sms_outbox
        SET
          status = 'sending',
          attempts = attempts + 1,
          locked_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        `,
        [row.id]
      );
      row.attempts = Number(row.attempts || 0) + 1;
    }

    await client.query('COMMIT');
    return rows;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function markSmsSent(row, providerResponse) {
  const recipient = getFirstRecipient(providerResponse);

  await pool.query(
    `
    UPDATE sms_outbox
    SET
      status = 'sent',
      sent_at = NOW(),
      provider_message_id = $1,
      provider_status = $2,
      provider_cost = $3,
      provider_response = $4,
      last_error = NULL,
      updated_at = NOW()
    WHERE id = $5
    `,
    [
      recipient?.messageId || null,
      recipient?.status || null,
      recipient?.cost || null,
      JSON.stringify(providerResponse),
      row.id,
    ]
  );
}

async function markSmsFailedOrRetry(row, errorMessage, providerResponse = null) {
  const shouldRetry = row.attempts < row.max_attempts;
  const delayMinutes = Math.min(60, Math.max(2, row.attempts * 5));

  await pool.query(
    `
    UPDATE sms_outbox
    SET
      status = $1,
      next_attempt_at = CASE WHEN $2 THEN NOW() + ($3 || ' minutes')::interval ELSE next_attempt_at END,
      provider_response = COALESCE($4, provider_response),
      last_error = $5,
      updated_at = NOW()
    WHERE id = $6
    `,
    [
      shouldRetry ? 'retry' : 'failed',
      shouldRetry,
      delayMinutes,
      providerResponse ? JSON.stringify(providerResponse) : null,
      errorMessage,
      row.id,
    ]
  );
}

async function processSmsOutboxBatch(options = {}) {
  const config = getSmsConfig();
  const limit = Math.max(1, Math.min(Number(options.limit || 10), 50));

  if (!config.enabled) {
    return { processed: 0, sent: 0, failed: 0, skipped: true, reason: 'sms_disabled' };
  }

  const sentToday = await countSmsSentToday();
  if (!config.dryRun && config.dailyLimit > 0 && sentToday >= config.dailyLimit) {
    return {
      processed: 0,
      sent: 0,
      failed: 0,
      skipped: true,
      reason: 'daily_limit_reached',
      sentToday,
      dailyLimit: config.dailyLimit,
    };
  }

  const remainingToday =
    config.dryRun || config.dailyLimit <= 0
      ? limit
      : Math.max(0, Math.min(limit, config.dailyLimit - sentToday));

  if (remainingToday <= 0) {
    return { processed: 0, sent: 0, failed: 0, skipped: true, reason: 'daily_limit_reached' };
  }

  const rows = await claimQueuedSms(remainingToday);
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const providerResponse = await sendViaAfricasTalking({
        to: row.phone,
        message: row.message,
      });

      if (providerResponse?.skipped) {
        await markSmsFailedOrRetry(row, providerResponse.reason || 'SMS skipped');
        failed += 1;
        continue;
      }

      if (!isProviderSuccess(providerResponse)) {
        await markSmsFailedOrRetry(row, 'Africa\'s Talking did not accept the SMS', providerResponse);
        failed += 1;
        continue;
      }

      await markSmsSent(row, providerResponse);
      sent += 1;
    } catch (err) {
      await markSmsFailedOrRetry(row, err.message || 'SMS send failed');
      failed += 1;
    }
  }

  return { processed: rows.length, sent, failed };
}

module.exports = {
  buildPaymentConfirmedMessage,
  enqueuePaymentConfirmedSms,
  normalizeSmsPhone,
  processSmsOutboxBatch,
};
