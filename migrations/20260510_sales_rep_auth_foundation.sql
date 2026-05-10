BEGIN;

ALTER TABLE sales_reps
  ADD COLUMN IF NOT EXISTS full_name TEXT,
  ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS username VARCHAR(100),
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255),
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS route_area TEXT,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

UPDATE sales_reps
SET
  full_name = COALESCE(NULLIF(full_name, ''), name),
  phone = COALESCE(NULLIF(phone, ''), phone_number),
  is_active = CASE WHEN status = 'inactive' THEN FALSE ELSE TRUE END;

ALTER TABLE sales_reps
  ALTER COLUMN full_name SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_reps_username_lower
  ON sales_reps (LOWER(username))
  WHERE username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_reps_email_lower
  ON sales_reps (LOWER(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_rep_locations (
  id BIGSERIAL PRIMARY KEY,
  sales_rep_id INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  latitude NUMERIC(10, 7) NOT NULL,
  longitude NUMERIC(10, 7) NOT NULL,
  accuracy_meters NUMERIC(10, 2),
  speed_kph NUMERIC(10, 2),
  heading_degrees NUMERIC(10, 2),
  battery_level NUMERIC(5, 2),
  source VARCHAR(50) NOT NULL DEFAULT 'web',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_rep_locations_rep_recorded
  ON sales_rep_locations (sales_rep_id, recorded_at DESC);

COMMIT;
