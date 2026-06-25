-- Storefront catalogue scale indexes for paginated product lists, live search,
-- vendor-visible products, categories, stock pools, and price tiers.
-- Safe to run more than once. Column checks prevent failures on older schemas.

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
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') INTO has_trgm;

  IF to_regclass('public.products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_active') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_storefront_active_id ON public.products (is_active, id DESC)';
  END IF;

  IF to_regclass('public.products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_active')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'updated_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_storefront_active_updated ON public.products (is_active, updated_at DESC, id DESC)';
  END IF;

  IF to_regclass('public.products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_active')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'category_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'updated_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_storefront_category_updated ON public.products (is_active, category_id, updated_at DESC, id DESC)';
  END IF;

  IF to_regclass('public.products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_active')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'current_stock') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_storefront_active_stock ON public.products (is_active, current_stock DESC)';
  END IF;

  IF to_regclass('public.products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'product_owner_type')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'vendor_approval_status')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'vendor_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_storefront_vendor_visibility ON public.products (product_owner_type, vendor_approval_status, vendor_id)';
  END IF;

  IF to_regclass('public.products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'retail_price') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_storefront_retail_price ON public.products (retail_price)';
  END IF;

  IF has_trgm AND to_regclass('public.products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'name') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_storefront_name_trgm ON public.products USING gin (lower(name) gin_trgm_ops)';
  END IF;

  IF has_trgm AND to_regclass('public.products') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'sku') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_storefront_sku_trgm ON public.products USING gin (lower(sku) gin_trgm_ops)';
  END IF;

  IF has_trgm AND to_regclass('public.categories') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'categories' AND column_name = 'name') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_categories_storefront_name_trgm ON public.categories USING gin (lower(name) gin_trgm_ops)';
  END IF;

  IF to_regclass('public.product_price_tiers') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_price_tiers' AND column_name = 'product_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'product_price_tiers' AND column_name = 'min_qty') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_product_price_tiers_product_min_qty ON public.product_price_tiers (product_id, min_qty ASC)';
  END IF;

  IF to_regclass('public.inventory_stock_pools') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'inventory_stock_pools' AND column_name = 'total_stock') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_inventory_stock_pools_total_stock ON public.inventory_stock_pools (total_stock DESC)';
  END IF;

  IF to_regclass('public.vendors') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'status')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'store_visibility_status') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_vendors_public_visibility ON public.vendors (status, store_visibility_status)';
  END IF;
END $$;