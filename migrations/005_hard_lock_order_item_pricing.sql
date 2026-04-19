BEGIN;

-- 1) Backfill pricing_locked_at for old rows (so existing data becomes locked too)
-- Prefer created_at if present, else NOW()
UPDATE order_items
SET pricing_locked_at = COALESCE(created_at, NOW())
WHERE pricing_locked_at IS NULL;

-- 2) Make sure every new row gets locked even if trigger misses
ALTER TABLE order_items
  ALTER COLUMN pricing_locked_at SET DEFAULT NOW();

-- Optional but recommended: enforce it can’t be NULL
ALTER TABLE order_items
  ALTER COLUMN pricing_locked_at SET NOT NULL;

-- 3) Replace the weak update trigger with a HARD lock:
-- pricing fields can NEVER change after insert.
CREATE OR REPLACE FUNCTION prevent_order_item_pricing_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.price_at_purchase IS DISTINCT FROM OLD.price_at_purchase)
     OR (NEW.line_total IS DISTINCT FROM OLD.line_total)
     OR (NEW.price_source IS DISTINCT FROM OLD.price_source)
     OR (NEW.quantity IS DISTINCT FROM OLD.quantity)
  THEN
    RAISE EXCEPTION
      'Pricing fields are immutable after insert (order_item id=%).',
      OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_order_item_pricing_update ON order_items;

CREATE TRIGGER trg_prevent_order_item_pricing_update
BEFORE UPDATE ON order_items
FOR EACH ROW
EXECUTE FUNCTION prevent_order_item_pricing_update();

COMMIT;