-- Hot-path indexes for storefront traffic, order tracking, payments, and admin operations.
-- Safe for older/live databases: every index is created only when its table/columns exist.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'order_number'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_order_number ON public.orders (order_number)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'customer_phone'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_customer_phone_digits ON public.orders ((regexp_replace(COALESCE(customer_phone, ''''), ''\D'', '''', ''g'')))';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'order_status'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'status_changed_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_status_changed_at ON public.orders (order_status, status_changed_at)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'customer_type'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'created_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_customer_type_created ON public.orders (customer_type, created_at DESC)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'order_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON public.order_items (order_id)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'order_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'status'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_payments_order_status ON public.payments (order_id, status)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'status'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'created_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_payments_status_created ON public.payments (status, created_at DESC)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'category_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_active'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_category_active ON public.products (category_id, is_active)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'flash_sale_products' AND column_name = 'product_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_flash_sale_products_product ON public.flash_sale_products (product_id)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'sales_rep_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'phone'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'customer_type'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_customers_route_rep_phone ON public.customers (sales_rep_id, phone) WHERE customer_type = ''route''';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_rep_locations' AND column_name = 'recorded_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_sales_rep_locations_recorded ON public.sales_rep_locations (recorded_at DESC)';
  END IF;
END $$;
