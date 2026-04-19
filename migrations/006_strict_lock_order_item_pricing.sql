BEGIN;

CREATE OR REPLACE FUNCTION public.prevent_order_item_pricing_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- If anything pricing-related changes, block it
  IF NEW.product_id        IS DISTINCT FROM OLD.product_id
  OR NEW.quantity          IS DISTINCT FROM OLD.quantity
  OR NEW.price_at_purchase IS DISTINCT FROM OLD.price_at_purchase
  OR NEW.line_total        IS DISTINCT FROM OLD.line_total
  OR NEW.price_source      IS DISTINCT FROM OLD.price_source
  OR NEW.pricing_locked_at IS DISTINCT FROM OLD.pricing_locked_at
  THEN
    RAISE EXCEPTION 'Order item pricing is locked. Updates are not allowed (order_item_id=%).', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Ensure trigger exists and uses this function
DROP TRIGGER IF EXISTS trg_prevent_order_item_pricing_update ON public.order_items;

CREATE TRIGGER trg_prevent_order_item_pricing_update
BEFORE UPDATE ON public.order_items
FOR EACH ROW
EXECUTE FUNCTION public.prevent_order_item_pricing_update();

COMMIT;