BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecommerce_app') THEN
    CREATE ROLE ecommerce_app LOGIN PASSWORD 'CHANGE_ME_NOW';
  END IF;
END $$;

-- Allow connect
GRANT CONNECT ON DATABASE ecommerce_db TO ecommerce_app;

-- Schema usage
GRANT USAGE ON SCHEMA public TO ecommerce_app;

-- Tables: allow typical app ops
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ecommerce_app;

-- Sequences (ids)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ecommerce_app;

-- Future tables/sequences too
ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT, INSERT, UPDATE ON TABLES TO ecommerce_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT USAGE, SELECT ON SEQUENCES TO ecommerce_app;

COMMIT;