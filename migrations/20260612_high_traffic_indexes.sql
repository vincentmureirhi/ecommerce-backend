-- Extra high-traffic indexes for order tracking, route-customer search,
-- live admin dashboards, payments, inventory, and flash-sale storefront feeds.
-- Safe to run more than once. Every index is guarded by table/column checks.

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping pg_trgm extension; insufficient privilege.';
  END;
END $$;

DO $$
DECLARE
  has_trgm BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')
  INTO has_trgm;

  IF to_regclass('public.orders') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_created_at_desc ON public.orders (created_at DESC)';
  END IF;

  IF to_regclass('public.orders') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'order_status')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_order_status_created ON public.orders (order_status, created_at DESC)';
  END IF;

  IF to_regclass('public.orders') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'payment_status')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_payment_status_created ON public.orders (payment_status, created_at DESC)';
  END IF;

  IF to_regclass('public.orders') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'customer_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_customer_created ON public.orders (customer_id, created_at DESC)';
  END IF;

  IF to_regclass('public.orders') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'sales_rep_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_sales_rep_created ON public.orders (sales_rep_id, created_at DESC)';
  END IF;

  IF to_regclass('public.orders') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'order_type')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_type_created ON public.orders (order_type, created_at DESC)';
  END IF;

  IF to_regclass('public.order_items') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'product_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'order_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_order_items_product_order ON public.order_items (product_id, order_id)';
  END IF;

  IF to_regclass('public.payments') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'order_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_payments_order_created ON public.payments (order_id, created_at DESC)';
  END IF;

  IF to_regclass('public.payments') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'checkout_request_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_payments_checkout_request_id ON public.payments (checkout_request_id) WHERE checkout_request_id IS NOT NULL';
  END IF;

  IF to_regclass('public.payments') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'mpesa_receipt_number') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_payments_mpesa_receipt_number ON public.payments (mpesa_receipt_number) WHERE mpesa_receipt_number IS NOT NULL';
  END IF;

  IF to_regclass('public.customers') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'customer_type')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'location_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'is_active') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_customers_type_location_active ON public.customers (customer_type, location_id, is_active)';
  END IF;

  IF to_regclass('public.customers') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'customer_type')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'sales_rep_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'is_active') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_customers_type_sales_rep_active ON public.customers (customer_type, sales_rep_id, is_active)';
  END IF;

  IF to_regclass('public.customers') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_customers_created_at_desc ON public.customers (created_at DESC)';
  END IF;

  IF to_regclass('public.customers') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'phone') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_customers_phone_digits ON public.customers ((regexp_replace(COALESCE(phone, ''''), ''\D'', '''', ''g'')))';
  END IF;

  IF has_trgm AND to_regclass('public.customers') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'name') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_customers_name_trgm ON public.customers USING gin (name gin_trgm_ops)';
  END IF;

  IF has_trgm AND to_regclass('public.customers') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'phone') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_customers_phone_trgm ON public.customers USING gin (phone gin_trgm_ops)';
  END IF;

  IF has_trgm AND to_regclass('public.products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'name') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON public.products USING gin (name gin_trgm_ops)';
  END IF;

  IF to_regclass('public.products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_active')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'category_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_active_category_created ON public.products (is_active, category_id, created_at DESC)';
  END IF;

  IF to_regclass('public.products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'stock_status_override')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'current_stock') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_stock_status_current ON public.products (stock_status_override, current_stock)';
  END IF;

  IF to_regclass('public.flash_sales') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'flash_sales' AND column_name = 'is_active')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'flash_sales' AND column_name = 'start_date')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'flash_sales' AND column_name = 'end_date') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_flash_sales_live_window ON public.flash_sales (is_active, start_date, end_date)';
  END IF;

  IF to_regclass('public.flash_sale_products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'flash_sale_products' AND column_name = 'flash_sale_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'flash_sale_products' AND column_name = 'product_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_flash_sale_products_sale_product ON public.flash_sale_products (flash_sale_id, product_id)';
  END IF;

  IF to_regclass('public.sms_outbox') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sms_outbox' AND column_name = 'status')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sms_outbox' AND column_name = 'next_attempt_at')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sms_outbox' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_sms_outbox_claim_queue ON public.sms_outbox (status, next_attempt_at, created_at) WHERE status IN (''queued'', ''retry'')';
  END IF;

  IF to_regclass('public.route_customer_applications') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'route_customer_applications' AND column_name = 'status')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'route_customer_applications' AND column_name = 'created_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_route_customer_applications_status_created ON public.route_customer_applications (status, created_at DESC)';
  END IF;

  IF to_regclass('public.route_customer_accounts') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'route_customer_accounts' AND column_name = 'customer_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_route_customer_accounts_customer_id ON public.route_customer_accounts (customer_id)';
  END IF;
END $$;
