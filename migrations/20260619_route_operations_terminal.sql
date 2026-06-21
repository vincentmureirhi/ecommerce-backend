-- Route Operations Terminal
-- Live route cycles, targets, order attachment, candle data, and route events.

CREATE TABLE IF NOT EXISTS route_cycles (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  route_type TEXT NOT NULL DEFAULT 'custom' CHECK (
    route_type IN ('weekly_route', 'mwatate_route', 'custom')
  ),
  target_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (target_amount >= 0),
  start_at TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned', 'live', 'closed', 'cancelled')
  ),
  region_id BIGINT REFERENCES regions(id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_by_user_id BIGINT,
  closed_at TIMESTAMPTZ,
  final_amount NUMERIC(14, 2),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (deadline_at > start_at)
);

CREATE TABLE IF NOT EXISTS route_cycle_locations (
  id BIGSERIAL PRIMARY KEY,
  route_cycle_id BIGINT NOT NULL REFERENCES route_cycles(id) ON DELETE CASCADE,
  location_id BIGINT NOT NULL REFERENCES locations(id) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (route_cycle_id, location_id)
);

CREATE TABLE IF NOT EXISTS route_cycle_orders (
  id BIGSERIAL PRIMARY KEY,
  route_cycle_id BIGINT NOT NULL REFERENCES route_cycles(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sales_rep_id BIGINT,
  route_customer_id BIGINT,
  order_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id)
);

CREATE TABLE IF NOT EXISTS route_cycle_events (
  id BIGSERIAL PRIMARY KEY,
  route_cycle_id BIGINT NOT NULL REFERENCES route_cycles(id) ON DELETE CASCADE,
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  event_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (
    severity IN ('info', 'success', 'warning', 'critical')
  ),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS route_cycle_snapshots (
  id BIGSERIAL PRIMARY KEY,
  route_cycle_id BIGINT NOT NULL REFERENCES route_cycles(id) ON DELETE CASCADE,
  interval_start TIMESTAMPTZ NOT NULL,
  interval_end TIMESTAMPTZ NOT NULL,
  order_count INTEGER NOT NULL DEFAULT 0,
  order_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  cumulative_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (route_cycle_id, interval_start, interval_end)
);

CREATE INDEX IF NOT EXISTS idx_route_cycles_status_deadline
  ON route_cycles(status, deadline_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_cycles_region_status
  ON route_cycles(region_id, status, start_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_cycle_locations_location
  ON route_cycle_locations(location_id, route_cycle_id);

CREATE INDEX IF NOT EXISTS idx_route_cycle_orders_cycle_captured
  ON route_cycle_orders(route_cycle_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_cycle_orders_sales_rep
  ON route_cycle_orders(route_cycle_id, sales_rep_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_cycle_orders_customer
  ON route_cycle_orders(route_cycle_id, route_customer_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_cycle_events_cycle_created
  ON route_cycle_events(route_cycle_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_cycle_events_type_created
  ON route_cycle_events(event_type, created_at DESC);
