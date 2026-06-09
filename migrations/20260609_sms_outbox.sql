-- Queued SMS notifications for payment confirmations.
-- This prevents payment flows from depending directly on the SMS provider.

CREATE TABLE IF NOT EXISTS sms_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(80) NOT NULL,
  dedupe_key VARCHAR(180) NOT NULL UNIQUE,
  order_id INTEGER NULL REFERENCES orders(id) ON DELETE SET NULL,
  payment_id INTEGER NULL REFERENCES payments(id) ON DELETE SET NULL,
  phone VARCHAR(32) NOT NULL,
  message TEXT NOT NULL,
  provider VARCHAR(40) NOT NULL DEFAULT 'africastalking',
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'retry', 'sent', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ NULL,
  sent_at TIMESTAMPTZ NULL,
  provider_message_id TEXT NULL,
  provider_status TEXT NULL,
  provider_cost TEXT NULL,
  provider_response JSONB NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_outbox_status_next_attempt
  ON sms_outbox (status, next_attempt_at)
  WHERE status IN ('queued', 'retry');

CREATE INDEX IF NOT EXISTS idx_sms_outbox_order_id
  ON sms_outbox (order_id);

CREATE INDEX IF NOT EXISTS idx_sms_outbox_payment_id
  ON sms_outbox (payment_id);

CREATE INDEX IF NOT EXISTS idx_sms_outbox_sent_at
  ON sms_outbox (sent_at DESC)
  WHERE status = 'sent';
