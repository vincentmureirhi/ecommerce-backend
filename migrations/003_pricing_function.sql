BEGIN;

CREATE OR REPLACE FUNCTION get_product_unit_price(
  p_product_id BIGINT,
  p_qty INTEGER
)
RETURNS NUMERIC(12,2)
LANGUAGE plpgsql
AS $$
DECLARE
  v_requires_manual_price BOOLEAN;
  v_retail_price NUMERIC(12,2);
  v_wholesale_price NUMERIC(12,2);
  v_min_qty_wholesale INTEGER;
  v_tier_price NUMERIC(12,2);
BEGIN
  IF p_qty IS NULL OR p_qty < 1 THEN
    RAISE EXCEPTION 'Quantity must be >= 1';
  END IF;

  SELECT requires_manual_price, retail_price, wholesale_price, min_qty_wholesale
    INTO v_requires_manual_price, v_retail_price, v_wholesale_price, v_min_qty_wholesale
  FROM products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id;
  END IF;

  IF v_requires_manual_price THEN
    RETURN NULL;
  END IF;

  SELECT ppt.unit_price
    INTO v_tier_price
  FROM product_price_tiers ppt
  WHERE ppt.product_id = p_product_id
    AND p_qty >= ppt.min_qty
    AND (ppt.max_qty IS NULL OR p_qty <= ppt.max_qty)
  ORDER BY ppt.min_qty DESC
  LIMIT 1;

  IF v_tier_price IS NOT NULL THEN
    RETURN v_tier_price;
  END IF;

  IF v_wholesale_price IS NOT NULL
     AND v_min_qty_wholesale IS NOT NULL
     AND p_qty >= v_min_qty_wholesale THEN
    RETURN v_wholesale_price;
  END IF;

  IF v_retail_price IS NOT NULL THEN
    RETURN v_retail_price;
  END IF;

  RETURN NULL;
END;
$$;

COMMIT;