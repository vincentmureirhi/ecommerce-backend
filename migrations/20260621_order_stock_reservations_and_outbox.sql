-- Order scale hardening: stock reservations, stock movement ledger, and DB-backed order event outbox.
-- Additive migration. Existing orders/products/order_items remain compatible.

CREATE TABLE IF NOT EXISTS public.inventory_stock_reservations (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES public.products(id) ON DELETE SET NULL,
  stock_source TEXT NOT NULL DEFAULT 'product',
  stock_pool_id BIGINT REFERENCES public.inventory_stock_pools(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'reserved',
  stock_after INTEGER,
  release_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_inventory_stock_reservations_source
    CHECK (stock_source IN ('product', 'pool')),
  CONSTRAINT chk_inventory_stock_reservations_status
    CHECK (status IN ('reserved', 'consumed', 'released'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_stock_reservations_order
  ON public.inventory_stock_reservations(order_id, status);

CREATE INDEX IF NOT EXISTS idx_inventory_stock_reservations_product
  ON public.inventory_stock_reservations(product_id, status);

CREATE INDEX IF NOT EXISTS idx_inventory_stock_reservations_pool
  ON public.inventory_stock_reservations(stock_pool_id, status)
  WHERE stock_pool_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.inventory_stock_movements (
  id BIGSERIAL PRIMARY KEY,
  reservation_id BIGINT REFERENCES public.inventory_stock_reservations(id) ON DELETE SET NULL,
  order_id BIGINT REFERENCES public.orders(id) ON DELETE SET NULL,
  product_id BIGINT REFERENCES public.products(id) ON DELETE SET NULL,
  stock_source TEXT NOT NULL DEFAULT 'product',
  stock_pool_id BIGINT REFERENCES public.inventory_stock_pools(id) ON DELETE SET NULL,
  movement_type TEXT NOT NULL,
  quantity_delta INTEGER NOT NULL,
  quantity_abs INTEGER NOT NULL CHECK (quantity_abs >= 0),
  stock_after INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_inventory_stock_movements_source
    CHECK (stock_source IN ('product', 'pool')),
  CONSTRAINT chk_inventory_stock_movements_type
    CHECK (movement_type IN ('order_reserved', 'order_released', 'order_consumed', 'manual_adjustment'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_stock_movements_order
  ON public.inventory_stock_movements(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_stock_movements_product
  ON public.inventory_stock_movements(product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_stock_movements_pool
  ON public.inventory_stock_movements(stock_pool_id, created_at DESC)
  WHERE stock_pool_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.order_event_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL DEFAULT 'order',
  aggregate_id BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_order_event_outbox_status
    CHECK (status IN ('queued', 'processing', 'retry', 'processed', 'failed')),
  CONSTRAINT chk_order_event_outbox_attempts
    CHECK (attempts >= 0 AND max_attempts > 0)
);

CREATE INDEX IF NOT EXISTS idx_order_event_outbox_pending
  ON public.order_event_outbox(status, next_attempt_at, id)
  WHERE status IN ('queued', 'retry');

CREATE INDEX IF NOT EXISTS idx_order_event_outbox_aggregate
  ON public.order_event_outbox(aggregate_type, aggregate_id, created_at DESC);