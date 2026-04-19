BEGIN;

-- 1) Add pricing_locked_at so we can "freeze" pricing fields after insert
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS pricing_locked_at TIMESTAMPTZ;

-- 2) Auto-lock pricing on insert
CREATE OR REPLACE FUNCTION lock_order_item_pricing_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.pricing_locked_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_order_item_pricing_insert ON order_items;

CREATE TRIGGER trg_lock_order_item_pricing_insert
BEFORE INSERT ON order_items
FOR EACH ROW
EXECUTE FUNCTION lock_order_item_pricing_on_insert();

-- 3) Hard block updates to pricing fields once locked
CREATE OR REPLACE FUNCTION prevent_order_item_pricing_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.pricing_locked_at IS NOT NULL THEN
    IF (NEW.price_at_purchase IS DISTINCT FROM OLD.price_at_purchase)
       OR (NEW.line_total IS DISTINCT FROM OLD.line_total)
       OR (NEW.price_source IS DISTINCT FROM OLD.price_source)
       OR (NEW.quantity IS DISTINCT FROM OLD.quantity)
    THEN
      RAISE EXCEPTION
        'Pricing fields are locked and cannot be modified after insert (order_item id=%).',
        OLD.id;
    END IF;
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