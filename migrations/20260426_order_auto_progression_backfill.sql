-- Migration: backfill status_changed_at for orders that may still be NULL
-- after the Chunk 1 migration, and set sensible defaults so that the
-- auto-progression job has a safe, non-NULL baseline for every active order.
--
-- Safe to run multiple times (idempotent).

BEGIN;

-- For any rows still missing status_changed_at (should be none after the Chunk 1
-- migration, but this guard ensures the job never accidentally skips a row).
UPDATE orders
  SET status_changed_at = COALESCE(updated_at, created_at)
WHERE status_changed_at IS NULL;

COMMIT;
