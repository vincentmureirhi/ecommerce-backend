-- Migration: Add guest checkout fields to orders table
-- Adds customer_email and delivery_address columns to support
-- guest checkout where customer details are stored on the order itself.

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_email character varying(100),
  ADD COLUMN IF NOT EXISTS delivery_address text;

COMMIT;
