'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const Decimal = require('decimal.js');

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getStockStatus(currentStock, reorderLevel) {
  if (currentStock <= 0) return 'out_of_stock';
  if (reorderLevel > 0 && currentStock <= reorderLevel) return 'reorder_now';
  if (currentStock <= 10) return 'low_stock';
  return 'healthy';
}

function getMovementStatus({ totalUnitsSold, unitsSold7d, unitsSold30d, daysSinceLastSale }) {
  if (totalUnitsSold === 0 || daysSinceLastSale === null || daysSinceLastSale >= 60) {
    return 'dead_stock';
  }

  if (unitsSold7d >= 10 || unitsSold30d >= 30) {
    return 'fast_moving';
  }

  if (daysSinceLastSale >= 30 || unitsSold30d < 5) {
    return 'slow_moving';
  }

  return 'steady';
}

const getInventoryAnalytics = async (req, res) => {
  try {
    const { profit_type = 'retail' } = req.query;

    if (!['retail', 'wholesale'].includes(profit_type)) {
      return handleError(res, 400, 'profit_type must be "retail" or "wholesale"');
    }

    const result = await pool.query(`
      WITH sales_7d AS (
        SELECT
          oi.product_id,
          COALESCE(SUM(oi.quantity), 0) AS units_sold_7d
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at >= NOW() - INTERVAL '7 days'
        GROUP BY oi.product_id
      ),
      sales_30d AS (
        SELECT
          oi.product_id,
          COALESCE(SUM(oi.quantity), 0) AS units_sold_30d
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at >= NOW() - INTERVAL '30 days'
        GROUP BY oi.product_id
      ),
      all_sales AS (
        SELECT
          oi.product_id,
          COALESCE(SUM(oi.quantity), 0) AS total_units_sold,
          MAX(o.created_at) AS last_sale_date
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        GROUP BY oi.product_id
      ),
      last_sale AS (
        SELECT DISTINCT ON (oi.product_id)
          oi.product_id,
          o.id AS order_id,
          o.order_number,
          o.created_at AS last_sale_date,
          oi.quantity AS last_sale_qty,
          sr.name AS sales_rep_name,
          c.name AS customer_name,
          c.customer_type,
          l.name AS location_name,
          r.name AS region_name
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN sales_reps sr ON sr.id = o.sales_rep_id
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN locations l ON l.id = c.location_id
        LEFT JOIN regions r ON r.id = l.region_id
        ORDER BY oi.product_id, o.created_at DESC, oi.id DESC
      )
      SELECT
        p.id,
        p.name,
        p.sku,
        COALESCE(p.current_stock, 0) AS current_stock,
        COALESCE(p.reorder_level, 0) AS reorder_level,
        COALESCE(p.cost_price, 0) AS cost_price,
        COALESCE(p.retail_price, 0) AS retail_price,
        COALESCE(p.wholesale_price, 0) AS wholesale_price,
        c.id AS category_id,
        c.name AS category_name,
        d.id AS supplier_id,
        d.name AS supplier_name,
        COALESCE(s7.units_sold_7d, 0) AS units_sold_7d,
        COALESCE(s30.units_sold_30d, 0) AS units_sold_30d,
        COALESCE(a.total_units_sold, 0) AS total_units_sold,
        a.last_sale_date,
        ls.last_sale_qty,
        ls.sales_rep_name AS last_sold_by_name,
        ls.customer_name AS last_customer_name,
        CASE
          WHEN ls.customer_type = 'route' THEN 'region_customer'
          WHEN ls.customer_type = 'normal' THEN 'normal_customer'
          WHEN ls.last_sale_date IS NOT NULL THEN 'unknown'
          ELSE NULL
        END AS last_sale_channel,
        ls.location_name AS last_sale_location,
        ls.region_name AS last_sale_region,
        (COALESCE(p.current_stock, 0) * COALESCE(p.cost_price, 0))::numeric(14,2) AS stock_value
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN departments d ON d.id = p.department_id
      LEFT JOIN sales_7d s7 ON s7.product_id = p.id
      LEFT JOIN sales_30d s30 ON s30.product_id = p.id
      LEFT JOIN all_sales a ON a.product_id = p.id
      LEFT JOIN last_sale ls ON ls.product_id = p.id
      ORDER BY p.name ASC
    `);

    const rawProducts = result.rows;

    const analytics = {
      summary: {
        total_skus: 0,
        total_units_in_stock: 0,
        stock_value: '0.00',
        estimated_retail_value: '0.00',
        total_units_sold_7d: 0,
        total_units_sold_30d: 0,
        low_stock_count: 0,
        out_of_stock_count: 0,
        dead_stock_count: 0,
        reorder_now_count: 0,
        total_potential_profit: '0.00',
        profit_by_type: profit_type,
      },
      products: [],
      best_sellers: [],
      slow_moving: [],
      categories: [],
      suppliers: [],
    };

    let totalStockValue = new Decimal(0);
    let totalRetailValue = new Decimal(0);
    let totalPotentialProfit = new Decimal(0);

    for (const p of rawProducts) {
      const currentStock = toNumber(p.current_stock);
      const reorderLevel = toNumber(p.reorder_level);
      const costPrice = new Decimal(p.cost_price || 0);
      const retailPrice = new Decimal(p.retail_price || 0);
      const wholesalePrice = new Decimal(p.wholesale_price || 0);
      const unitsSold7d = toNumber(p.units_sold_7d);
      const unitsSold30d = toNumber(p.units_sold_30d);
      const totalUnitsSold = toNumber(p.total_units_sold);

      const lastSaleDate = p.last_sale_date ? new Date(p.last_sale_date) : null;
      const daysSinceLastSale = lastSaleDate
        ? Math.floor((Date.now() - lastSaleDate.getTime()) / (1000 * 60 * 60 * 24))
        : null;

      const stockStatus = getStockStatus(currentStock, reorderLevel);
      const movementStatus = getMovementStatus({
        totalUnitsSold,
        unitsSold7d,
        unitsSold30d,
        daysSinceLastSale,
      });

      const stockValue = costPrice.times(currentStock);
      const retailValue = retailPrice.times(currentStock);
      const comparisonPrice = profit_type === 'retail' ? retailPrice : wholesalePrice;
      const potentialProfit = comparisonPrice.minus(costPrice).times(currentStock);

      totalStockValue = totalStockValue.plus(stockValue);
      totalRetailValue = totalRetailValue.plus(retailValue);
      totalPotentialProfit = totalPotentialProfit.plus(potentialProfit);

      analytics.summary.total_skus += 1;
      analytics.summary.total_units_in_stock += currentStock;
      analytics.summary.total_units_sold_7d += unitsSold7d;
      analytics.summary.total_units_sold_30d += unitsSold30d;

      if (stockStatus === 'low_stock') analytics.summary.low_stock_count += 1;
      if (stockStatus === 'out_of_stock') analytics.summary.out_of_stock_count += 1;
      if (stockStatus === 'reorder_now') analytics.summary.reorder_now_count += 1;
      if (movementStatus === 'dead_stock') analytics.summary.dead_stock_count += 1;

      analytics.products.push({
        id: p.id,
        product_name: p.name,
        sku: p.sku,
        category_id: p.category_id,
        category_name: p.category_name || 'Uncategorized',
        supplier_id: p.supplier_id,
        supplier_name: p.supplier_name || 'Unassigned',
        current_stock: currentStock,
        reorder_level: reorderLevel,
        cost_price: costPrice.toFixed(2),
        retail_price: retailPrice.toFixed(2),
        wholesale_price: wholesalePrice.toFixed(2),
        stock_value: stockValue.toFixed(2),
        retail_value: retailValue.toFixed(2),
        units_sold_7d: unitsSold7d,
        units_sold_30d: unitsSold30d,
        total_units_sold: totalUnitsSold,
        last_sale_date: p.last_sale_date,
        days_since_last_sale: daysSinceLastSale,
        last_sale_qty: toNumber(p.last_sale_qty, null),
        last_sold_by_name: p.last_sold_by_name || null,
        last_customer_name: p.last_customer_name || null,
        last_sale_channel: p.last_sale_channel || null,
        last_sale_location: p.last_sale_location || null,
        last_sale_region: p.last_sale_region || null,
        stock_status: stockStatus,
        movement_status: movementStatus,
        potential_profit: potentialProfit.toFixed(2),
      });
    }

    analytics.summary.stock_value = totalStockValue.toFixed(2);
    analytics.summary.estimated_retail_value = totalRetailValue.toFixed(2);
    analytics.summary.total_potential_profit = totalPotentialProfit.toFixed(2);

    analytics.best_sellers = [...analytics.products]
      .filter((p) => p.units_sold_30d > 0)
      .sort((a, b) => {
        if (b.units_sold_30d !== a.units_sold_30d) return b.units_sold_30d - a.units_sold_30d;
        return b.units_sold_7d - a.units_sold_7d;
      })
      .slice(0, 8);

    analytics.slow_moving = [...analytics.products]
      .filter((p) => p.movement_status === 'slow_moving' || p.movement_status === 'dead_stock')
      .sort((a, b) => {
        const aDays = a.days_since_last_sale ?? 99999;
        const bDays = b.days_since_last_sale ?? 99999;
        return bDays - aDays;
      })
      .slice(0, 8);

    analytics.categories = [...new Map(
      analytics.products
        .filter((p) => p.category_id)
        .map((p) => [p.category_id, { id: p.category_id, name: p.category_name }])
    ).values()];

    analytics.suppliers = [...new Map(
      analytics.products
        .filter((p) => p.supplier_id)
        .map((p) => [p.supplier_id, { id: p.supplier_id, name: p.supplier_name }])
    ).values()];

    return handleSuccess(res, 200, 'Inventory analytics retrieved', analytics);
  } catch (err) {
    console.error('Inventory analytics error:', err);
    return handleError(res, 500, 'Failed to retrieve inventory analytics', err);
  }
};

const updateInventoryReorderLevel = async (req, res) => {
  try {
    const { id } = req.params;
    const { reorder_level } = req.body;

    if (reorder_level === undefined || reorder_level === null || reorder_level === '') {
      return handleError(res, 400, 'reorder_level is required');
    }

    const parsedReorderLevel = Number(reorder_level);

    if (!Number.isInteger(parsedReorderLevel) || parsedReorderLevel < 0) {
      return handleError(res, 400, 'reorder_level must be a non-negative integer');
    }

    const result = await pool.query(
      `
      UPDATE products
      SET reorder_level = $1
      WHERE id = $2
      RETURNING id, name, sku, reorder_level
      `,
      [parsedReorderLevel, id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Product not found');
    }

    return handleSuccess(res, 200, 'Reorder level updated successfully', result.rows[0]);
  } catch (err) {
    console.error('Update reorder level error:', err);
    return handleError(res, 500, 'Failed to update reorder level', err);
  }
};

module.exports = {
  getInventoryAnalytics,
  updateInventoryReorderLevel,
};