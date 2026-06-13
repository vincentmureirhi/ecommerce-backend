"use strict";

const pool = require("../config/database");
const { handleError, handleSuccess } = require("../utils/errorHandler");
const Decimal = require("decimal.js");

function toInt(v, field, { allowNull = false } = {}) {
  if (v == null || v === "") {
    if (allowNull) return null;
    throw new Error(`${field} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${field} must be an integer >= 0`);
  return n;
}

function toMoney(v, field, { allowNull = false } = {}) {
  if (v == null || v === "") {
    if (allowNull) return null;
    throw new Error(`${field} is required`);
  }
  const d = new Decimal(v);
  if (!d.isFinite() || d.lt(0)) throw new Error(`${field} must be a number >= 0`);
  return d.toDecimalPlaces(2);
}

function toPositiveInt(v, field, fallback = 1) {
  const value = v == null || v === '' ? fallback : v;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${field} must be an integer >= 1`);
  return n;
}

function cleanSellingUnit(value) {
  const text = String(value || '').trim();
  return text || 'piece';
}

function cleanOptionalText(value) {
  const text = String(value || '').trim();
  return text || null;
}

const STOCK_STATUS_OPTIONS = new Set(['in_stock', 'limited_stock', 'out_of_stock']);

function cleanStockStatusOverride(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (!STOCK_STATUS_OPTIONS.has(text)) {
    throw new Error('stock_status_override must be in_stock, limited_stock, or out_of_stock');
  }
  return text;
}

function normalizeStockForStatus(currentStock, stockStatusOverride) {
  if (stockStatusOverride === 'out_of_stock') return 0;
  if (stockStatusOverride && currentStock <= 0) {
    throw new Error('Current stock must be greater than 0 for in-stock or limited-stock products');
  }
  return currentStock;
}

function buildAutoSkuThresholdRuleName(productName) {
  return `Wholesale threshold - ${productName}`;
}

async function createAutoSkuThresholdRule(client, productName, minQtyWholesale) {
  const ruleName = buildAutoSkuThresholdRuleName(productName);
  const r = await client.query(
    `
    INSERT INTO pricing_rules (name, description, rule_type, threshold_qty, is_active)
    VALUES ($1, $2, 'SKU_THRESHOLD', $3, TRUE)
    RETURNING id
    `,
    [
      ruleName,
      `Auto-generated wholesale threshold rule for ${productName}`,
      minQtyWholesale,
    ]
  );
  return r.rows[0].id;
}

const getAllProducts = async (req, res) => {
  try {
    const {
      search,
      q,
      category,
      min,
      max,
      sort,
      flash,
    } = req.query;
    const params = [];
    const where = ['1=1'];

    const searchText = String(search || q || '').trim();
    if (searchText) {
      params.push(`%${searchText}%`);
      const idx = params.length;
      where.push(`(
        p.name ILIKE $${idx}
        OR p.sku ILIKE $${idx}
        OR COALESCE(p.description, '') ILIKE $${idx}
        OR COALESCE(c.name, '') ILIKE $${idx}
        OR COALESCE(d.name, '') ILIKE $${idx}
      )`);
    }

    if (category && category !== 'all') {
      const categoryId = Number(category);
      if (Number.isInteger(categoryId) && categoryId > 0) {
        params.push(categoryId);
        where.push(`p.category_id = $${params.length}`);
      }
    }

    const priceExpression = `COALESCE(active_flash_sale.discounted_price, p.retail_price, p.wholesale_price, 0)`;

    if (min !== undefined && min !== '') {
      const minPrice = Number(min);
      if (Number.isFinite(minPrice) && minPrice >= 0) {
        params.push(minPrice);
        where.push(`${priceExpression} >= $${params.length}`);
      }
    }

    if (max !== undefined && max !== '') {
      const maxPrice = Number(max);
      if (Number.isFinite(maxPrice) && maxPrice >= 0) {
        params.push(maxPrice);
        where.push(`${priceExpression} <= $${params.length}`);
      }
    }

    if (flash === '1' || flash === 'true') {
      where.push('active_flash_sale.id IS NOT NULL');
    }

    const orderBy = (() => {
      switch (String(sort || '').toLowerCase()) {
        case 'price-asc':
          return `${priceExpression} ASC, p.name ASC`;
        case 'price-desc':
          return `${priceExpression} DESC, p.name ASC`;
        case 'name-asc':
          return 'p.name ASC, p.id DESC';
        case 'name-desc':
          return 'p.name DESC, p.id DESC';
        default:
          return `
            CASE
              WHEN active_flash_sale.id IS NOT NULL THEN 0
              WHEN COALESCE(NULLIF(p.stock_status_override, ''), '') = 'limited_stock' THEN 1
              ELSE 2
            END ASC,
            p.id DESC
          `;
      }
    })();

    const r = await pool.query(`
      SELECT
        p.*,
        COALESCE(NULLIF(p.stock_status_override, ''), CASE
          WHEN COALESCE(p.current_stock, 0) <= 0 THEN 'out_of_stock'
          WHEN COALESCE(p.current_stock, 0) <= GREATEST(COALESCE(p.min_order_qty, 1), COALESCE(p.reorder_level, 10), 10) THEN 'limited_stock'
          ELSE 'in_stock'
        END) AS stock_status,
        c.name AS category_name,
        d.name AS department_name,
        active_flash_sale.id AS flash_sale_id,
        active_flash_sale.name AS flash_sale_name,
        active_flash_sale.discount_type,
        active_flash_sale.discount_value,
        active_flash_sale.start_date AS flash_sale_start_date,
        active_flash_sale.end_date AS flash_sale_end_date,
        active_flash_sale.discounted_price AS discounted_price,
        (active_flash_sale.id IS NOT NULL) AS is_flash,

        COALESCE(pt.price_tiers, '[]'::json) AS price_tiers,
        pr.rule_type AS pricing_rule_type,
        pr.name AS pricing_rule_name,
        pr.threshold_qty AS wholesale_threshold_qty,
        pr.pricing_group_id,
        pg.name AS pricing_group_name

      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN departments d ON d.id = p.department_id
      LEFT JOIN LATERAL (
        SELECT
          fs.id,
          fs.name,
          fs.discount_type,
          fs.discount_value,
          fs.start_date,
          fs.end_date,
          CASE
            WHEN fs.discount_type = 'percentage'
              THEN ROUND((p.retail_price * (1 - fs.discount_value / 100.0))::numeric, 2)
            WHEN fs.discount_type = 'fixed'
              THEN GREATEST((p.retail_price - fs.discount_value)::numeric, 0)
            ELSE NULL
          END AS discounted_price
        FROM flash_sale_products fsp
        JOIN flash_sales fs
          ON fs.id = fsp.flash_sale_id
        WHERE fsp.product_id = p.id
          AND fs.is_active = TRUE
          AND fs.start_date <= NOW()
          AND fs.end_date >= NOW()
        ORDER BY discounted_price ASC NULLS LAST, fs.end_date ASC, fs.id ASC
        LIMIT 1
      ) active_flash_sale ON TRUE

      LEFT JOIN (
        SELECT
          product_id,
          json_agg(
            json_build_object(
              'id', id,
              'min_qty', min_qty,
              'max_qty', max_qty,
              'unit_price', unit_price
            )
            ORDER BY min_qty ASC
          ) AS price_tiers
        FROM product_price_tiers
        GROUP BY product_id
      ) pt ON pt.product_id = p.id
      LEFT JOIN pricing_rules pr ON pr.id = p.pricing_rule_id
      LEFT JOIN pricing_groups pg ON pg.id = pr.pricing_group_id

      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
    `, params);
    return handleSuccess(res, 200, "Products retrieved", r.rows);
  } catch (err) {
    return handleError(res, 500, "Failed to retrieve products", err);
  }
};

const getProductById = async (req, res) => {
  try {
    const id = toInt(req.params.id, "id");
    const r = await pool.query(
      `
      SELECT
        p.*,
        COALESCE(NULLIF(p.stock_status_override, ''), CASE
          WHEN COALESCE(p.current_stock, 0) <= 0 THEN 'out_of_stock'
          WHEN COALESCE(p.current_stock, 0) <= GREATEST(COALESCE(p.min_order_qty, 1), COALESCE(p.reorder_level, 10), 10) THEN 'limited_stock'
          ELSE 'in_stock'
        END) AS stock_status,
        c.name AS category_name,
        d.name AS department_name,
        active_flash_sale.id AS flash_sale_id,
        active_flash_sale.name AS flash_sale_name,
        active_flash_sale.discount_type,
        active_flash_sale.discount_value,
        active_flash_sale.start_date AS flash_sale_start_date,
        active_flash_sale.end_date AS flash_sale_end_date,
        active_flash_sale.discounted_price AS discounted_price,
        (active_flash_sale.id IS NOT NULL) AS is_flash,

        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', ppt.id,
                'min_qty', ppt.min_qty,
                'max_qty', ppt.max_qty,
                'unit_price', ppt.unit_price
              )
              ORDER BY ppt.min_qty ASC
            )
            FROM product_price_tiers ppt
            WHERE ppt.product_id = p.id
          ),
          '[]'::json
        ) AS price_tiers,
        pr.rule_type AS pricing_rule_type,
        pr.name AS pricing_rule_name,
        pr.threshold_qty AS wholesale_threshold_qty,
        pr.pricing_group_id,
        pg.name AS pricing_group_name

      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN departments d ON d.id = p.department_id
      LEFT JOIN LATERAL (
        SELECT
          fs.id,
          fs.name,
          fs.discount_type,
          fs.discount_value,
          fs.start_date,
          fs.end_date,
          CASE
            WHEN fs.discount_type = 'percentage'
              THEN ROUND((p.retail_price * (1 - fs.discount_value / 100.0))::numeric, 2)
            WHEN fs.discount_type = 'fixed'
              THEN GREATEST((p.retail_price - fs.discount_value)::numeric, 0)
            ELSE NULL
          END AS discounted_price
        FROM flash_sale_products fsp
        JOIN flash_sales fs
          ON fs.id = fsp.flash_sale_id
        WHERE fsp.product_id = p.id
          AND fs.is_active = TRUE
          AND fs.start_date <= NOW()
          AND fs.end_date >= NOW()
        ORDER BY discounted_price ASC NULLS LAST, fs.end_date ASC, fs.id ASC
        LIMIT 1
      ) active_flash_sale ON TRUE
      LEFT JOIN pricing_rules pr ON pr.id = p.pricing_rule_id
      LEFT JOIN pricing_groups pg ON pg.id = pr.pricing_group_id
      WHERE p.id = $1
      `,
      [id]
    );
    if (r.rowCount === 0) return handleError(res, 404, "Product not found");
    return handleSuccess(res, 200, "Product retrieved", r.rows[0]);
  } catch (err) {
    return handleError(res, 500, "Failed to retrieve product", err);
  }
};

const createProduct = async (req, res) => {
  let client;
  try {
    const name = String(req.body.name || "").trim();
    const sku = String(req.body.sku || "").trim();
    if (!name) return handleError(res, 400, "name is required");
    if (!sku) return handleError(res, 400, "sku is required");

    const description = cleanOptionalText(req.body.description);
    const barcode = cleanOptionalText(req.body.barcode);
    const category_id = toInt(req.body.category_id, "category_id");
    const department_id = toInt(req.body.department_id, "department_id", { allowNull: true });
    const stock_status_override = cleanStockStatusOverride(
      req.body.stock_status_override ?? req.body.stock_status
    );
    const current_stock = normalizeStockForStatus(
      toInt(req.body.current_stock ?? 0, "current_stock"),
      stock_status_override
    );
    const requires_manual_price = Boolean(req.body.requires_manual_price);

    const image_url = req.body.image_url ? String(req.body.image_url).trim() : null;
    const min_order_qty = toPositiveInt(req.body.min_order_qty, 'min_order_qty', 1);
    const order_qty_step = toPositiveInt(req.body.order_qty_step, 'order_qty_step', 1);
    const selling_unit_label = cleanSellingUnit(req.body.selling_unit_label);
    const reorder_level = toInt(req.body.reorder_level ?? 10, 'reorder_level');
    const is_combo_eligible = req.body.is_combo_eligible === true;
    const is_active = req.body.is_active !== false;

    // Profit calculation needs cost_price even if manual pricing product
    const cost_price = toMoney(req.body.cost_price, "cost_price", { allowNull: true });

    const pricing_rule_id = toInt(
      req.body.pricing_rule_id,
      "pricing_rule_id",
      { allowNull: true }
    );

    let retail_price = null;
    let wholesale_price = null;
    let min_qty_wholesale = null;

    if (!requires_manual_price) {
      retail_price = toMoney(req.body.retail_price, "retail_price");
      wholesale_price = toMoney(req.body.wholesale_price, "wholesale_price", { allowNull: true });
      min_qty_wholesale = toInt(req.body.min_qty_wholesale, "min_qty_wholesale", { allowNull: true });
    }

    const hasWholesaleConfig = wholesale_price != null && min_qty_wholesale != null;

    client = await pool.connect();
    await client.query("BEGIN");

    let linkedPricingRuleId = pricing_rule_id;
    if (linkedPricingRuleId == null && hasWholesaleConfig) {
      linkedPricingRuleId = await createAutoSkuThresholdRule(client, name, min_qty_wholesale);
    }

    const r = await client.query(
      `
      INSERT INTO products (
        name, description, sku, barcode, category_id, department_id,
        current_stock, stock_status_override, cost_price,
        retail_price, wholesale_price, min_qty_wholesale,
        requires_manual_price, image_url, pricing_rule_id,
        min_order_qty, order_qty_step, selling_unit_label,
        reorder_level, is_combo_eligible, is_active
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *
      `,
      [
        name,
        description,
        sku,
        barcode,
        category_id,
        department_id,
        current_stock,
        stock_status_override,
        cost_price ? cost_price.toFixed(2) : null,
        retail_price ? retail_price.toFixed(2) : null,
        wholesale_price ? wholesale_price.toFixed(2) : null,
        min_qty_wholesale,
        requires_manual_price,
        image_url,
        linkedPricingRuleId,
        min_order_qty,
        order_qty_step,
        selling_unit_label,
        reorder_level,
        is_combo_eligible,
        is_active,
      ]
    );

    await client.query("COMMIT");

    return handleSuccess(res, 201, "Product created", r.rows[0]);
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    return handleError(res, 500, "Failed to create product", err);
  } finally {
    if (client) client.release();
  }
};

const updateProduct = async (req, res) => {
  let client;
  try {
    const id = toInt(req.params.id, "id");

    const name = String(req.body.name || "").trim();
    const sku = String(req.body.sku || "").trim();
    if (!name) return handleError(res, 400, "name is required");
    if (!sku) return handleError(res, 400, "sku is required");

    const description = cleanOptionalText(req.body.description);
    const barcode = cleanOptionalText(req.body.barcode);
    const category_id = toInt(req.body.category_id, "category_id");
    const department_id = toInt(req.body.department_id, "department_id", { allowNull: true });
    const stock_status_override = cleanStockStatusOverride(
      req.body.stock_status_override ?? req.body.stock_status
    );
    const current_stock = normalizeStockForStatus(
      toInt(req.body.current_stock ?? 0, "current_stock"),
      stock_status_override
    );
    const requires_manual_price = Boolean(req.body.requires_manual_price);

    const image_url = req.body.image_url ? String(req.body.image_url).trim() : null;
    const min_order_qty = toPositiveInt(req.body.min_order_qty, 'min_order_qty', 1);
    const order_qty_step = toPositiveInt(req.body.order_qty_step, 'order_qty_step', 1);
    const selling_unit_label = cleanSellingUnit(req.body.selling_unit_label);
    const reorder_level = toInt(req.body.reorder_level ?? 10, 'reorder_level');
    const is_combo_eligible = req.body.is_combo_eligible === true;
    const is_active = req.body.is_active !== false;
    const cost_price = toMoney(req.body.cost_price, "cost_price", { allowNull: true });

    const hasExplicitPricingRuleId = Object.prototype.hasOwnProperty.call(req.body, "pricing_rule_id");
    const explicitPricingRuleId = hasExplicitPricingRuleId
      ? toInt(req.body.pricing_rule_id, "pricing_rule_id", { allowNull: true })
      : null;

    let retail_price = null;
    let wholesale_price = null;
    let min_qty_wholesale = null;

    if (!requires_manual_price) {
      retail_price = toMoney(req.body.retail_price, "retail_price");
      wholesale_price = toMoney(req.body.wholesale_price, "wholesale_price", { allowNull: true });
      min_qty_wholesale = toInt(req.body.min_qty_wholesale, "min_qty_wholesale", { allowNull: true });
    }

    const hasWholesaleConfig = wholesale_price != null && min_qty_wholesale != null;

    client = await pool.connect();
    await client.query("BEGIN");

    const existingProduct = await client.query(
      `SELECT pricing_rule_id FROM products WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (existingProduct.rowCount === 0) {
      await client.query("ROLLBACK");
      return handleError(res, 404, "Product not found");
    }

    let linkedPricingRuleId = hasExplicitPricingRuleId
      ? explicitPricingRuleId
      : existingProduct.rows[0].pricing_rule_id;

    if (!hasExplicitPricingRuleId && hasWholesaleConfig) {
      if (linkedPricingRuleId == null) {
        linkedPricingRuleId = await createAutoSkuThresholdRule(client, name, min_qty_wholesale);
      } else {
        const linkedRule = await client.query(
          `SELECT id, rule_type FROM pricing_rules WHERE id = $1 FOR UPDATE`,
          [linkedPricingRuleId]
        );

        if (linkedRule.rowCount > 0 && linkedRule.rows[0].rule_type === "SKU_THRESHOLD") {
          await client.query(
            `
            UPDATE pricing_rules
            SET name = $1, threshold_qty = $2, updated_at = NOW()
            WHERE id = $3
            `,
            [
              buildAutoSkuThresholdRuleName(name),
              min_qty_wholesale,
              linkedPricingRuleId,
            ]
          );
        }
      }
    }

    const r = await client.query(
      `
      UPDATE products
      SET
        name=$1,
        description=$2,
        sku=$3,
        barcode=$4,
        category_id=$5,
        department_id=$6,
        current_stock=$7,
        stock_status_override=$8,
        cost_price=$9,
        retail_price=$10,
        wholesale_price=$11,
        min_qty_wholesale=$12,
        requires_manual_price=$13,
        image_url=$14,
        pricing_rule_id=$15,
        min_order_qty=$16,
        order_qty_step=$17,
        selling_unit_label=$18,
        reorder_level=$19,
        is_combo_eligible=$20,
        is_active=$21,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=$22
      RETURNING *
      `,
      [
        name,
        description,
        sku,
        barcode,
        category_id,
        department_id,
        current_stock,
        stock_status_override,
        cost_price ? cost_price.toFixed(2) : null,
        retail_price ? retail_price.toFixed(2) : null,
        wholesale_price ? wholesale_price.toFixed(2) : null,
        min_qty_wholesale,
        requires_manual_price,
        image_url,
        linkedPricingRuleId,
        min_order_qty,
        order_qty_step,
        selling_unit_label,
        reorder_level,
        is_combo_eligible,
        is_active,
        id,
      ]
    );

    await client.query("COMMIT");

    return handleSuccess(res, 200, "Product updated", r.rows[0]);
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    return handleError(res, 500, "Failed to update product", err);
  } finally {
    if (client) client.release();
  }
};

