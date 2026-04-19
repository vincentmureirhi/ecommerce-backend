BEGIN;

CREATE TABLE IF NOT EXISTS public.route_customer_application_events (
  id BIGSERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  event_label VARCHAR(255) NOT NULL,
  event_notes TEXT NULL,
  actor_user_id INTEGER NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_customer_application_events_application_id
  ON public.route_customer_application_events(application_id);

CREATE INDEX IF NOT EXISTS idx_route_customer_application_events_event_type
  ON public.route_customer_application_events(event_type);

CREATE INDEX IF NOT EXISTS idx_route_customer_application_events_actor_user_id
  ON public.route_customer_application_events(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_route_customer_application_events_created_at
  ON public.route_customer_application_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_customer_application_events_app_created
  ON public.route_customer_application_events(application_id, created_at DESC);

COMMIT;
