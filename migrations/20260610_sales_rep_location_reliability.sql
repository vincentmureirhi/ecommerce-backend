-- Keeps sales rep live tracking reliable on databases that were created
-- before the sales_rep_locations table had full GPS metadata.

CREATE TABLE IF NOT EXISTS sales_rep_locations (
  id SERIAL PRIMARY KEY,
  sales_rep_id INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  latitude NUMERIC(10, 7) NOT NULL,
  longitude NUMERIC(10, 7) NOT NULL,
  accuracy_meters NUMERIC(10, 2),
  speed_kph NUMERIC(10, 2),
  heading_degrees NUMERIC(10, 2),
  battery_level NUMERIC(5, 2),
  source VARCHAR(50) DEFAULT 'web',
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE sales_rep_locations
  ADD COLUMN IF NOT EXISTS accuracy_meters NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS speed_kph NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS heading_degrees NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS battery_level NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_sales_rep_locations_rep_recorded
  ON sales_rep_locations (sales_rep_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_rep_locations_recorded
  ON sales_rep_locations (recorded_at DESC);
