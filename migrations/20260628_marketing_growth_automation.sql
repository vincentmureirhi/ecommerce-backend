-- XPOSE marketing growth, route rewards, referrals, and automation.
-- Safe to run more than once.

ALTER TABLE public.marketing_campaigns
  ADD COLUMN IF NOT EXISTS placement VARCHAR(30) NOT NULL DEFAULT 'home',
  ADD COLUMN IF NOT EXISTS hero_image_url TEXT,
  ADD COLUMN IF NOT EXISTS accent_color VARCHAR(20),
  ADD COLUMN IF NOT EXISTS auto_activate BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_expire BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sms_message VARCHAR(320),
  ADD COLUMN IF NOT EXISTS sms_audience VARCHAR(30) NOT NULL DEFAULT 'campaign_scope',
  ADD COLUMN IF NOT EXISTS sms_queued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_marketing_campaign_placement') THEN
    ALTER TABLE public.marketing_campaigns
      ADD CONSTRAINT chk_marketing_campaign_placement
      CHECK (placement IN ('home', 'shop', 'checkout', 'route_portal', 'all'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_marketing_campaign_sms_audience') THEN
    ALTER TABLE public.marketing_campaigns
      ADD CONSTRAINT chk_marketing_campaign_sms_audience
      CHECK (sms_audience IN ('campaign_scope', 'normal', 'route', 'all'));
  END IF;
END $$;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS marketing_sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS marketing_sms_opted_in_at TIMESTAMPTZ;

ALTER TABLE public.route_customer_applications
  ADD COLUMN IF NOT EXISTS marketing_sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS referral_code VARCHAR(60),
  ADD COLUMN IF NOT EXISTS referred_by_sales_rep_id INTEGER REFERENCES public.sales_reps(id) ON DELETE SET NULL;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS referral_code VARCHAR(60),
  ADD COLUMN IF NOT EXISTS route_reward_points INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.marketing_campaign_events (
  id BIGSERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
  event_type VARCHAR(30) NOT NULL,
  session_id VARCHAR(120),
  order_id INTEGER REFERENCES public.orders(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES public.customers(id) ON DELETE SET NULL,
  source_path TEXT,
  request_id VARCHAR(120),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_marketing_campaign_event_type
    CHECK (event_type IN ('impression', 'click', 'conversion'))
);

CREATE TABLE IF NOT EXISTS public.route_customer_reward_accounts (
  customer_id INTEGER PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  points_balance INTEGER NOT NULL DEFAULT 0,
  lifetime_points INTEGER NOT NULL DEFAULT 0,
  tier VARCHAR(30) NOT NULL DEFAULT 'starter',
  last_earned_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_route_reward_points_nonnegative CHECK (points_balance >= 0 AND lifetime_points >= 0),
  CONSTRAINT chk_route_reward_tier CHECK (tier IN ('starter', 'silver', 'gold', 'platinum'))
);

CREATE TABLE IF NOT EXISTS public.route_customer_reward_ledger (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES public.orders(id) ON DELETE SET NULL,
  points INTEGER NOT NULL,
  entry_type VARCHAR(30) NOT NULL,
  description VARCHAR(240),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_route_reward_entry_type CHECK (entry_type IN ('order_earned', 'referral_earned', 'redeemed', 'adjustment')),
  CONSTRAINT uq_route_reward_order UNIQUE (customer_id, order_id, entry_type)
);

CREATE TABLE IF NOT EXISTS public.sales_rep_referral_codes (
  id SERIAL PRIMARY KEY,
  sales_rep_id INTEGER NOT NULL REFERENCES public.sales_reps(id) ON DELETE CASCADE,
  code VARCHAR(60) NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  reward_points INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sales_rep_referral_code_rep UNIQUE (sales_rep_id),
  CONSTRAINT chk_sales_rep_referral_reward CHECK (reward_points >= 0)
);

CREATE TABLE IF NOT EXISTS public.route_customer_referrals (
  id BIGSERIAL PRIMARY KEY,
  referral_code_id INTEGER NOT NULL REFERENCES public.sales_rep_referral_codes(id) ON DELETE RESTRICT,
  application_id INTEGER REFERENCES public.route_customer_applications(id) ON DELETE SET NULL,
  referred_customer_id INTEGER REFERENCES public.customers(id) ON DELETE SET NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'applied',
  reward_points INTEGER NOT NULL DEFAULT 0,
  rewarded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_route_referral_status CHECK (status IN ('applied', 'approved', 'rewarded', 'rejected')),
  CONSTRAINT uq_route_referral_application UNIQUE (application_id)
);

CREATE TABLE IF NOT EXISTS public.marketing_campaign_sms_recipients (
  id BIGSERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  phone VARCHAR(40) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'queued',
  sms_outbox_id BIGINT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_marketing_sms_recipient_status CHECK (status IN ('queued', 'skipped', 'failed')),
  CONSTRAINT uq_marketing_sms_campaign_customer UNIQUE (campaign_id, customer_id)
);

CREATE TABLE IF NOT EXISTS public.marketing_automation_runs (
  id BIGSERIAL PRIMARY KEY,
  run_type VARCHAR(60) NOT NULL,
  status VARCHAR(30) NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_marketing_automation_status CHECK (status IN ('running', 'completed', 'failed'))
);

INSERT INTO public.route_customer_reward_accounts (customer_id)
SELECT c.id
FROM public.customers c
WHERE c.customer_type = 'route'
ON CONFLICT (customer_id) DO NOTHING;

INSERT INTO public.sales_rep_referral_codes (sales_rep_id, code)
SELECT sr.id, 'XPOSE-REP-' || sr.id::text
FROM public.sales_reps sr
ON CONFLICT (sales_rep_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_marketing_events_campaign_type_created
  ON public.marketing_campaign_events (campaign_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_events_created
  ON public.marketing_campaign_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_route_reward_ledger_customer_created
  ON public.route_customer_reward_ledger (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_route_referrals_code_status
  ON public.route_customer_referrals (referral_code_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_route_applications_referral_code
  ON public.route_customer_applications (UPPER(referral_code)) WHERE referral_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketing_sms_campaign_status
  ON public.marketing_campaign_sms_recipients (campaign_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_customers_marketing_sms_opt_in
  ON public.customers (customer_type, location_id) WHERE marketing_sms_opt_in = TRUE;