BEGIN;

-- 1) Add audit + optional fields (safe)
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS received_by_user_id INTEGER;

-- 2) Backfill timestamps for existing rows
UPDATE public.payments
SET
  created_at = COALESCE(created_at, now()),
  updated_at = COALESCE(updated_at, created_at)
WHERE created_at IS NULL OR updated_at IS NULL;

-- 3) Normalize / default existing values
UPDATE public.payments
SET
  status = COALESCE(status, 'completed'),
  payment_method = COALESCE(payment_method, 'other')
WHERE status IS NULL OR payment_method IS NULL;

-- 4) Constraints (only create if missing)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payments_amount') THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT chk_payments_amount CHECK (amount > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payments_status') THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT chk_payments_status
      CHECK (status IN ('pending','completed','failed','cancelled','reversed','voided'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payments_method') THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT chk_payments_method
      CHECK (payment_method IN ('cash','mpesa','bank','card','other'));
  END IF;
END $$;

-- 5) Foreign key to users (optional)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='users'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_received_by_user_id_fkey'
  )
  THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_received_by_user_id_fkey
      FOREIGN KEY (received_by_user_id) REFERENCES public.users(id);
  END IF;
END $$;

-- 6) Indexes
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON public.payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON public.payments(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_payment_method ON public.payments(payment_method);

-- 7) A clean “payment summary per order” view (works with your column names)
CREATE OR REPLACE VIEW public.v_order_payment_summary AS
SELECT
  o.id AS order_id,
  o.total_amount::numeric(12,2) AS order_total,
  COALESCE(SUM(CASE WHEN p.status='completed' THEN p.amount ELSE 0 END), 0)::numeric(12,2) AS paid_total,
  (o.total_amount::numeric(12,2) - COALESCE(SUM(CASE WHEN p.status='completed' THEN p.amount ELSE 0 END), 0))::numeric(12,2) AS balance,
  CASE
    WHEN COALESCE(SUM(CASE WHEN p.status='completed' THEN p.amount ELSE 0 END), 0) >= o.total_amount THEN 'paid'
    WHEN COALESCE(SUM(CASE WHEN p.status='completed' THEN p.amount ELSE 0 END), 0) > 0 THEN 'partial'
    ELSE 'unpaid'
  END AS payment_state
FROM public.orders o
LEFT JOIN public.payments p ON p.order_id = o.id
GROUP BY o.id;

COMMIT;