'use strict';

const pool = require('../config/database');
const { enqueueMarketingSms } = require('../services/smsService');

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function envInt(name, fallback, min = 1, max = 500) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function campaignSmsText(campaign) {
  const message = String(campaign.sms_message || campaign.hero_subtitle || campaign.description || '').trim();
  const cta = String(campaign.cta_url || '').trim();
  return `XPOSE: ${message}${cta ? ` ${cta}` : ''}`.replace(/\s+/g, ' ').trim().slice(0, 320);
}

async function syncCampaignStatuses(db) {
  const activated = await db.query(
    `
    UPDATE marketing_campaigns
    SET status = 'active', activated_at = COALESCE(activated_at, NOW()), updated_at = NOW()
    WHERE status = 'draft'
      AND auto_activate = TRUE
      AND starts_at IS NOT NULL
      AND starts_at <= NOW()
      AND (ends_at IS NULL OR ends_at > NOW())
    RETURNING id
    `
  );

  const ended = await db.query(
    `
    UPDATE marketing_campaigns
    SET status = 'ended', ended_at = COALESCE(ended_at, NOW()), updated_at = NOW()
    WHERE status = 'active'
      AND auto_expire = TRUE
      AND ends_at IS NOT NULL
      AND ends_at <= NOW()
    RETURNING id
    `
  );

  const expiredCoupons = await db.query(
    `
    UPDATE coupons
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'active'
      AND ends_at IS NOT NULL
      AND ends_at <= NOW()
    RETURNING id
    `
  );

  return {
    activated: activated.rowCount || 0,
    ended: ended.rowCount || 0,
    expiredCoupons: expiredCoupons.rowCount || 0,
  };
}

async function queueCampaignSms(db) {
  if (!envFlag('SMS_MARKETING_ENABLED', false)) {
    return { campaigns: 0, queued: 0, skipped: 0, disabled: true };
  }

  const campaignLimit = envInt('MARKETING_SMS_CAMPAIGNS_PER_RUN', 2, 1, 10);
  const recipientLimit = envInt('MARKETING_SMS_RECIPIENTS_PER_RUN', 20, 1, 100);
  const campaigns = await db.query(
    `
    SELECT *
    FROM marketing_campaigns
    WHERE status = 'active'
      AND sms_enabled = TRUE
      AND sms_queued_at IS NULL
      AND (starts_at IS NULL OR starts_at <= NOW())
      AND (ends_at IS NULL OR ends_at > NOW())
    ORDER BY priority DESC, created_at ASC
    LIMIT $1
    `,
    [campaignLimit]
  );

  let queued = 0;
  let skipped = 0;

  for (const campaign of campaigns.rows) {
    const message = campaignSmsText(campaign);
    if (!message || message === 'XPOSE:') {
      await db.query(
        `UPDATE marketing_campaigns SET sms_queued_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [campaign.id]
      );
      continue;
    }

    const recipients = await db.query(
      `
      SELECT c.id, c.phone
      FROM customers c
      LEFT JOIN locations l ON l.id = c.location_id
      WHERE c.marketing_sms_opt_in = TRUE
        AND COALESCE(c.is_active, TRUE) = TRUE
        AND NULLIF(TRIM(COALESCE(c.phone, '')), '') IS NOT NULL
        AND (
          $2 = 'all'
          OR $2 = 'campaign_scope' AND ($3 = 'all' OR c.customer_type = $3)
          OR $2 IN ('normal', 'route') AND c.customer_type = $2
        )
        AND (
          NOT EXISTS (SELECT 1 FROM marketing_campaign_regions mcr WHERE mcr.campaign_id = $1)
          OR l.region_id IN (SELECT region_id FROM marketing_campaign_regions WHERE campaign_id = $1)
        )
        AND NOT EXISTS (
          SELECT 1 FROM marketing_campaign_sms_recipients msr
          WHERE msr.campaign_id = $1 AND msr.customer_id = c.id
        )
      ORDER BY c.id
      LIMIT $4
      `,
      [campaign.id, campaign.sms_audience || 'campaign_scope', campaign.customer_scope || 'all', recipientLimit]
    );

    for (const recipient of recipients.rows) {
      const result = await enqueueMarketingSms(db, {
        campaignId: campaign.id,
        customerId: recipient.id,
        phone: recipient.phone,
        message,
      });
      const status = result.queued ? 'queued' : 'skipped';
      if (result.queued) queued += 1;
      else skipped += 1;
      await db.query(
        `
        INSERT INTO marketing_campaign_sms_recipients
          (campaign_id, customer_id, phone, status, sms_outbox_id, last_error, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        ON CONFLICT (campaign_id, customer_id) DO NOTHING
        `,
        [campaign.id, recipient.id, recipient.phone, status, result.id || null, result.reason || null]
      );
    }

    const remaining = await db.query(
      `
      SELECT COUNT(*)::int AS count
      FROM customers c
      LEFT JOIN locations l ON l.id = c.location_id
      WHERE c.marketing_sms_opt_in = TRUE
        AND COALESCE(c.is_active, TRUE) = TRUE
        AND NULLIF(TRIM(COALESCE(c.phone, '')), '') IS NOT NULL
        AND (
          $2 = 'all'
          OR $2 = 'campaign_scope' AND ($3 = 'all' OR c.customer_type = $3)
          OR $2 IN ('normal', 'route') AND c.customer_type = $2
        )
        AND (
          NOT EXISTS (SELECT 1 FROM marketing_campaign_regions mcr WHERE mcr.campaign_id = $1)
          OR l.region_id IN (SELECT region_id FROM marketing_campaign_regions WHERE campaign_id = $1)
        )
        AND NOT EXISTS (
          SELECT 1 FROM marketing_campaign_sms_recipients msr
          WHERE msr.campaign_id = $1 AND msr.customer_id = c.id
        )
      `,
      [campaign.id, campaign.sms_audience || 'campaign_scope', campaign.customer_scope || 'all']
    );

    if (Number(remaining.rows[0]?.count || 0) === 0) {
      await db.query(
        `UPDATE marketing_campaigns SET sms_queued_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [campaign.id]
      );
    }
  }

  return { campaigns: campaigns.rowCount || 0, queued, skipped, disabled: false };
}

async function runMarketingAutomation() {
  const client = await pool.connect();
  let runId = null;
  try {
    const run = await client.query(
      `INSERT INTO marketing_automation_runs (run_type, status, started_at) VALUES ('campaign_cycle', 'running', NOW()) RETURNING id`
    );
    runId = run.rows[0].id;
    const statuses = await syncCampaignStatuses(client);
    const sms = await queueCampaignSms(client);
    const processed = statuses.activated + statuses.ended + statuses.expiredCoupons + sms.queued + sms.skipped;
    await client.query(
      `UPDATE marketing_automation_runs SET status = 'completed', processed_count = $1, details = $2::jsonb, completed_at = NOW() WHERE id = $3`,
      [processed, JSON.stringify({ statuses, sms }), runId]
    );
    return { processed, statuses, sms };
  } catch (error) {
    if (runId) {
      await client.query(
        `UPDATE marketing_automation_runs SET status = 'failed', details = $1::jsonb, completed_at = NOW() WHERE id = $2`,
        [JSON.stringify({ error: error.message }), runId]
      ).catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { runMarketingAutomation, syncCampaignStatuses, queueCampaignSms };