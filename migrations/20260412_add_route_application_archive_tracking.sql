BEGIN;

ALTER TABLE public.route_customer_applications
  ADD COLUMN IF NOT EXISTS received_by_user_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS received_email_subject VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS received_email_from VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS received_on_email_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS digital_file_name VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS digital_file_reference VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS archived_by_user_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

UPDATE public.route_customer_applications
SET
  received_on_email_at = COALESCE(received_on_email_at, created_at)
WHERE submitted_via = 'email'
  AND received_on_email_at IS NULL;

UPDATE public.route_customer_applications
SET
  archived_at = COALESCE(archived_at, updated_at, NOW())
WHERE digitally_archived = TRUE
  AND archived_at IS NULL;

COMMIT;

CREATE INDEX IF NOT EXISTS idx_route_customer_applications_received_by_user_id
  ON public.route_customer_applications(received_by_user_id);

CREATE INDEX IF NOT EXISTS idx_route_customer_applications_archived_by_user_id
  ON public.route_customer_applications(archived_by_user_id);

CREATE INDEX IF NOT EXISTS idx_route_customer_applications_received_on_email_at
  ON public.route_customer_applications(received_on_email_at);

CREATE INDEX IF NOT EXISTS idx_route_customer_applications_archived_at
  ON public.route_customer_applications(archived_at);
