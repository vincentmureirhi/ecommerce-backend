BEGIN;

-- Hair category pricing presets.
--
-- 1) Braids:
--    Any mix of products in braid categories qualifies for wholesale once the
--    combined quantity reaches 12. Each product still uses its own wholesale_price.
--
-- 2) Brazilian wool:
--    Products matching Brazilian/Brazillian wool get one shared tier ladder:
--    1-5 units = KES 100 each, 6+ units = KES 50 each.
--
-- This migration is safe to rerun. It creates or updates the groups/rules,
-- refreshes the wool tiers, and links matching active products by category/name.

DO $$
DECLARE
  v_braids_group_id BIGINT;
  v_braids_rule_id BIGINT;
  v_wool_group_id BIGINT;
  v_wool_rule_id BIGINT;
BEGIN
  SELECT id
    INTO v_braids_group_id
  FROM pricing_groups
  WHERE LOWER(name) = 'braids mix 12'
  ORDER BY id
  LIMIT 1;

  IF v_braids_group_id IS NULL THEN
    INSERT INTO pricing_groups (name, description, is_active)
    VALUES (
      'Braids Mix 12',
      'All braid SKUs can be mixed. Combined quantity 12+ qualifies for each product wholesale price.',
      TRUE
    )
    RETURNING id INTO v_braids_group_id;
  ELSE
    UPDATE pricing_groups
       SET description = 'All braid SKUs can be mixed. Combined quantity 12+ qualifies for each product wholesale price.',
           is_active = TRUE,
           updated_at = NOW()
     WHERE id = v_braids_group_id;
  END IF;

  SELECT id
    INTO v_braids_rule_id
  FROM pricing_rules
  WHERE LOWER(name) = 'braids mix 12 wholesale'
  ORDER BY id
  LIMIT 1;

  IF v_braids_rule_id IS NULL THEN
    INSERT INTO pricing_rules (name, description, rule_type, threshold_qty, is_active, pricing_group_id)
    VALUES (
      'Braids Mix 12 Wholesale',
      'Wholesale applies when any mixed braid quantity reaches 12 or more.',
      'GROUP_THRESHOLD',
      12,
      TRUE,
      v_braids_group_id
    )
    RETURNING id INTO v_braids_rule_id;
  ELSE
    UPDATE pricing_rules
       SET description = 'Wholesale applies when any mixed braid quantity reaches 12 or more.',
           rule_type = 'GROUP_THRESHOLD',
           threshold_qty = 12,
           is_active = TRUE,
           pricing_group_id = v_braids_group_id,
           updated_at = NOW()
     WHERE id = v_braids_rule_id;
  END IF;

  INSERT INTO pricing_group_products (pricing_group_id, product_id, is_active)
  SELECT v_braids_group_id, p.id, TRUE
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  WHERE p.is_active IS DISTINCT FROM FALSE
    AND (
      LOWER(COALESCE(c.name, '')) LIKE '%braid%'
      OR LOWER(COALESCE(p.name, '')) LIKE '%braid%'
      OR LOWER(COALESCE(p.sku, '')) LIKE '%braid%'
    )
  ON CONFLICT (pricing_group_id, product_id)
  DO UPDATE SET is_active = TRUE, effective_until = NULL;

  UPDATE products p
     SET pricing_rule_id = v_braids_rule_id,
         is_combo_eligible = FALSE,
         updated_at = NOW()
  FROM categories c
  WHERE c.id = p.category_id
    AND p.is_active IS DISTINCT FROM FALSE
    AND (
      LOWER(COALESCE(c.name, '')) LIKE '%braid%'
      OR LOWER(COALESCE(p.name, '')) LIKE '%braid%'
      OR LOWER(COALESCE(p.sku, '')) LIKE '%braid%'
    );

  SELECT id
    INTO v_wool_group_id
  FROM pricing_groups
  WHERE LOWER(name) = 'brazilian wool mix'
     OR LOWER(name) = 'brazillian wool mix'
  ORDER BY id
  LIMIT 1;

  IF v_wool_group_id IS NULL THEN
    INSERT INTO pricing_groups (name, description, is_active)
    VALUES (
      'Brazilian Wool Mix',
      'Brazilian wool SKUs share one quantity ladder: 1-5 at KES 100, 6+ at KES 50.',
      TRUE
    )
    RETURNING id INTO v_wool_group_id;
  ELSE
    UPDATE pricing_groups
       SET name = 'Brazilian Wool Mix',
           description = 'Brazilian wool SKUs share one quantity ladder: 1-5 at KES 100, 6+ at KES 50.',
           is_active = TRUE,
           updated_at = NOW()
     WHERE id = v_wool_group_id;
  END IF;

  SELECT id
    INTO v_wool_rule_id
  FROM pricing_rules
  WHERE LOWER(name) = 'brazilian wool tier ladder'
     OR LOWER(name) = 'brazillian wool tier ladder'
  ORDER BY id
  LIMIT 1;

  IF v_wool_rule_id IS NULL THEN
    INSERT INTO pricing_rules (name, description, rule_type, threshold_qty, is_active, pricing_group_id)
    VALUES (
      'Brazilian Wool Tier Ladder',
      'Combined wool quantity selects the unit price tier.',
      'GROUP_TIERED',
      NULL,
      TRUE,
      v_wool_group_id
    )
    RETURNING id INTO v_wool_rule_id;
  ELSE
    UPDATE pricing_rules
       SET name = 'Brazilian Wool Tier Ladder',
           description = 'Combined wool quantity selects the unit price tier.',
           rule_type = 'GROUP_TIERED',
           threshold_qty = NULL,
           is_active = TRUE,
           pricing_group_id = v_wool_group_id,
           updated_at = NOW()
     WHERE id = v_wool_rule_id;
  END IF;

  DELETE FROM pricing_rule_tiers
  WHERE pricing_rule_id = v_wool_rule_id;

  INSERT INTO pricing_rule_tiers (pricing_rule_id, min_qty, max_qty, unit_price)
  VALUES
    (v_wool_rule_id, 1, 5, 100.00),
    (v_wool_rule_id, 6, NULL, 50.00);

  INSERT INTO pricing_group_products (pricing_group_id, product_id, is_active)
  SELECT v_wool_group_id, p.id, TRUE
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  WHERE p.is_active IS DISTINCT FROM FALSE
    AND (
      LOWER(COALESCE(c.name, '')) LIKE '%brazilian%wool%'
      OR LOWER(COALESCE(c.name, '')) LIKE '%brazillian%wool%'
      OR LOWER(COALESCE(p.name, '')) LIKE '%brazilian%wool%'
      OR LOWER(COALESCE(p.name, '')) LIKE '%brazillian%wool%'
      OR LOWER(COALESCE(p.sku, '')) LIKE '%brazilian%wool%'
      OR LOWER(COALESCE(p.sku, '')) LIKE '%brazillian%wool%'
    )
  ON CONFLICT (pricing_group_id, product_id)
  DO UPDATE SET is_active = TRUE, effective_until = NULL;

  UPDATE products p
     SET pricing_rule_id = v_wool_rule_id,
         is_combo_eligible = FALSE,
         updated_at = NOW()
  FROM categories c
  WHERE c.id = p.category_id
    AND p.is_active IS DISTINCT FROM FALSE
    AND (
      LOWER(COALESCE(c.name, '')) LIKE '%brazilian%wool%'
      OR LOWER(COALESCE(c.name, '')) LIKE '%brazillian%wool%'
      OR LOWER(COALESCE(p.name, '')) LIKE '%brazilian%wool%'
      OR LOWER(COALESCE(p.name, '')) LIKE '%brazillian%wool%'
      OR LOWER(COALESCE(p.sku, '')) LIKE '%brazilian%wool%'
      OR LOWER(COALESCE(p.sku, '')) LIKE '%brazillian%wool%'
    );
END $$;

COMMIT;
