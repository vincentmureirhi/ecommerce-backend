BEGIN;

-- Per product valuation
CREATE OR REPLACE VIEW v_inventory_products AS
SELECT
  p.id AS product_id,
  p.name AS product_name,
  p.sku,
  p.current_stock,
  p.cost_price,
  p.retail_price,
  p.wholesale_price,
  p.min_qty_wholesale,
  p.requires_manual_price,
  p.image_url,
  p.category_id,
  c.name AS category_name,
  p.department_id,
  d.name AS department_name,
  -- Value of stock at cost
  COALESCE(p.current_stock,0) * COALESCE(p.cost_price,0) AS stock_value_cost,
  -- Potential revenue at retail (null if no retail price)
  CASE WHEN p.retail_price IS NULL THEN NULL
       ELSE COALESCE(p.current_stock,0) * p.retail_price
  END AS stock_value_retail,
  -- Potential profit at retail (null if missing retail or cost)
  CASE WHEN p.retail_price IS NULL OR p.cost_price IS NULL THEN NULL
       ELSE COALESCE(p.current_stock,0) * (p.retail_price - p.cost_price)
  END AS stock_profit_retail
FROM products p
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN departments d ON d.id = p.department_id;

-- Summary by category
CREATE OR REPLACE VIEW v_inventory_by_category AS
SELECT
  category_id,
  category_name,
  SUM(stock_value_cost) AS stock_value_cost,
  SUM(stock_value_retail) AS stock_value_retail,
  SUM(stock_profit_retail) AS stock_profit_retail,
  SUM(current_stock) AS total_units
FROM v_inventory_products
GROUP BY category_id, category_name;

-- Summary by department
CREATE OR REPLACE VIEW v_inventory_by_department AS
SELECT
  department_id,
  department_name,
  SUM(stock_value_cost) AS stock_value_cost,
  SUM(stock_value_retail) AS stock_value_retail,
  SUM(stock_profit_retail) AS stock_profit_retail,
  SUM(current_stock) AS total_units
FROM v_inventory_products
GROUP BY department_id, department_name;

-- Overall summary
CREATE OR REPLACE VIEW v_inventory_summary AS
SELECT
  SUM(stock_value_cost) AS stock_value_cost,
  SUM(stock_value_retail) AS stock_value_retail,
  SUM(stock_profit_retail) AS stock_profit_retail,
  SUM(current_stock) AS total_units
FROM v_inventory_products;

COMMIT;