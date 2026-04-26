BEGIN;

-- ============================================================
-- Enrich order_items with pricing rule context for audit
-- ============================================================
-- These columns are populated at order-creation time and are
-- included in the DB-trigger audit record so future maintainers
-- can understand which rule drove the price without needing to
-- join back to live pricing_rules rows (which may have changed).
-- Both columns are covered by the pricing immutability trigger.
-- ============================================================

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS pricing_rule_id INTEGER,
  ADD COLUMN IF NOT EXISTS rule_type       VARCHAR(20);

COMMENT ON COLUMN order_items.pricing_rule_id IS
  'Snapshot of the pricing rule applied when this item was created. '
  'NULL for legacy-fallback orders (products without a pricing_rule).';

COMMENT ON COLUMN order_items.rule_type IS
  'Snapshot of the rule_type at order creation time. '
  'Retained for audit integrity even if the live rule is later edited.';

-- ============================================================
-- Update audit table to capture rule context columns
-- ============================================================

ALTER TABLE order_item_pricing_audit
  ADD COLUMN IF NOT EXISTS pricing_rule_id INTEGER,
  ADD COLUMN IF NOT EXISTS rule_type       VARCHAR(20);

COMMENT ON COLUMN order_item_pricing_audit.pricing_rule_id IS
  'Copied from order_items.pricing_rule_id via the insert trigger.';

COMMENT ON COLUMN order_item_pricing_audit.rule_type IS
  'Copied from order_items.rule_type via the insert trigger.';

-- ============================================================
-- Update the DB-trigger to copy rule context into audit rows
-- ============================================================

CREATE OR REPLACE FUNCTION public.audit_order_item_pricing_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO order_item_pricing_audit (
    order_item_id,
    order_id,
    product_id,
    quantity,
    price_at_purchase,
    line_total,
    price_source,
    pricing_locked_at,
    pricing_rule_id,
    rule_type
  )
  VALUES (
    NEW.id,
    NEW.order_id,
    NEW.product_id,
    NEW.quantity,
    NEW.price_at_purchase,
    NEW.line_total,
    NEW.price_source,
    NEW.pricing_locked_at,
    NEW.pricing_rule_id,
    NEW.rule_type
  );

  RETURN NEW;
END;
$$;

-- Re-create the trigger (function was replaced above, trigger
-- already exists; this is idempotent via DROP IF EXISTS)
DROP TRIGGER IF EXISTS trg_audit_order_item_pricing_insert ON public.order_items;

CREATE TRIGGER trg_audit_order_item_pricing_insert
  AFTER INSERT ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_order_item_pricing_insert();

-- ============================================================
-- Extend the pricing immutability trigger to cover rule context
-- ============================================================

CREATE OR REPLACE FUNCTION public.prevent_order_item_pricing_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.product_id        IS DISTINCT FROM OLD.product_id
  OR NEW.quantity          IS DISTINCT FROM OLD.quantity
  OR NEW.price_at_purchase IS DISTINCT FROM OLD.price_at_purchase
  OR NEW.line_total        IS DISTINCT FROM OLD.line_total
  OR NEW.price_source      IS DISTINCT FROM OLD.price_source
  OR NEW.pricing_locked_at IS DISTINCT FROM OLD.pricing_locked_at
  OR NEW.pricing_rule_id   IS DISTINCT FROM OLD.pricing_rule_id
  OR NEW.rule_type         IS DISTINCT FROM OLD.rule_type
  THEN
    RAISE EXCEPTION
      'Order item pricing is locked. Updates are not allowed (order_item_id=%).', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_order_item_pricing_update ON public.order_items;

CREATE TRIGGER trg_prevent_order_item_pricing_update
  BEFORE UPDATE ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_order_item_pricing_update();

COMMIT;
