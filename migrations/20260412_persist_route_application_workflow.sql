BEGIN;

ALTER TABLE public.route_customer_applications
  ADD COLUMN IF NOT EXISTS is_printed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS security_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS finance_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS admin_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS physically_filed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS digitally_archived BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS security_reviewed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS finance_reviewed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS admin_reviewed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS physically_filed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS digitally_archived_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS review_stage VARCHAR(30) NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS workflow_notes TEXT NULL,
  ADD COLUMN IF NOT EXISTS filed_reference VARCHAR(255) NULL;

UPDATE public.route_customer_applications
SET
  review_stage = CASE
    WHEN status = 'approved' THEN 'approved'
    WHEN status = 'rejected' THEN 'rejected'
    ELSE 'received'
  END,
  admin_reviewed = CASE
    WHEN status IN ('approved', 'rejected') THEN TRUE
    ELSE admin_reviewed
  END,
  admin_reviewed_at = CASE
    WHEN status IN ('approved', 'rejected') AND admin_reviewed_at IS NULL THEN COALESCE(reviewed_at, NOW())
    ELSE admin_reviewed_at
  END
WHERE TRUE;

COMMIT;

CREATE INDEX IF NOT EXISTS idx_route_customer_applications_review_stage
  ON public.route_customer_applications(review_stage);

CREATE INDEX IF NOT EXISTS idx_route_customer_applications_status_review_stage
  ON public.route_customer_applications(status, review_stage);