const deleteProduct = async (req, res) => {
  try {
    const id = toInt(req.params.id, "id");
    const r = await pool.query("DELETE FROM products WHERE id=$1", [id]);
    if (r.rowCount === 0) return handleError(res, 404, "Product not found");
    return handleSuccess(res, 200, "Product deleted");
  } catch (err) {
    return handleError(res, 500, "Failed to delete product", err);
  }
};

// If you already have these routes, keep them simple:
const getOutOfStockProducts = async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        *,
        COALESCE(NULLIF(stock_status_override, ''), 'out_of_stock') AS stock_status
      FROM products
      WHERE
        COALESCE(is_active, TRUE) = TRUE
        AND (
          COALESCE(current_stock, 0) <= 0
          OR stock_status_override = 'out_of_stock'
        )
      ORDER BY id DESC
    `);
    return handleSuccess(res, 200, "Out of stock products", r.rows);
  } catch (err) {
    return handleError(res, 500, "Failed to retrieve out of stock products", err);
  }
};

const getLowStockProducts = async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        *,
        COALESCE(NULLIF(stock_status_override, ''), 'limited_stock') AS stock_status
      FROM products
      WHERE
        COALESCE(is_active, TRUE) = TRUE
        AND COALESCE(current_stock, 0) > 0
        AND (
          stock_status_override = 'limited_stock'
          OR COALESCE(current_stock, 0) <= GREATEST(COALESCE(min_order_qty, 1), COALESCE(reorder_level, 10), 10)
        )
      ORDER BY current_stock ASC, id DESC
    `);
    return handleSuccess(res, 200, "Low stock products", r.rows);
  } catch (err) {
    return handleError(res, 500, "Failed to retrieve low stock products", err);
  }
};

module.exports = {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  getOutOfStockProducts,
  getLowStockProducts,
};
