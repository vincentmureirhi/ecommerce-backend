-- Extends the existing marketing campaign system into an admin-controlled
-- collections and merchandising engine. Safe to run more than once.

ALTER TABLE public.marketing_campaigns
  ADD COLUMN IF NOT EXISTS is_collection BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS collection_slug VARCHAR(120),
  ADD COLUMN IF NOT EXISTS automatic_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS seo_title VARCHAR(180),
  ADD COLUMN IF NOT EXISTS seo_description VARCHAR(320),
  ADD COLUMN IF NOT EXISTS homepage_section VARCHAR(40),
  ADD COLUMN IF NOT EXISTS product_limit INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS share_image_url TEXT,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_collection_slug
  ON public.marketing_campaigns (LOWER(collection_slug))
  WHERE collection_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_marketing_collections_public
  ON public.marketing_campaigns (is_collection, status, priority DESC, starts_at, ends_at)
  WHERE is_collection = TRUE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_marketing_collection_product_limit') THEN
    ALTER TABLE public.marketing_campaigns
      ADD CONSTRAINT chk_marketing_collection_product_limit
      CHECK (product_limit BETWEEN 4 AND 24);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.storefront_product_events (
  id BIGSERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  event_type VARCHAR(30) NOT NULL,
  session_id VARCHAR(120),
  source_path TEXT,
  campaign_id INTEGER REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_storefront_product_event_type
    CHECK (event_type IN ('view', 'add_to_cart'))
);

CREATE INDEX IF NOT EXISTS idx_storefront_product_events_product_created
  ON public.storefront_product_events (product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_storefront_product_events_trending
  ON public.storefront_product_events (event_type, created_at DESC, product_id);

CREATE INDEX IF NOT EXISTS idx_order_items_product_order
  ON public.order_items (product_id, order_id);

INSERT INTO public.marketing_campaigns
  (campaign_code, name, campaign_type, status, customer_scope, priority,
   hero_title, hero_subtitle, cta_label, cta_url, placement,
   is_collection, collection_slug, automatic_rules, seo_title, seo_description,
   homepage_section, product_limit, auto_activate, auto_expire, published_at,
   created_at, updated_at)
VALUES
  ('COLLECTION_DEALS', 'Deals', 'general', 'active', 'all', 100,
   'Deals worth adding to cart', 'Live offers on available stock.', 'Shop deals', '/deals', 'home',
   TRUE, 'deals', '{"flash":true,"sort":"featured"}'::jsonb,
   'Deals on Beauty, Hair and Household Supplies | XPOSE', 'Shop current XPOSE deals while stock is available.',
   'deals', 12, FALSE, TRUE, NOW(), NOW(), NOW()),
  ('COLLECTION_WHOLESALE', 'Wholesale Corner', 'general', 'active', 'all', 90,
   'Wholesale corner', 'Trade packs, cartons and tier prices.', 'Shop wholesale', '/wholesale', 'home',
   TRUE, 'wholesale', '{"wholesale":true,"sort":"price-asc"}'::jsonb,
   'Wholesale Beauty and Household Supplies | XPOSE', 'Shop genuine wholesale tiers and trade-pack pricing.',
   'wholesale', 10, FALSE, TRUE, NOW(), NOW(), NOW()),
  ('COLLECTION_UNDER_500', 'Under KSh 500', 'general', 'active', 'all', 80,
   'Under KSh 500', 'Useful picks for smaller baskets.', 'Shop under 500', '/under-500', 'home',
   TRUE, 'under-500', '{"max_price":500,"sort":"price-asc"}'::jsonb,
   'Products Under KSh 500 | XPOSE', 'Shop available beauty, baby-care and household products under KSh 500.',
   'under_500', 10, FALSE, TRUE, NOW(), NOW(), NOW()),
  ('COLLECTION_NEW_ARRIVALS', 'New Arrivals', 'general', 'active', 'all', 70,
   'New arrivals', 'Fresh stock, recently published.', 'Shop new arrivals', '/new-arrivals', 'home',
   TRUE, 'new-arrivals', '{"sort":"newest"}'::jsonb,
   'New Beauty and Household Arrivals | XPOSE', 'Browse recently published products available on XPOSE.',
   'new_arrivals', 10, FALSE, TRUE, NOW(), NOW(), NOW()),
  ('COLLECTION_SALON', 'Salon Supplies', 'category', 'active', 'all', 60,
   'Salon supplies', 'Hair, styling and salon restock picks.', 'Shop salon', '/salon-supplies', 'shop',
   TRUE, 'salon-supplies', '{"search_terms":["salon","hair","braid","shampoo","conditioner","styling"]}'::jsonb,
   'Salon and Hair Supplies | XPOSE', 'Shop hair, salon and styling supplies at retail and wholesale prices.',
   'shop_by_need', 12, FALSE, TRUE, NOW(), NOW(), NOW()),
  ('COLLECTION_BABY', 'Baby Care', 'category', 'active', 'all', 55,
   'Baby care', 'Everyday baby-care essentials.', 'Shop baby care', '/baby-care', 'shop',
   TRUE, 'baby-care', '{"search_terms":["baby","diaper","nappy","wipe","petroleum jelly"]}'::jsonb,
   'Baby Care Essentials | XPOSE', 'Shop baby-care essentials from available XPOSE stock.',
   'shop_by_need', 12, FALSE, TRUE, NOW(), NOW(), NOW()),
  ('COLLECTION_SCHOOL', 'Back to School', 'category', 'active', 'all', 50,
   'Back to school', 'Personal-care and household school essentials.', 'Shop school list', '/back-to-school', 'shop',
   TRUE, 'back-to-school', '{"search_terms":["school","soap","lotion","toothpaste","sanitary"]}'::jsonb,
   'Back-to-School Essentials | XPOSE', 'Shop practical school personal-care and household essentials.',
   'shop_by_need', 12, FALSE, TRUE, NOW(), NOW(), NOW())
ON CONFLICT (campaign_code) DO NOTHING;
