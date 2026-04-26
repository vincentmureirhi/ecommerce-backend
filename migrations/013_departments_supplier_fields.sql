-- Migration: 013_departments_supplier_fields
-- Adds supplier-related columns to the departments table so that
-- supplierController.js can read/write these fields without errors.
-- All columns use IF NOT EXISTS so the migration is safe to re-run.

BEGIN;

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS description       TEXT,
  ADD COLUMN IF NOT EXISTS contact_person    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS phone             VARCHAR(20),
  ADD COLUMN IF NOT EXISTS email             VARCHAR(100),
  ADD COLUMN IF NOT EXISTS address           TEXT,
  ADD COLUMN IF NOT EXISTS notes             TEXT,
  ADD COLUMN IF NOT EXISTS is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS payment_terms     TEXT,
  ADD COLUMN IF NOT EXISTS lead_time_days    INTEGER NOT NULL DEFAULT 0;

COMMIT;
