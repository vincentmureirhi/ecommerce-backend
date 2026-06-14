BEGIN;

-- Route checkout uses these fields from the public guest-checkout endpoint.
-- Keep this migration defensive so older Supabase databases can be brought
-- forward without re-running every historical migration by hand.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS customer_email VARCHAR(100),
  ADD COLUMN IF NOT EXISTS delivery_address TEXT,
  ADD COLUMN IF NOT EXISTS sales_rep_id INTEGER,
  ADD COLUMN IF NOT EXISTS order_workflow_type VARCHAR(50) DEFAULT 'normal_self_service',
  ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS last_payment_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_state VARCHAR(20) DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS is_printed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;

UPDATE public.orders
SET
  order_type = COALESCE(order_type, 'normal'),
  order_workflow_type = COALESCE(
    order_workflow_type,
    CASE
      WHEN order_type = 'route' AND sales_rep_id IS NOT NULL THEN 'route_sales_rep_capture'
      WHEN order_type = 'route' THEN 'route_self_service'
      ELSE 'normal_self_service'
    END
  ),
  amount_paid = COALESCE(amount_paid, 0),
  payment_state = COALESCE(payment_state, 'unpaid'),
  is_printed = COALESCE(is_printed, FALSE);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_order_type_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_order_type_check
      CHECK (order_type IN ('normal', 'route'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_order_workflow_type_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_order_workflow_type_check
      CHECK (order_workflow_type IN ('normal_self_service', 'route_self_service', 'route_sales_rep_capture'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_state_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_payment_state_check
      CHECK (payment_state IN ('unpaid', 'partial', 'paid', 'overdue'));
  END IF;

  IF to_regclass('public.sales_reps') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'orders_sales_rep_id_fkey'
     ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_sales_rep_id_fkey
      FOREIGN KEY (sales_rep_id) REFERENCES public.sales_reps(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS customer_type VARCHAR(20) DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS sales_rep_id INTEGER,
  ADD COLUMN IF NOT EXISTS location_id INTEGER,
  ADD COLUMN IF NOT EXISTS route_area TEXT,
  ADD COLUMN IF NOT EXISTS route_notes TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_customer_type_check'
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_customer_type_check
      CHECK (customer_type IN ('normal', 'route'));
  END IF;

  IF to_regclass('public.sales_reps') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'customers_sales_rep_id_fkey'
     ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_sales_rep_id_fkey
      FOREIGN KEY (sales_rep_id) REFERENCES public.sales_reps(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.locations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'customers_location_id_fkey'
     ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_location_id_fkey
      FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.route_customer_credit_profiles (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  credit_limit NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_credit_active BOOLEAN NOT NULL DEFAULT TRUE,
  credit_notes TEXT,
  created_by_user_id INTEGER,
  updated_by_user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT route_customer_credit_profiles_credit_limit_check CHECK (credit_limit >= 0),
  CONSTRAINT route_customer_credit_profiles_customer_id_key UNIQUE (customer_id)
);

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
  reviewed_by_user_id INTEGER,
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

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS pricing_locked_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS line_total NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS price_source TEXT;

UPDATE public.order_items
SET
  pricing_locked_at = COALESCE(pricing_locked_at, NOW()),
  line_total = COALESCE(line_total, quantity * price_at_purchase);

CREATE TABLE IF NOT EXISTS public.order_item_pricing_audit (
  id SERIAL PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES public.order_items(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES public.products(id),
  quantity INTEGER NOT NULL,
  price_at_purchase NUMERIC(12,2) NOT NULL,
  line_total NUMERIC(12,2) NOT NULL,
  price_source TEXT,
  pricing_locked_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_sales_rep_created
  ON public.orders (sales_rep_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_type_created
  ON public.orders (order_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customers_type_location_active
  ON public.customers (customer_type, location_id, is_active);

CREATE INDEX IF NOT EXISTS idx_route_credit_requests_customer_status
  ON public.route_customer_credit_limit_requests (customer_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_item_pricing_audit_order
  ON public.order_item_pricing_audit (order_id);

COMMIT;
