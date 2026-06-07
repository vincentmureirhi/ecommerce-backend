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
    const r = await pool.query(`
      SELECT
       p.*,
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

      ORDER BY p.id DESC
    `);
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

    const category_id = toInt(req.body.category_id, "category_id");
    const department_id = toInt(req.body.department_id, "department_id", { allowNull: true });
    const current_stock = toInt(req.body.current_stock ?? 0, "current_stock");
    const requires_manual_price = Boolean(req.body.requires_manual_price);

    const image_url = req.body.image_url ? String(req.body.image_url).trim() : null;
    const min_order_qty = toPositiveInt(req.body.min_order_qty, 'min_order_qty', 1);
    const order_qty_step = toPositiveInt(req.body.order_qty_step, 'order_qty_step', 1);
    const selling_unit_label = cleanSellingUnit(req.body.selling_unit_label);

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
        name, sku, category_id, department_id,
        current_stock, cost_price,
        retail_price, wholesale_price, min_qty_wholesale,
        requires_manual_price, image_url, pricing_rule_id,
        min_order_qty, order_qty_step, selling_unit_label
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
      `,
      [
        name,
        sku,
        category_id,
        department_id,
        current_stock,
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

    const category_id = toInt(req.body.category_id, "category_id");
    const department_id = toInt(req.body.department_id, "department_id", { allowNull: true });
    const current_stock = toInt(req.body.current_stock ?? 0, "current_stock");
    const requires_manual_price = Boolean(req.body.requires_manual_price);

    const image_url = req.body.image_url ? String(req.body.image_url).trim() : null;
    const min_order_qty = toPositiveInt(req.body.min_order_qty, 'min_order_qty', 1);
    const order_qty_step = toPositiveInt(req.body.order_qty_step, 'order_qty_step', 1);
    const selling_unit_label = cleanSellingUnit(req.body.selling_unit_label);
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
        sku=$2,
        category_id=$3,
        department_id=$4,
        current_stock=$5,
        cost_price=$6,
        retail_price=$7,
        wholesale_price=$8,
        min_qty_wholesale=$9,
        requires_manual_price=$10,
        image_url=$11,
        pricing_rule_id=$12,
        min_order_qty=$13,
        order_qty_step=$14,
        selling_unit_label=$15
      WHERE id=$16
      RETURNING *
      `,
      [
        name,
        sku,
        category_id,
        department_id,
        current_stock,
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
    const r = await pool.query(`SELECT * FROM products WHERE current_stock <= 0 ORDER BY id DESC`);
    return handleSuccess(res, 200, "Out of stock products", r.rows);
  } catch (err) {
    return handleError(res, 500, "Failed to retrieve out of stock products", err);
  }
};

const getLowStockProducts = async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM products WHERE current_stock > 0 AND current_stock <= 10 ORDER BY id DESC`);
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
