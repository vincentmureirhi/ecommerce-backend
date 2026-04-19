BEGIN;

CREATE OR REPLACE FUNCTION public.audit_order_item_pricing_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO order_item_pricing_audit (
    order_item_id, order_id, product_id, quantity,
    price_at_purchase, line_total, price_source, pricing_locked_at
  )
  VALUES (
    NEW.id, NEW.order_id, NEW.product_id, NEW.quantity,
    NEW.price_at_purchase, NEW.line_total, NEW.price_source, NEW.pricing_locked_at
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_order_item_pricing_insert ON public.order_items;

CREATE TRIGGER trg_audit_order_item_pricing_insert
AFTER INSERT ON public.order_items
FOR EACH ROW
EXECUTE FUNCTION public.audit_order_item_pricing_insert();

COMMIT;