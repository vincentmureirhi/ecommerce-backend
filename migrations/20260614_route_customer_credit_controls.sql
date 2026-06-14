BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS customer_type VARCHAR(20) DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS sales_rep_id INTEGER REFERENCES public.sales_reps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES public.locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS route_area TEXT,
  ADD COLUMN IF NOT EXISTS route_notes TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'customers_customer_type_check'
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_customer_type_check
      CHECK (customer_type IN ('normal', 'route'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.route_customer_credit_limit_requests (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  requested_by_sales_rep_id INTEGER REFERENCES public.sales_reps(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES public.orders(id) ON DELETE SET NULL,
  current_credit_limit NUMERIC(12,2) NOT NULL DEFAULT 0,
  requested_credit_limit NUMERIC(12,2) NOT NULL,
  current_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  order_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  decision_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT route_credit_limit_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT route_credit_limit_requests_requested_check
    CHECK (requested_credit_limit >= 0),
  CONSTRAINT route_credit_limit_requests_amount_check
    CHECK (order_amount >= 0),
  CONSTRAINT route_credit_limit_requests_balance_check
    CHECK (current_balance >= 0)
);

CREATE INDEX IF NOT EXISTS idx_route_credit_requests_customer_status
  ON public.route_customer_credit_limit_requests(customer_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_credit_requests_sales_rep_status
  ON public.route_customer_credit_limit_requests(requested_by_sales_rep_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customers_route_region_location
  ON public.customers(customer_type, location_id, is_active);

CREATE INDEX IF NOT EXISTS idx_customers_route_sales_rep
  ON public.customers(customer_type, sales_rep_id, is_active);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_customers_route_name_trgm
  ON public.customers USING gin (name gin_trgm_ops)
  WHERE customer_type = 'route';

CREATE INDEX IF NOT EXISTS idx_customers_route_phone_trgm
  ON public.customers USING gin (phone gin_trgm_ops)
  WHERE customer_type = 'route';

DROP VIEW IF EXISTS public.route_customer_financial_summary;

CREATE VIEW public.route_customer_financial_summary AS
SELECT
    c.id AS customer_id,
    c.name AS customer_name,
    c.email,
    c.phone,
    c.location_id,
    l.name AS location_name,
    r.id AS region_id,
    r.name AS region_name,
    COALESCE(cp.credit_limit, 0)::numeric(12,2) AS credit_limit,
    COALESCE(cp.is_credit_active, TRUE) AS is_credit_active,
    COALESCE(SUM(
      CASE
        WHEN o.order_type = 'route'
         AND COALESCE(o.order_status, '') <> 'cancelled'
        THEN o.total_amount
        ELSE 0
      END
    ), 0)::numeric(12,2) AS total_ordered_value,
    COALESCE(SUM(
      CASE
        WHEN o.order_type = 'route'
         AND COALESCE(o.order_status, '') <> 'cancelled'
        THEN COALESCE(o.amount_paid, 0)
        ELSE 0
      END
    ), 0)::numeric(12,2) AS total_paid_value,
    COALESCE(SUM(
      CASE
        WHEN o.order_type = 'route'
         AND COALESCE(o.order_status, '') <> 'cancelled'
        THEN GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)
        ELSE 0
      END
    ), 0)::numeric(12,2) AS current_balance,
    COALESCE(SUM(
      CASE
        WHEN o.order_type = 'route'
         AND COALESCE(o.order_status, '') <> 'cancelled'
         AND o.due_date IS NOT NULL
         AND o.due_date < CURRENT_DATE
        THEN GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)
        ELSE 0
      END
    ), 0)::numeric(12,2) AS overdue_balance,
    GREATEST(
      COALESCE(cp.credit_limit, 0) -
      COALESCE(SUM(
        CASE
          WHEN o.order_type = 'route'
           AND COALESCE(o.order_status, '') <> 'cancelled'
          THEN GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)
          ELSE 0
        END
      ), 0),
      0
    )::numeric(12,2) AS available_credit,
    COUNT(DISTINCT CASE
      WHEN o.order_type = 'route'
       AND COALESCE(o.order_status, '') <> 'cancelled'
      THEN o.id
    END) AS total_route_orders,
    MAX(CASE
      WHEN o.order_type = 'route'
       AND COALESCE(o.order_status, '') <> 'cancelled'
      THEN o.created_at
    END) AS last_route_order_at
FROM public.customers c
LEFT JOIN public.route_customer_credit_profiles cp
    ON cp.customer_id = c.id
LEFT JOIN public.locations l
    ON l.id = c.location_id
LEFT JOIN public.regions r
    ON r.id = l.region_id
LEFT JOIN public.orders o
    ON o.customer_id = c.id
WHERE c.customer_type = 'route'
GROUP BY
    c.id,
    c.name,
    c.email,
    c.phone,
    c.location_id,
    l.name,
    r.id,
    r.name,
    cp.credit_limit,
    cp.is_credit_active;

COMMIT;
