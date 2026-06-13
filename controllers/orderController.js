'use strict';

const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const generateOrderNumber = require('../utils/generateOrderNumber');

const { evaluateCartPricingWithMeta } = require('../utils/pricingRuleEvaluator');
const {
  attachOrderTrackingLink,
  verifyOrderTrackingToken,
} = require('../utils/orderTrackingToken');
const { enqueuePaymentConfirmedSms } = require('../services/smsService');
const { broadcastDashboardUpdated } = require('../websocket');

/**
 * Business-rule validation error for order creation.
 * Signals a client-caused violation (e.g. wholesale requested below threshold).
 * Caught in endpoint handlers and mapped to HTTP 422 Unprocessable Entity.
 */
class OrderValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OrderValidationError';
    this.isOrderValidationError = true;
  }
}

/**
 * Validate that a client-declared pricing_mode is compatible with the
 * server-computed wholesale eligibility for the item.  This is the central
 * enforcement point: the backend is the sole pricing authority, and any
 * explicit wholesale request below threshold is rejected with a 422.
 *
 * @param {string|undefined} pricingMode   - client-supplied pricing_mode value
 * @param {Object}           evalItem      - result from evaluateCartPricingWithMeta
 * @param {number}           productId
 * @throws {OrderValidationError} when wholesale is requested but not eligible
 */
function assertWholesaleEligibility(pricingMode, evalItem, productId) {
  if (pricingMode !== 'wholesale') return; // no explicit wholesale intent — nothing to validate

  if (!evalItem.is_wholesale_eligible) {
    const threshold = evalItem.threshold_qty;
    const effective = evalItem.effective_qty;
    const thresholdMsg = threshold != null
      ? `wholesale pricing requires at least ${threshold} unit(s)`
      : 'wholesale pricing is not available for this product';
    throw new OrderValidationError(
      `Wholesale pricing rejected for product ${productId}: ` +
      `${thresholdMsg} (effective quantity: ${effective}). ` +
      `The backend enforces threshold eligibility server-side and cannot grant wholesale pricing below the configured threshold.`
    );
  }
}

function assertProductOrderQuantity(product, quantity) {
  const minOrderQty = Math.max(1, Number(product.min_order_qty || 1));
  const step = Math.max(1, Number(product.order_qty_step || 1));
  const label = product.selling_unit_label || 'piece';

  if (quantity < minOrderQty) {
    throw new OrderValidationError(
      `${product.name || `Product ${product.id}`} must be ordered in at least ${minOrderQty} ${label}${minOrderQty === 1 ? '' : 's'}.`
    );
  }

  if ((quantity - minOrderQty) % step !== 0) {
    throw new OrderValidationError(
      `${product.name || `Product ${product.id}`} must be ordered in steps of ${step} after the minimum of ${minOrderQty}.`
    );
  }
}

async function reserveStockForOrder(client, items) {
  const stockChanges = [];

  for (const item of items) {
    const quantity = Number(item.quantity || 0);
    const result = await client.query(
      `
      UPDATE products
      SET current_stock = COALESCE(current_stock, 0) - $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
        AND COALESCE(current_stock, 0) >= $1
      RETURNING id, name, current_stock
      `,
      [quantity, item.product_id]
    );

    if (result.rowCount === 0) {
      const product = await client.query(
        `SELECT id, name, COALESCE(current_stock, 0) AS current_stock FROM products WHERE id = $1`,
        [item.product_id]
      );
      const row = product.rows[0];
      const available = Number(row?.current_stock || 0);
      const name = row?.name || `Product ${item.product_id}`;
      throw new OrderValidationError(
        `${name} has only ${available} unit${available === 1 ? '' : 's'} available. Reduce the quantity or restock before selling.`
      );
    }

    stockChanges.push({
      product_id: result.rows[0].id,
      product_name: result.rows[0].name,
      quantity_sold: quantity,
      remaining_stock: Number(result.rows[0].current_stock || 0),
    });
  }

  return stockChanges;
}

const VALID_ORDER_TYPES = new Set(['normal', 'route']);
const VALID_ORDER_STATUSES = new Set(['pending', 'processing', 'dispatched', 'completed', 'cancelled']);
const JWT_SECRET = process.env.JWT_SECRET;

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value) {
  return Number(toNumber(value, 0).toFixed(2));
}

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function getPhoneLookupVariants(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const variants = new Set();

  if (digits) variants.add(digits);
  if (digits.length === 9) {
    variants.add(`254${digits}`);
    variants.add(`0${digits}`);
  }
  if (digits.length === 10 && digits.startsWith('0')) {
    variants.add(`254${digits.slice(1)}`);
    variants.add(digits.slice(1));
  }
  if (digits.length === 12 && digits.startsWith('254')) {
    variants.add(`0${digits.slice(3)}`);
    variants.add(digits.slice(3));
  }

  return Array.from(variants).filter(Boolean);
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length <= 4) return digits ? '****' : null;
  return `${'*'.repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

function normalizeAnswerText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMoneyAnswer(value) {
  const cleaned = String(value || '').replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function verifyTrackingRecoveryAnswer(order, verificationType, answer) {
  const type = String(verificationType || '').trim().toLowerCase();
  const value = String(answer || '').trim();

  if (!value) return false;

  if (type === 'total' || type === 'amount' || type === 'order_total') {
    const answerAmount = parseMoneyAnswer(value);
    if (answerAmount == null) return false;

    const total = roundMoney(order.total_amount);
    return Math.abs(roundMoney(answerAmount) - total) <= 1;
  }

  if (type === 'location' || type === 'delivery_area' || type === 'area') {
    const answerText = normalizeAnswerText(value);
    if (answerText.length < 3) return false;

    const locationText = normalizeAnswerText([
      order.delivery_address,
      order.route_area,
      order.notes,
    ].filter(Boolean).join(' '));

    return locationText.length >= 3 && locationText.includes(answerText);
  }

  return false;
}

function normalizeWorkflowType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (!['normal_self_service', 'route_self_service', 'route_sales_rep_capture'].includes(normalized)) {
    return null;
  }
  return normalized;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function deriveRoutePaymentState(totalAmount, amountPaid, dueDate) {
  const total = toNumber(totalAmount, 0);
  const paid = Math.max(0, toNumber(amountPaid, 0));
  const balance = Math.max(total - paid, 0);

  if (total > 0 && balance <= 0) {
    return 'paid';
  }

  let state = paid > 0 ? 'partial' : 'unpaid';

  if (balance > 0 && dueDate) {
    const due = new Date(dueDate);
    const today = new Date();

    due.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);

    if (due < today) {
      state = 'overdue';
    }
  }

  return state;
}

function enrichOrder(order) {
  const totalAmount = toNumber(order.total_amount, 0);
  const amountPaid = Math.max(0, toNumber(order.amount_paid, 0));
  const balanceDue = Math.max(totalAmount - amountPaid, 0);

  const derivedPaymentState =
    order.order_type === 'route'
      ? deriveRoutePaymentState(totalAmount, amountPaid, order.due_date)
      : (order.payment_state || 'unpaid');

  return {
    ...order,
    total_amount: roundMoney(totalAmount),
    amount_paid: roundMoney(amountPaid),
    balance_due: roundMoney(balanceDue),
    payment_state: derivedPaymentState,
    settlement_label:
      order.order_type === 'route'
        ? derivedPaymentState
        : (order.payment_status || 'pending'),
  };
}

function getBearerToken(req) {
  const authHeader = req.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}

async function resolveAuthenticatedSalesRep(req, client) {
  if (!JWT_SECRET) return null;

  const token = getBearerToken(req);
  if (!token) return null;

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }

  if (decoded.token_type !== 'sales_rep' || decoded.role !== 'sales_rep' || !decoded.sales_rep_id) {
    return null;
  }

  const result = await client.query(
    `
    SELECT id, is_active, status, must_change_password
    FROM sales_reps
    WHERE id = $1
    LIMIT 1
    `,
    [decoded.sales_rep_id]
  );

  if (result.rows.length === 0 || !result.rows[0].is_active || result.rows[0].status === 'inactive') {
    throw new OrderValidationError('Sales rep session is invalid or inactive');
  }

  if (result.rows[0].must_change_password) {
    throw new OrderValidationError('Sales rep must change password before capturing orders');
  }

  return result.rows[0];
}

async function fetchValidatedProduct(client, productId) {
  const result = await client.query(
    `
    SELECT
      id,
      name,
      sku,
      retail_price,
      wholesale_price,
      min_qty_wholesale,
      min_order_qty,
      order_qty_step,
      selling_unit_label,
      requires_manual_price,
      current_stock
    FROM products
    WHERE id = $1
    `,
    [productId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Product does not exist: ${productId}`);
  }

  return result.rows[0];
}

async function resolveRouteCustomerForOrder(client, params) {
  const {
    customerId,
    customerName,
    customerPhone,
    salesRepId,
    locationId,
    address,
    routeArea,
    routeNotes,
  } = params;

  if (customerId) {
    const existing = await client.query(
      `
      SELECT id, customer_type, sales_rep_id
      FROM customers
      WHERE id = $1
      `,
      [customerId]
    );

    if (existing.rows.length === 0) {
      throw new OrderValidationError('Customer does not exist');
    }

    if (existing.rows[0].customer_type !== 'route') {
      throw new OrderValidationError('Route orders must use a route customer');
    }

    if (salesRepId && !existing.rows[0].sales_rep_id) {
      await client.query(
        `
        UPDATE customers
        SET sales_rep_id = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        `,
        [salesRepId, customerId]
      );
    }

    return customerId;
  }

  const existingByPhone = await client.query(
    `
    SELECT id
    FROM customers
    WHERE customer_type = 'route'
      AND phone = $1
    ORDER BY id ASC
    LIMIT 1
    `,
    [customerPhone]
  );

  if (existingByPhone.rows.length > 0) {
    const existingId = existingByPhone.rows[0].id;
    await client.query(
      `
      UPDATE customers
      SET
        name = $1,
        sales_rep_id = COALESCE($2, sales_rep_id),
        location_id = COALESCE($3, location_id),
        address = COALESCE($4, address),
        route_area = COALESCE($5, route_area),
        route_notes = COALESCE($6, route_notes),
        is_active = TRUE,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
      `,
      [
        customerName,
        salesRepId || null,
        locationId || null,
        address || null,
        routeArea || null,
        routeNotes || null,
        existingId,
      ]
    );
    return existingId;
  }

  const insertResult = await client.query(
    `
    INSERT INTO customers
    (
      name,
      phone,
      customer_type,
      sales_rep_id,
      location_id,
      address,
      route_area,
      route_notes,
      is_active,
      created_at,
      updated_at
    )
    VALUES ($1, $2, 'route', $3, $4, $5, $6, $7, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING id
    `,
    [
      customerName,
      customerPhone,
      salesRepId || null,
      locationId || null,
      address || null,
      routeArea || null,
      routeNotes || null,
    ]
  );

  return insertResult.rows[0].id;
}


/**
 * Batch-fetch products with their active pricing rule, price tiers, rule-level
 * tiers, and explicit pricing group memberships.
 *
 * Returns:
 *   productMap    — { [product_id]: productRow }  (with _pricingRule, _pricingGroupId)
 *   tiersMap      — { [product_id]: tierRow[] }   (product_price_tiers)
 *   ruleTiersMap  — { [rule_id]: tierRow[] }       (pricing_rule_tiers)
 */
async function loadPricingContext(client, productIds) {
  if (!productIds || productIds.length === 0) {
    return { productMap: {}, tiersMap: {}, ruleTiersMap: {} };
  }

  const productResult = await client.query(
    `
    SELECT
      p.id, p.name, p.sku,
      p.retail_price, p.wholesale_price, p.min_qty_wholesale,
      p.min_order_qty, p.order_qty_step, p.selling_unit_label,
      p.requires_manual_price, p.current_stock, p.pricing_rule_id,
      pr.rule_type      AS pricing_rule_type,
      pr.threshold_qty  AS pricing_rule_threshold_qty,
      pr.name           AS pricing_rule_name,
      pr.pricing_group_id AS pricing_rule_group_id,
      active_flash_sale.id AS flash_sale_id,
      active_flash_sale.name AS flash_sale_name,
      active_flash_sale.discount_type AS flash_sale_discount_type,
      active_flash_sale.discount_value AS flash_sale_discount_value,
      active_flash_sale.start_date AS flash_sale_start_date,
      active_flash_sale.end_date AS flash_sale_end_date,
      active_flash_sale.discounted_price AS flash_sale_discounted_price
    FROM products p
    LEFT JOIN pricing_rules pr
      ON pr.id = p.pricing_rule_id AND pr.is_active = TRUE
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
    WHERE p.id = ANY($1)
    `,
    [productIds]
  );

  const productMap = {};
  const ruleIds = new Set();

  for (const row of productResult.rows) {
    productMap[row.id] = {
      ...row,
      _pricingRule:
        row.pricing_rule_id != null
          ? {
              id: row.pricing_rule_id,
              rule_type: row.pricing_rule_type,
              threshold_qty: row.pricing_rule_threshold_qty,
              name: row.pricing_rule_name,
              pricing_group_id: row.pricing_rule_group_id || null,
            }
          : null,
      _pricingGroupId: null,
      _pricingGroupName: null,
      _activeFlashSale:
        row.flash_sale_id != null
          ? {
              id: row.flash_sale_id,
              name: row.flash_sale_name,
              discount_type: row.flash_sale_discount_type,
              discount_value: row.flash_sale_discount_value,
              start_date: row.flash_sale_start_date,
              end_date: row.flash_sale_end_date,
              discounted_price: row.flash_sale_discounted_price,
            }
          : null,
    };
    if (row.pricing_rule_id != null) ruleIds.add(row.pricing_rule_id);
  }

  // ── Product-level tiers (product_price_tiers, used by legacy TIERED rule) ─
  const tiersResult = await client.query(
    `
    SELECT product_id, min_qty, max_qty, unit_price
    FROM product_price_tiers
    WHERE product_id = ANY($1)
    ORDER BY product_id, min_qty
    `,
    [productIds]
  );

  const tiersMap = {};
  for (const tier of tiersResult.rows) {
    if (!tiersMap[tier.product_id]) tiersMap[tier.product_id] = [];
    tiersMap[tier.product_id].push(tier);
  }

  // ── Rule-level tiers (pricing_rule_tiers, used by SKU_TIERED / GROUP_TIERED) ─
  const ruleTiersMap = {};
  if (ruleIds.size > 0) {
    const ruleTiersResult = await client.query(
      `
      SELECT pricing_rule_id, min_qty, max_qty, unit_price
      FROM pricing_rule_tiers
      WHERE pricing_rule_id = ANY($1)
      ORDER BY pricing_rule_id, min_qty
      `,
      [Array.from(ruleIds)]
    );
    for (const tier of ruleTiersResult.rows) {
      if (!ruleTiersMap[tier.pricing_rule_id]) ruleTiersMap[tier.pricing_rule_id] = [];
      ruleTiersMap[tier.pricing_rule_id].push(tier);
    }
  }

  // ── Explicit pricing group memberships (pricing_group_products) ───────────
  // Resolves _pricingGroupId for each product so GROUP_* rules can use the
  // explicit group for combined quantity evaluation instead of the implicit
  // shared-rule-id approach.
  //
  // Priority:
  //   1. pricing_rules.pricing_group_id (the rule itself declares its group)
  //   2. pricing_group_products (explicit membership, for products in a group
  //      without a direct rule-level group link)
  for (const pid of productIds) {
    const prod = productMap[pid];
    if (!prod) continue;
    if (prod._pricingRule && prod._pricingRule.pricing_group_id) {
      prod._pricingGroupId = prod._pricingRule.pricing_group_id;
    }
  }

  // Check pricing_group_products for products that don't yet have a group id
  const productsNeedingGroupLookup = productIds.filter(
    (pid) => productMap[pid] && productMap[pid]._pricingGroupId == null
  );

  if (productsNeedingGroupLookup.length > 0) {
    const groupMemberResult = await client.query(
      `
      SELECT pgp.product_id, pgp.pricing_group_id, pg.name AS pricing_group_name
      FROM pricing_group_products pgp
      JOIN pricing_groups pg ON pg.id = pgp.pricing_group_id
      WHERE pgp.product_id = ANY($1)
        AND pgp.is_active = TRUE
        AND pg.is_active = TRUE
        AND (pgp.effective_from IS NULL OR pgp.effective_from <= NOW())
        AND (pgp.effective_until IS NULL OR pgp.effective_until > NOW())
      ORDER BY pgp.product_id, pgp.pricing_group_id
      `,
      [productsNeedingGroupLookup]
    );

    for (const row of groupMemberResult.rows) {
      const prod = productMap[row.product_id];
      if (prod && prod._pricingGroupId == null) {
        prod._pricingGroupId = row.pricing_group_id;
        prod._pricingGroupName = row.pricing_group_name;
      }
    }
  }

  // Set group name for products whose group came from the rule-level group link
  // (name requires an extra lookup only if we don't already have it)
  const ruleGroupIds = new Set(
    Object.values(productMap)
      .filter((p) => p._pricingGroupName == null && p._pricingGroupId != null)
      .map((p) => p._pricingGroupId)
  );

  if (ruleGroupIds.size > 0) {
    const groupNameResult = await client.query(
      `SELECT id, name FROM pricing_groups WHERE id = ANY($1)`,
      [Array.from(ruleGroupIds)]
    );
    const groupNames = {};
    for (const row of groupNameResult.rows) {
      groupNames[row.id] = row.name;
    }
    for (const prod of Object.values(productMap)) {
      if (prod._pricingGroupId != null && prod._pricingGroupName == null) {
        prod._pricingGroupName = groupNames[prod._pricingGroupId] || null;
      }
    }
  }

  return { productMap, tiersMap, ruleTiersMap };

}

// GET ALL ORDERS
const getAllOrders = async (req, res) => {
  try {
    const {
      order_type,
      order_status,
      workflow_type,
      customer_id,
      sales_rep_id,
      search,
      printed_status,
      payment_state,
    } = req.query;

    let query = `
      SELECT
        o.*,
        COALESCE(o.amount_paid, 0) AS amount_paid,
        COALESCE(sr.full_name, sr.name) AS sales_rep_name,
        COALESCE(sr.phone, sr.phone_number) AS sales_rep_phone,
        l.name AS location_name,
        r.name AS region_name,
        COUNT(DISTINCT oi.id) AS item_count,
        COALESCE(SUM(oi.quantity), 0) AS total_items
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      LEFT JOIN sales_reps sr ON o.sales_rep_id = sr.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (order_type) {
      params.push(order_type);
      query += ` AND o.order_type = $${paramIndex}`;
      paramIndex++;
    }

    if (order_status) {
      params.push(order_status);
      query += ` AND o.order_status = $${paramIndex}`;
      paramIndex++;
    }

    if (workflow_type) {
      params.push(workflow_type);
      query += ` AND o.order_workflow_type = $${paramIndex}`;
      paramIndex++;
    }

    if (customer_id) {
      params.push(customer_id);
      query += ` AND o.customer_id = $${paramIndex}`;
      paramIndex++;
    }

    if (sales_rep_id) {
      params.push(sales_rep_id);
      query += ` AND o.sales_rep_id = $${paramIndex}`;
      paramIndex++;
    }

    if (printed_status === 'printed') {
      query += ` AND COALESCE(o.is_printed, FALSE) = TRUE`;
    }

    if (printed_status === 'not_printed') {
      query += ` AND COALESCE(o.is_printed, FALSE) = FALSE`;
    }

    if (payment_state) {
      if (payment_state === 'paid') {
        query += `
          AND o.order_type = 'route'
          AND GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0) = 0
        `;
      } else if (payment_state === 'partial') {
        query += `
          AND o.order_type = 'route'
          AND COALESCE(o.amount_paid, 0) > 0
          AND GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0) > 0
          AND (o.due_date IS NULL OR o.due_date >= CURRENT_DATE)
        `;
      } else if (payment_state === 'unpaid') {
        query += `
          AND o.order_type = 'route'
          AND COALESCE(o.amount_paid, 0) <= 0
          AND GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0) > 0
          AND (o.due_date IS NULL OR o.due_date >= CURRENT_DATE)
        `;
      } else if (payment_state === 'overdue') {
        query += `
          AND o.order_type = 'route'
          AND GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0) > 0
          AND o.due_date IS NOT NULL
          AND o.due_date < CURRENT_DATE
        `;
      }
    }

    if (search) {
      params.push(`%${search}%`);
      query += `
        AND (
          o.order_number ILIKE $${paramIndex}
          OR o.customer_name ILIKE $${paramIndex}
          OR COALESCE(l.name, '') ILIKE $${paramIndex}
          OR COALESCE(r.name, '') ILIKE $${paramIndex}
          OR COALESCE(sr.name, '') ILIKE $${paramIndex}
        )
      `;
      paramIndex++;
    }

    query += `
      GROUP BY o.id, sr.id, l.id, r.id
      ORDER BY o.created_at DESC
    `;

    const result = await pool.query(query, params);
    const rows = result.rows.map(enrichOrder);

    return handleSuccess(res, 200, 'Orders retrieved successfully', rows);
  } catch (err) {
    console.error('getAllOrders error:', err.message);
    return handleError(res, 500, 'Failed to retrieve orders', err);
  }
};

// GET SINGLE ORDER BY ID
const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query(
      `
      SELECT
        o.*,
        COALESCE(o.amount_paid, 0) AS amount_paid,
        COALESCE(sr.full_name, sr.name) AS sales_rep_name,
        COALESCE(sr.phone, sr.phone_number) AS sales_rep_phone,
        l.name AS location_name,
        r.name AS region_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      LEFT JOIN sales_reps sr ON o.sales_rep_id = sr.id
      WHERE o.id = $1
      `,
      [id]
    );

    if (orderResult.rows.length === 0) {
      return handleError(res, 404, 'Order not found');
    }

    const itemsResult = await pool.query(
      `
      SELECT
        oi.id,
        oi.order_id,
        oi.product_id,
        oi.quantity,
        oi.price_at_purchase,
        COALESCE(oi.line_total, oi.quantity * oi.price_at_purchase) AS line_total,
        oi.price_source,
        oi.pricing_locked_at,
        oi.created_at,
        COALESCE(p.name, '[Product #' || oi.product_id || ' — deleted]') AS product_name,
        p.sku,
        p.image_url,
        oi.price_at_purchase AS unit_price,
        COALESCE(oi.line_total, oi.quantity * oi.price_at_purchase) AS total_price
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
      ORDER BY oi.id ASC
      `,
      [id]
    );

    const order = enrichOrder(orderResult.rows[0]);
    order.items = itemsResult.rows.map((item) => ({
      ...item,
      price_at_purchase: roundMoney(item.price_at_purchase),
      line_total: roundMoney(item.line_total),
      unit_price: roundMoney(item.unit_price),
      total_price: roundMoney(item.total_price),
    }));

    return handleSuccess(res, 200, 'Order retrieved successfully', order);
  } catch (err) {
    console.error('getOrderById error:', err.message);
    return handleError(res, 500, 'Failed to retrieve order', err);
  }
};

// GUEST CHECKOUT — public endpoint, no auth required
const guestCheckout = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      order_type,
      order_workflow_type,
      customer_id,
      customer_name,
      customer_phone,
      customer_email,
      customer_location_id,
      delivery_address,
      route_area,
      route_notes,
      sales_rep_id,
      notes,
      items,
    } = req.body;

    const authenticatedSalesRep = await resolveAuthenticatedSalesRep(req, client);
    const normalizedOrderType = String(order_type || '').trim().toLowerCase() === 'route' ? 'route' : 'normal';
    const requestedWorkflowType = normalizeWorkflowType(order_workflow_type);
    const normalizedName = normalizeText(customer_name);
    const normalizedPhone = normalizeText(customer_phone);
    const normalizedEmail = normalizeText(customer_email);
    const normalizedAddress = normalizeText(delivery_address);
    const normalizedRouteArea = normalizeText(route_area);
    const normalizedRouteNotes = normalizeText(route_notes);
    const normalizedNotes = normalizeText(notes);

    if (!normalizedName) {
      return handleError(res, 400, 'customer_name is required');
    }
    if (!normalizedPhone) {
      return handleError(res, 400, 'customer_phone is required');
    }
    if (!Array.isArray(items) || items.length === 0) {
      return handleError(res, 400, 'At least one order item is required');
    }

    if (order_workflow_type && !requestedWorkflowType) {
      return handleError(
        res,
        400,
        'order_workflow_type must be one of: normal_self_service, route_self_service, route_sales_rep_capture'
      );
    }

    let effectiveSalesRepId = sales_rep_id || null;

    if (authenticatedSalesRep) {
      if (effectiveSalesRepId && Number(effectiveSalesRepId) !== Number(authenticatedSalesRep.id)) {
        return handleError(res, 403, 'Authenticated sales rep does not match provided sales_rep_id');
      }
      effectiveSalesRepId = authenticatedSalesRep.id;
    }

    if (normalizedOrderType === 'route' && !effectiveSalesRepId) {
      return handleError(res, 400, 'sales_rep_id is required for route orders');
    }

    if (requestedWorkflowType === 'route_sales_rep_capture' && !effectiveSalesRepId) {
      return handleError(res, 400, 'sales_rep_id is required for route_sales_rep_capture workflow');
    }

    await client.query('BEGIN');

    let customerId;
    if (normalizedOrderType === 'route') {
      customerId = await resolveRouteCustomerForOrder(client, {
        customerId: customer_id || null,
        customerName: normalizedName,
        customerPhone: normalizedPhone,
        salesRepId: effectiveSalesRepId || null,
        locationId: customer_location_id || null,
        address: normalizedAddress,
        routeArea: normalizedRouteArea,
        routeNotes: normalizedRouteNotes,
      });
    } else {
      const existingCustomer = await client.query(
        `SELECT id FROM customers
         WHERE phone = $1 AND customer_type = 'normal'
         LIMIT 1`,
        [normalizedPhone]
      );

      if (existingCustomer.rows.length > 0) {
        customerId = existingCustomer.rows[0].id;
        await client.query(
          `UPDATE customers
           SET name = $1,
               email = COALESCE($2, email),
               address = COALESCE($3, address),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
          [normalizedName, normalizedEmail, normalizedAddress, customerId]
        );
      } else {
        const newCustomer = await client.query(
          `INSERT INTO customers
           (name, phone, email, address, customer_type, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'normal', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           RETURNING id`,
          [normalizedName, normalizedPhone, normalizedEmail, normalizedAddress]
        );
        customerId = newCustomer.rows[0].id;
      }
    }

    // Validate items and collect product IDs
    const rawItems = [];

    for (const rawItem of items) {
      const productId = Number(rawItem.product_id);
      const quantity = Number(rawItem.quantity || 0);

      if (!Number.isInteger(productId) || productId <= 0) {
        throw new Error('Invalid product_id in order items');
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new OrderValidationError(`Invalid quantity for product ${productId}`);
      }

      // pricing_mode: normalize falsy values (empty string, undefined) to null
      rawItems.push({ product_id: productId, quantity, pricing_mode: rawItem.pricing_mode || null });
    }


    // Batch-load products with pricing rule context and tiers
    const productIds = rawItems.map((i) => i.product_id);
    const { productMap, tiersMap, ruleTiersMap } = await loadPricingContext(client, productIds);

    for (const item of rawItems) {
      if (!productMap[item.product_id]) {
        throw new Error(`Product does not exist: ${item.product_id}`);
      }
      assertProductOrderQuantity(productMap[item.product_id], item.quantity);
    }

    // Server-side price resolution via pricing rule evaluator.
    // The backend is the sole pricing authority; client-supplied prices are
    // never used for non-manual products.  If the client explicitly requested
    // wholesale pricing, we validate that eligibility is actually met.
    const evaluatedItems = evaluateCartPricingWithMeta(rawItems, productMap, tiersMap, ruleTiersMap);

    // Validate explicit wholesale requests against server-computed eligibility
    for (let i = 0; i < rawItems.length; i++) {
      assertWholesaleEligibility(rawItems[i].pricing_mode, evaluatedItems[i], rawItems[i].product_id);
    }

    const preparedItems = [];
    let computedTotalAmount = 0;

    for (let i = 0; i < rawItems.length; i++) {
      const rawItem = rawItems[i];
      const evalItem = evaluatedItems[i];
      const product = productMap[rawItem.product_id];

      let priceAtPurchase;
      let priceSource;

      if (product.requires_manual_price || evalItem.unit_price == null) {
        // Guest checkout cannot supply manual prices; fall back to retail
        const fallback = toNumber(product.retail_price, NaN);
        if (!Number.isFinite(fallback) || fallback < 0) {
          throw new Error(`No valid price available for product ${rawItem.product_id}`);
        }
        priceAtPurchase = fallback;
        priceSource = 'retail';
      } else {
        priceAtPurchase = Number(evalItem.unit_price.toFixed(2));
        priceSource = evalItem.price_source;
      }

      const lineTotal = roundMoney(rawItem.quantity * priceAtPurchase);
      computedTotalAmount += lineTotal;

      preparedItems.push({
        product_id: rawItem.product_id,
        quantity: rawItem.quantity,
        price_at_purchase: roundMoney(priceAtPurchase),
        line_total: lineTotal,
        price_source: priceSource,

        product_name: product.name,
      });
    }

    computedTotalAmount = roundMoney(computedTotalAmount);
    const orderNum = generateOrderNumber();
    const stockChanges = await reserveStockForOrder(client, preparedItems);
    const finalWorkflowType =
      requestedWorkflowType ||
      (normalizedOrderType === 'route'
        ? (effectiveSalesRepId ? 'route_sales_rep_capture' : 'route_self_service')
        : 'normal_self_service');
    const initialPaymentState =
      normalizedOrderType === 'route'
        ? deriveRoutePaymentState(computedTotalAmount, 0, null)
        : 'unpaid';

    const orderResult = await client.query(
      `
      INSERT INTO orders
      (
        order_number,
        order_type,
        customer_id,
        customer_name,
        customer_phone,
        customer_email,
        delivery_address,
        sales_rep_id,
        order_workflow_type,
        total_amount,
        amount_paid,
        notes,
        payment_status,
        payment_state,
        is_printed
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, 'pending', $12, FALSE)
      RETURNING *
      `,
      [
        orderNum,
        normalizedOrderType,
        customerId,
        normalizedName,
        normalizedPhone,
        normalizedEmail,
        normalizedAddress,
        effectiveSalesRepId || null,
        finalWorkflowType,
        computedTotalAmount,
        normalizedNotes,
        initialPaymentState,
      ]
    );

    const orderId = orderResult.rows[0].id;

    for (const item of preparedItems) {
      const itemResult = await client.query(
        `
        INSERT INTO order_items
          (order_id, product_id, quantity, price_at_purchase, line_total, price_source)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, pricing_locked_at
        `,
        [
          orderId,
          item.product_id,
          item.quantity,
          item.price_at_purchase,
          item.line_total,
          item.price_source,
        ]
      );

      const orderItemId = itemResult.rows[0].id;
      const rawLockedAt = itemResult.rows[0].pricing_locked_at;
      if (!rawLockedAt) {
        console.warn(`guestCheckout: pricing_locked_at not set by trigger for order_item ${orderItemId}; migration 20260426_pricing_integrity_pr1.sql may not have been applied`);
      }
      const pricingLockedAt = rawLockedAt || new Date().toISOString();

      await client.query(
        `
        INSERT INTO order_item_pricing_audit
          (order_item_id, order_id, product_id, quantity, price_at_purchase, line_total, price_source, pricing_locked_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          orderItemId,
          orderId,
          item.product_id,
          item.quantity,
          item.price_at_purchase,
          item.line_total,
          item.price_source,
          pricingLockedAt,
        ]
      );
    }

    await client.query('COMMIT');

    broadcastDashboardUpdated({
      type: 'order_created',
      order_id: orderId,
      order_number: orderNum,
      stock_changes: stockChanges,
    });

    const createdOrder = enrichOrder(orderResult.rows[0]);
    createdOrder.items = preparedItems.map((item) => ({
      ...item,
      unit_price: item.price_at_purchase,
      total_price: item.line_total,
    }));

    return handleSuccess(res, 201, 'Order placed successfully', attachOrderTrackingLink(createdOrder));
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.isOrderValidationError) {
      return handleError(res, 422, err.message);
    }
    console.error('guestCheckout error:', err.message);
    return handleError(res, 500, 'Failed to place order', err);
  } finally {
    client.release();
  }
};

// CREATE ORDER
const createOrder = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      order_type,
      customer_id,
      customer_name,
      customer_phone,
      customer_location_id,
      customer_address,
      route_area,
      route_notes,
      sales_rep_id,
      order_workflow_type,
      total_amount,
      notes,
      items,
      amount_paid,
      due_date,
    } = req.body;

    const authenticatedSalesRep = await resolveAuthenticatedSalesRep(req, client);

    const normalizedOrderType = String(order_type || '').trim().toLowerCase();

    if (!VALID_ORDER_TYPES.has(normalizedOrderType)) {
      return handleError(res, 400, 'order_type must be either normal or route');
    }

    const normalizedCustomerName = normalizeText(customer_name);
    const normalizedCustomerPhone = normalizeText(customer_phone);
    const normalizedCustomerAddress = normalizeText(customer_address);
    const normalizedRouteArea = normalizeText(route_area);
    const normalizedRouteNotes = normalizeText(route_notes);
    const normalizedNotes = normalizeText(notes);
    const normalizedDueDate = due_date && due_date !== '' ? due_date : null;
    const requestedWorkflowType = normalizeWorkflowType(order_workflow_type);

    if (!normalizedCustomerName || !normalizedCustomerPhone) {
      return handleError(res, 400, 'customer_name and customer_phone are required');
    }

    if (!Array.isArray(items) || items.length === 0) {
      return handleError(res, 400, 'At least one order item is required');
    }

    let effectiveSalesRepId = sales_rep_id || null;

    if (authenticatedSalesRep) {
      if (effectiveSalesRepId && Number(effectiveSalesRepId) !== Number(authenticatedSalesRep.id)) {
        return handleError(res, 403, 'Authenticated sales rep does not match provided sales_rep_id');
      }
      effectiveSalesRepId = authenticatedSalesRep.id;
    }

    if (normalizedOrderType === 'route' && !effectiveSalesRepId) {
      return handleError(res, 400, 'sales_rep_id is required for route orders');
    }

    const submittedAmountPaid =
      amount_paid === undefined || amount_paid === null || amount_paid === ''
        ? 0
        : toNumber(amount_paid, NaN);

    if (!Number.isFinite(submittedAmountPaid) || submittedAmountPaid < 0) {
      return handleError(res, 400, 'amount_paid must be a valid non-negative number');
    }

    if (order_workflow_type && !requestedWorkflowType) {
      return handleError(
        res,
        400,
        'order_workflow_type must be one of: normal_self_service, route_self_service, route_sales_rep_capture'
      );
    }

    if (requestedWorkflowType === 'normal_self_service' && normalizedOrderType !== 'normal') {
      return handleError(res, 400, 'normal_self_service workflow is only valid for normal orders');
    }

    if (
      (requestedWorkflowType === 'route_self_service' || requestedWorkflowType === 'route_sales_rep_capture') &&
      normalizedOrderType !== 'route'
    ) {
      return handleError(res, 400, 'Route workflows are only valid for route orders');
    }

    if (requestedWorkflowType === 'route_sales_rep_capture' && !effectiveSalesRepId) {
      return handleError(res, 400, 'sales_rep_id is required for route_sales_rep_capture workflow');
    }

    if (customer_id) {
      const customerCheck = await client.query(
        'SELECT id FROM customers WHERE id = $1',
        [customer_id]
      );

      if (customerCheck.rows.length === 0) {
        return handleError(res, 400, 'Customer does not exist');
      }
    }

    if (effectiveSalesRepId) {
      const repCheck = await client.query(
        'SELECT id FROM sales_reps WHERE id = $1',
        [effectiveSalesRepId]
      );

      if (repCheck.rows.length === 0) {
        return handleError(res, 400, 'Sales rep does not exist');
      }
    }

    await client.query('BEGIN');

    let resolvedCustomerId = customer_id || null;
    if (normalizedOrderType === 'route') {
      resolvedCustomerId = await resolveRouteCustomerForOrder(client, {
        customerId: customer_id || null,
        customerName: normalizedCustomerName,
        customerPhone: normalizedCustomerPhone,
        salesRepId: effectiveSalesRepId || null,
        locationId: customer_location_id || null,
        address: normalizedCustomerAddress,
        routeArea: normalizedRouteArea,
        routeNotes: normalizedRouteNotes,
      });
    }

    // Validate items and collect product IDs
    const rawItems = [];
    for (const rawItem of items) {
      const productId = Number(rawItem.product_id);
      const quantity = Number(rawItem.quantity || 0);

      if (!Number.isInteger(productId) || productId <= 0) {
        throw new Error('Invalid product_id in order items');
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new OrderValidationError(`Invalid quantity for product ${productId}`);
      }

      rawItems.push({
        product_id: productId,
        quantity,
        submitted_price: rawItem.unit_price ?? rawItem.price_at_purchase ?? null,
        // pricing_mode: normalize falsy values (empty string, undefined) to null
        pricing_mode: rawItem.pricing_mode || null,
      });
    }


    // Batch-load products with pricing rule context and tiers
    const productIds = rawItems.map((i) => i.product_id);
    const { productMap, tiersMap, ruleTiersMap } = await loadPricingContext(client, productIds);

    for (const item of rawItems) {
      if (!productMap[item.product_id]) {
        throw new Error(`Product does not exist: ${item.product_id}`);
      }
      assertProductOrderQuantity(productMap[item.product_id], item.quantity);
    }

    // Server-side price resolution via pricing rule evaluator.
    // The backend is the sole pricing authority; client-supplied prices are
    // never used for non-manual products.  If the client explicitly requested
    // wholesale pricing, we validate that eligibility is actually met.
    const evaluatedItems = evaluateCartPricingWithMeta(rawItems, productMap, tiersMap, ruleTiersMap);

    // Validate explicit wholesale requests against server-computed eligibility
    for (let i = 0; i < rawItems.length; i++) {
      assertWholesaleEligibility(rawItems[i].pricing_mode, evaluatedItems[i], rawItems[i].product_id);
    }

    const preparedItems = [];
    let computedTotalAmount = 0;

    for (let i = 0; i < rawItems.length; i++) {
      const rawItem = rawItems[i];
      const evalItem = evaluatedItems[i];
      const product = productMap[rawItem.product_id];

      let priceAtPurchase;
      let priceSource;

      if (product.requires_manual_price) {
        // Manual product: caller must supply the price
        const submittedPrice = rawItem.submitted_price;
        if (submittedPrice == null || submittedPrice === '') {
          throw new Error(
            `unit_price is required for manual product ${rawItem.product_id}`
          );
        }
        priceAtPurchase = toNumber(submittedPrice, NaN);
        if (!Number.isFinite(priceAtPurchase) || priceAtPurchase < 0) {
          throw new Error(`Invalid price for product ${rawItem.product_id}`);
        }
        priceSource = 'manual_price';
      } else {
        if (evalItem.unit_price == null) {
          throw new Error(
            `No valid price available for product ${rawItem.product_id}`
          );
        }
        priceAtPurchase = Number(evalItem.unit_price.toFixed(2));
        priceSource = evalItem.price_source;
      }

      const lineTotal = roundMoney(rawItem.quantity * priceAtPurchase);
      computedTotalAmount += lineTotal;

      preparedItems.push({
        product_id: rawItem.product_id,
        quantity: rawItem.quantity,
        price_at_purchase: roundMoney(priceAtPurchase),
        line_total: lineTotal,
        price_source: priceSource,

        product_name: product.name,
      });
    }

    computedTotalAmount = roundMoney(computedTotalAmount);

    const submittedTotalAmount = toNumber(total_amount, computedTotalAmount);
    if (!Number.isFinite(submittedTotalAmount) || submittedTotalAmount < 0) {
      throw new Error('total_amount must be a valid non-negative number');
    }

    const finalTotalAmount = computedTotalAmount;

    const initialPaymentStatus =
      normalizedOrderType === 'normal' &&
      submittedAmountPaid >= finalTotalAmount &&
      finalTotalAmount > 0
        ? 'completed'
        : 'pending';

    const initialPaymentState =
      normalizedOrderType === 'route'
        ? deriveRoutePaymentState(finalTotalAmount, submittedAmountPaid, normalizedDueDate)
        : 'unpaid';

    const initialLastPaymentDate =
      submittedAmountPaid > 0 ? new Date().toISOString() : null;

    const inferredWorkflowType =
      normalizedOrderType === 'route'
        ? (effectiveSalesRepId ? 'route_sales_rep_capture' : 'route_self_service')
        : 'normal_self_service';

    const finalWorkflowType = requestedWorkflowType || inferredWorkflowType;

    const orderNum = generateOrderNumber();
    const stockChanges = await reserveStockForOrder(client, preparedItems);

    const orderResult = await client.query(
      `
      INSERT INTO orders
      (
        order_number,
        order_type,
        customer_id,
        customer_name,
        customer_phone,
        sales_rep_id,
        order_workflow_type,
        total_amount,
        amount_paid,
        due_date,
        last_payment_date,
        notes,
        payment_status,
        payment_state,
        is_printed
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, FALSE)
      RETURNING *
      `,
      [
        orderNum,
        normalizedOrderType,
        resolvedCustomerId,
        normalizedCustomerName,
        normalizedCustomerPhone,
        effectiveSalesRepId || null,
        finalWorkflowType,
        finalTotalAmount,
        roundMoney(submittedAmountPaid),
        normalizedDueDate,
        initialLastPaymentDate,
        normalizedNotes,
        initialPaymentStatus,
        initialPaymentState,
      ]
    );

    const orderId = orderResult.rows[0].id;

    for (const item of preparedItems) {
      const itemResult = await client.query(
        `
        INSERT INTO order_items
        (
          order_id,
          product_id,
          quantity,
          price_at_purchase,
          line_total,
          price_source
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, pricing_locked_at
        `,
        [
          orderId,
          item.product_id,
          item.quantity,
          item.price_at_purchase,
          item.line_total,
          item.price_source,
        ]
      );

      const orderItemId = itemResult.rows[0].id;
      const rawLockedAt = itemResult.rows[0].pricing_locked_at;
      if (!rawLockedAt) {
        console.warn(`createOrder: pricing_locked_at not set by trigger for order_item ${orderItemId}; migration 20260426_pricing_integrity_pr1.sql may not have been applied`);
      }
      const pricingLockedAt = rawLockedAt || new Date().toISOString();

      await client.query(
        `
        INSERT INTO order_item_pricing_audit
          (order_item_id, order_id, product_id, quantity, price_at_purchase, line_total, price_source, pricing_locked_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          orderItemId,
          orderId,
          item.product_id,
          item.quantity,
          item.price_at_purchase,
          item.line_total,
          item.price_source,
          pricingLockedAt,

        ]
      );
    }

    await client.query('COMMIT');

    broadcastDashboardUpdated({
      type: 'order_created',
      order_id: orderId,
      order_number: orderNum,
      stock_changes: stockChanges,
    });

    const createdOrder = enrichOrder(orderResult.rows[0]);
    createdOrder.items = preparedItems.map((item) => ({
      ...item,
      unit_price: item.price_at_purchase,
      total_price: item.line_total,
    }));

    return handleSuccess(res, 201, 'Order created successfully', attachOrderTrackingLink(createdOrder));
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.isOrderValidationError) {
      return handleError(res, 422, err.message);
    }
    console.error('createOrder error:', err.message);
    return handleError(res, 500, 'Failed to create order', err);
  } finally {
    client.release();
  }
};

// UPDATE ORDER STATUS / SETTLEMENT
const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      order_status,
      payment_status,
      amount_paid,
      due_date,
      notes,
      payment_reference,
      mpesa_reference,
      mpesa_receipt,
    } = req.body;

    const currentResult = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      `,
      [id]
    );

    if (currentResult.rows.length === 0) {
      return handleError(res, 404, 'Order not found');
    }

    const current = currentResult.rows[0];

    // Validate order_status against allowed values before touching the DB
    if (order_status !== undefined && order_status !== null && order_status !== '') {
      const normalizedStatus = String(order_status).trim().toLowerCase();
      if (!normalizedStatus || !VALID_ORDER_STATUSES.has(normalizedStatus)) {
        return handleError(
          res,
          400,
          `Invalid order_status '${order_status}'. Allowed values: ${[...VALID_ORDER_STATUSES].join(', ')}`
        );
      }
    }

    const totalAmount = toNumber(current.total_amount, 0);
    const currentAmountPaid = toNumber(current.amount_paid, 0);

    let nextAmountPaid = currentAmountPaid;
    if (amount_paid !== undefined && amount_paid !== null && amount_paid !== '') {
      const parsedAmountPaid = toNumber(amount_paid, NaN);
      if (!Number.isFinite(parsedAmountPaid) || parsedAmountPaid < 0) {
        return handleError(res, 400, 'amount_paid must be a valid non-negative number');
      }
      nextAmountPaid = parsedAmountPaid;
    }

    let nextDueDate = current.due_date;
    if (due_date !== undefined) {
      nextDueDate = due_date === '' ? null : due_date;
    }

    let nextPaymentStatus = payment_status || current.payment_status || 'pending';

    if (current.order_type === 'normal') {
      if (nextPaymentStatus === 'completed' && amount_paid === undefined) {
        nextAmountPaid = totalAmount;
      }

      if (nextAmountPaid >= totalAmount && totalAmount > 0) {
        nextPaymentStatus = 'completed';
      } else if (nextPaymentStatus === 'completed' && nextAmountPaid < totalAmount) {
        nextPaymentStatus = 'pending';
      }
    }

    const manualReference = normalizeText(payment_reference || mpesa_reference || mpesa_receipt);
    const paymentAmountIncreased = nextAmountPaid > currentAmountPaid;
    const paymentMarkedComplete =
      current.order_type === 'normal' &&
      nextPaymentStatus === 'completed' &&
      (current.payment_status || 'pending') !== 'completed';

    if ((paymentAmountIncreased || paymentMarkedComplete) && !manualReference) {
      return handleError(
        res,
        400,
        'Manual payment updates require an M-Pesa receipt/reference code. Use the Payments screen for full reconciliation.'
      );
    }

    const nextPaymentState =
      current.order_type === 'route'
        ? deriveRoutePaymentState(totalAmount, nextAmountPaid, nextDueDate)
        : current.payment_state || 'unpaid';

    const nextLastPaymentDate =
      nextAmountPaid > currentAmountPaid
        ? new Date().toISOString()
        : current.last_payment_date;
    const nextNotes = normalizeText(notes);
    const settlementNote = manualReference
      ? [nextNotes, `Manual payment reference: ${manualReference}`].filter(Boolean).join('\n')
      : nextNotes;

    const result = await pool.query(
      `
      UPDATE orders
      SET order_status = COALESCE($1, order_status),
          payment_status = $2,
          payment_state = $3,
          amount_paid = $4,
          due_date = $5,
          last_payment_date = $6,
          notes = COALESCE($7, notes),
          updated_at = CURRENT_TIMESTAMP,
          status_changed_at = CASE
            WHEN $1 IS NOT NULL AND $1 IS DISTINCT FROM order_status THEN CURRENT_TIMESTAMP
            ELSE status_changed_at
          END
      WHERE id = $8
      RETURNING *
      `,
      [
        order_status || null,
        nextPaymentStatus,
        nextPaymentState,
        roundMoney(nextAmountPaid),
        nextDueDate,
        nextLastPaymentDate,
        settlementNote,
        id,
      ]
    );

    const updatedOrder = enrichOrder(result.rows[0]);

    if (paymentMarkedComplete) {
      try {
        await enqueuePaymentConfirmedSms(pool, updatedOrder);
      } catch (smsErr) {
        console.error('Failed to queue payment confirmation SMS:', smsErr.message);
      }
    }

    broadcastDashboardUpdated({
      type: 'order_updated',
      order_id: updatedOrder.id,
      order_number: updatedOrder.order_number,
      order_status: updatedOrder.order_status,
      payment_status: updatedOrder.payment_status,
    });

    return handleSuccess(res, 200, 'Order updated successfully', updatedOrder);
  } catch (err) {
    console.error('updateOrderStatus error:', err.message);
    return handleError(res, 500, 'Failed to update order', err);
  }
};

// GET ORDERS BY SALES REP
const getOrdersBySalesRep = async (req, res) => {
  try {
    const { sales_rep_id } = req.params;

    const result = await pool.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.total_amount,
        COALESCE(o.amount_paid, 0) AS amount_paid,
        o.due_date,
        o.last_payment_date,
        o.order_status,
        o.payment_status,
        o.payment_state,
        o.is_printed,
        o.printed_at,
        o.created_at,
        o.customer_name,
        o.order_type,
        l.name AS location_name,
        r.name AS region_name,
        COUNT(DISTINCT oi.id) AS item_count
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.sales_rep_id = $1
      GROUP BY o.id, l.id, r.id
      ORDER BY o.created_at DESC
      `,
      [sales_rep_id]
    );

    return handleSuccess(
      res,
      200,
      'Orders retrieved successfully',
      result.rows.map(enrichOrder)
    );
  } catch (err) {
    console.error('getOrdersBySalesRep error:', err.message);
    return handleError(res, 500, 'Failed to retrieve orders', err);
  }
};

// GET ORDER FOR PRINT AND MARK AS PRINTED
const getOrderForPrint = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const format = String(req.query.format || '').trim().toLowerCase();

    await client.query('BEGIN');

    const orderResult = await client.query(
      `
      SELECT
        o.*,
        COALESCE(o.amount_paid, 0) AS amount_paid,
        COALESCE(sr.full_name, sr.name) AS sales_rep_name,
        COALESCE(sr.phone, sr.phone_number) AS sales_rep_phone,
        l.name AS location_name,
        r.name AS region_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      LEFT JOIN sales_reps sr ON o.sales_rep_id = sr.id
      WHERE o.id = $1
      `,
      [id]
    );

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return handleError(res, 404, 'Order not found');
    }

    const itemsResult = await client.query(
      `
      SELECT
        oi.id,
        oi.order_id,
        oi.product_id,
        oi.quantity,
        oi.price_at_purchase,
        COALESCE(oi.line_total, oi.quantity * oi.price_at_purchase) AS line_total,
        oi.price_source,
        oi.pricing_locked_at,
        oi.created_at,
        COALESCE(p.name, '[Product #' || oi.product_id || ' — deleted]') AS product_name,
        p.sku,
        oi.price_at_purchase AS unit_price,
        COALESCE(oi.line_total, oi.quantity * oi.price_at_purchase) AS total_price
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
      ORDER BY oi.id ASC
      `,
      [id]
    );

    const printUpdate = await client.query(
      `
      UPDATE orders
      SET is_printed = TRUE,
          printed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING is_printed, printed_at
      `,
      [id]
    );

    await client.query('COMMIT');

    const mergedOrder = {
      ...orderResult.rows[0],
      is_printed: printUpdate.rows[0]?.is_printed ?? true,
      printed_at: printUpdate.rows[0]?.printed_at ?? new Date().toISOString(),
    };

    const order = enrichOrder(mergedOrder);
    const items = itemsResult.rows.map((item) => ({
      ...item,
      price_at_purchase: roundMoney(item.price_at_purchase),
      line_total: roundMoney(item.line_total),
      unit_price: roundMoney(item.unit_price),
      total_price: roundMoney(item.total_price),
    }));

    const totalQuantity = items.reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0
    );

    const settlementText =
      order.order_type === 'route'
        ? (order.payment_state || 'unpaid').toUpperCase()
        : (order.payment_status || 'pending').toUpperCase();

    const itemsHtml = items.length
      ? items
          .map((item, index) => {
            const productName = escapeHtml(item.product_name || 'Unnamed Product');
            const qty = Number(item.quantity || 0);
            const unitPrice = Number(item.unit_price || 0);
            const lineTotal = Number(item.total_price || 0);

            return `
              <div class="item-block">
                <div class="item-title-row">
                  <div class="item-index">${index + 1}.</div>
                  <div class="item-title">${productName}</div>
                </div>

                <div class="item-meta-row">
                  <div class="item-meta-left">Qty: ${qty}</div>
                  <div class="item-meta-center">Unit: KES ${unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                  <div class="item-meta-right">KES ${lineTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                </div>

                ${item.sku ? `<div class="item-sku">SKU: ${escapeHtml(item.sku)}</div>` : ''}
              </div>
            `;
          })
          .join('')
      : `
        <div class="empty-items">
          No product lines were found for this order.
        </div>
      `;

    const receiptHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8" />
        <title>Order Sheet ${escapeHtml(order.order_number)}</title>
        <style>
          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }

          body {
            width: 80mm;
            font-family: Arial, Helvetica, sans-serif;
            font-size: 10px;
            color: #000;
            background: #fff;
            padding: 4mm;
          }

          .sheet {
            width: 100%;
          }

          .center {
            text-align: center;
          }

          .title {
            font-size: 14px;
            font-weight: 800;
            margin-bottom: 4px;
            letter-spacing: 0.4px;
          }

          .sub {
            font-size: 10px;
            margin-bottom: 8px;
          }

          .line {
            border-top: 1px dashed #000;
            margin: 6px 0;
          }

          .section-title {
            font-size: 10px;
            font-weight: 800;
            margin-bottom: 4px;
            text-transform: uppercase;
          }

          .meta-row {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 2px;
            font-size: 10px;
          }

          .meta-label {
            font-weight: 700;
            min-width: 22mm;
          }

          .meta-value {
            flex: 1;
            text-align: right;
            word-break: break-word;
          }

          .items-section {
            margin-top: 4px;
          }

          .items-header {
            display: flex;
            justify-content: space-between;
            font-size: 9px;
            font-weight: 800;
            border-top: 1px solid #000;
            border-bottom: 1px solid #000;
            padding: 4px 0;
            margin-bottom: 4px;
          }

          .item-block {
            padding: 4px 0;
            border-bottom: 1px dotted #999;
          }

          .item-title-row {
            display: flex;
            gap: 4px;
            align-items: flex-start;
            margin-bottom: 2px;
          }

          .item-index {
            width: 6mm;
            font-weight: 700;
            font-size: 10px;
          }

          .item-title {
            flex: 1;
            font-size: 10px;
            font-weight: 700;
            line-height: 1.25;
            word-break: break-word;
          }

          .item-meta-row {
            display: flex;
            justify-content: space-between;
            gap: 4px;
            font-size: 9px;
            line-height: 1.25;
          }

          .item-meta-left {
            width: 16mm;
          }

          .item-meta-center {
            flex: 1;
            text-align: center;
          }

          .item-meta-right {
            width: 20mm;
            text-align: right;
            font-weight: 700;
          }

          .item-sku {
            margin-top: 2px;
            font-size: 8px;
            color: #555;
          }

          .empty-items {
            padding: 8px 0;
            font-size: 10px;
            text-align: center;
            border-bottom: 1px dotted #999;
          }

          .totals {
            margin-top: 8px;
          }

          .total-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 3px;
            font-size: 10px;
          }

          .grand-total {
            font-size: 13px;
            font-weight: 800;
            border-top: 1px solid #000;
            padding-top: 5px;
            margin-top: 5px;
          }

          .note {
            margin-top: 6px;
            font-size: 9px;
            line-height: 1.35;
          }

          .footer {
            margin-top: 10px;
            text-align: center;
            font-size: 9px;
          }

          @page {
            size: 80mm auto;
            margin: 0;
          }

          @media print {
            body {
              width: 80mm;
            }
          }
        </style>
      </head>
      <body>
        <div class="sheet">
          <div class="center">
            <div class="title">XPOSE DISTRIBUTORS</div>
            <div class="sub">ORDER RECEIPT</div>
          </div>

          <div class="line"></div>

          <div class="section-title">Order Info</div>
          <div class="meta-row">
            <div class="meta-label">Order No</div>
            <div class="meta-value">${escapeHtml(order.order_number)}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Date</div>
            <div class="meta-value">${new Date(order.created_at).toLocaleString('en-US', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Printed</div>
            <div class="meta-value">${order.printed_at ? new Date(order.printed_at).toLocaleString('en-US', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            }) : '-'}</div>
          </div>

          <div class="line"></div>

          <div class="section-title">Sales Rep</div>
          <div class="meta-row">
            <div class="meta-label">Name</div>
            <div class="meta-value">${escapeHtml(order.sales_rep_name || 'Unassigned')}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Phone</div>
            <div class="meta-value">${escapeHtml(order.sales_rep_phone || '-')}</div>
          </div>

          <div class="line"></div>

          <div class="section-title">Customer</div>
          <div class="meta-row">
            <div class="meta-label">Name</div>
            <div class="meta-value">${escapeHtml(order.customer_name)}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Phone</div>
            <div class="meta-value">${escapeHtml(order.customer_phone)}</div>
          </div>
          ${order.customer_email ? `
          <div class="meta-row">
            <div class="meta-label">Email</div>
            <div class="meta-value">${escapeHtml(order.customer_email)}</div>
          </div>` : ''}
          ${order.delivery_address ? `
          <div class="meta-row">
            <div class="meta-label">Address</div>
            <div class="meta-value">${escapeHtml(order.delivery_address)}</div>
          </div>` : `
          <div class="meta-row">
            <div class="meta-label">Location</div>
            <div class="meta-value">${escapeHtml(order.location_name || '-')}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Region</div>
            <div class="meta-value">${escapeHtml(order.region_name || '-')}</div>
          </div>`}
          <div class="meta-row">
            <div class="meta-label">Settlement</div>
            <div class="meta-value">${escapeHtml(settlementText)}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Paid</div>
            <div class="meta-value">KES ${Number(order.amount_paid || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Balance</div>
            <div class="meta-value">KES ${Number(order.balance_due || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
          </div>
          <div class="meta-row">
            <div class="meta-label">Due Date</div>
            <div class="meta-value">${escapeHtml(order.due_date || '-')}</div>
          </div>

          <div class="line"></div>

          <div class="section-title">Products</div>
          <div class="items-section">
            <div class="items-header">
              <span>Product Details</span>
              <span>Line Total</span>
            </div>
            ${itemsHtml}
          </div>

          <div class="totals">
            <div class="total-row">
              <span>Total Product Lines</span>
              <span>${items.length}</span>
            </div>
            <div class="total-row">
              <span>Total Quantity</span>
              <span>${totalQuantity}</span>
            </div>
            <div class="total-row grand-total">
              <span>Total Amount</span>
              <span>KES ${Number(order.total_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
            </div>
          </div>

          ${
            order.notes
              ? `
            <div class="line"></div>
            <div class="section-title">Notes</div>
            <div class="note">${escapeHtml(order.notes)}</div>
          `
              : ''
          }

          <div class="line"></div>

          <div class="footer">
            <div>Thank you for shopping with us!</div>
            <div>XPOSE DISTRIBUTORS</div>
            <div>${new Date().toLocaleString('en-US', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}</div>
          </div>
        </div>

        <script>
          window.addEventListener('load', function () { window.print(); });
        </script>
      </body>
      </html>
    `;

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(receiptHtml);
    }

    return handleSuccess(res, 200, 'Order print sheet retrieved successfully', {
      html: receiptHtml,
      order,
      items,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('getOrderForPrint error:', err.message);
    return handleError(res, 500, 'Failed to generate order print sheet', err);
  } finally {
    client.release();
  }
};

// GET ORDER STATISTICS
const getOrderStatistics = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let query = `
      SELECT
        COUNT(*) AS total_orders,
        COUNT(CASE WHEN order_status = 'completed' THEN 1 END) AS completed_orders,
        COUNT(CASE WHEN order_status = 'pending' THEN 1 END) AS pending_orders,
        COUNT(CASE WHEN payment_status = 'completed' THEN 1 END) AS paid_orders,
        COUNT(CASE WHEN COALESCE(is_printed, FALSE) = TRUE THEN 1 END) AS printed_orders,
        COUNT(CASE WHEN COALESCE(is_printed, FALSE) = FALSE THEN 1 END) AS not_printed_orders,
        COUNT(
          CASE
            WHEN order_type = 'route'
             AND GREATEST(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0) > 0
            THEN 1
          END
        ) AS route_credit_open,
        COUNT(
          CASE
            WHEN order_type = 'route'
             AND GREATEST(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0) > 0
             AND due_date IS NOT NULL
             AND due_date < CURRENT_DATE
            THEN 1
          END
        ) AS overdue_route_orders,
        COALESCE(SUM(total_amount), 0) AS total_revenue,
        COALESCE(SUM(COALESCE(amount_paid, 0)), 0) AS total_paid_amount,
        COALESCE(SUM(GREATEST(COALESCE(total_amount, 0) - COALESCE(amount_paid, 0), 0)), 0) AS total_outstanding_balance,
        AVG(total_amount) AS avg_order_value,
        COUNT(DISTINCT customer_id) AS unique_customers
      FROM orders
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (start_date) {
      params.push(start_date);
      query += ` AND created_at >= $${paramIndex}`;
      paramIndex++;
    }

    if (end_date) {
      params.push(end_date);
      query += ` AND created_at <= $${paramIndex}`;
      paramIndex++;
    }

    const result = await pool.query(query, params);

    return handleSuccess(res, 200, 'Statistics retrieved successfully', result.rows[0]);
  } catch (err) {
    console.error('getOrderStatistics error:', err.message);
    return handleError(res, 500, 'Failed to retrieve statistics', err);
  }
};

// Derive a structured tracking stage and human-readable summary from order fields.
// This is used only by the public tracking endpoint so customers can render a
// clear progress journey without the storefront needing to contain business logic.
function deriveTrackingStage(order) {
  const status = order.order_status;
  const paymentStatus = order.payment_status;
  const paid = toNumber(order.amount_paid, 0);
  const total = toNumber(order.total_amount, 0);
  const fullyPaid = total > 0 && paid >= total;

  if (status === 'cancelled') {
    return {
      current_tracking_stage: 'cancelled',
      tracking_summary: 'This order has been cancelled.',
    };
  }

  if (status === 'completed') {
    return {
      current_tracking_stage: 'completed',
      tracking_summary: 'Your order has been delivered and completed. Thank you!',
    };
  }

  if (status === 'dispatched') {
    return {
      current_tracking_stage: 'dispatched',
      tracking_summary: 'Your order has been dispatched and is on its way to you.',
    };
  }

  if (status === 'processing') {
    return {
      current_tracking_stage: 'processing',
      tracking_summary: 'Your order is currently being processed and prepared for dispatch.',
    };
  }

  // status === 'pending'
  if (paymentStatus === 'completed' || fullyPaid) {
    return {
      current_tracking_stage: 'payment_confirmed',
      tracking_summary: 'Payment confirmed. Your order has been received and is awaiting processing.',
    };
  }

  return {
    current_tracking_stage: 'order_received',
    tracking_summary: 'Your order has been received and is awaiting payment confirmation.',
  };
}

const trackPublicOrder = async (req, res) => {
  try {
    const trackingToken = String(req.query.t || req.query.token || '').trim();
    const orderNumber = String(req.query.order_number || '').trim();
    const phoneDigits = String(req.query.customer_phone || '').replace(/\D/g, '');
    const phoneVariants = getPhoneLookupVariants(req.query.customer_phone);
    const phoneLast3Digits = String(req.query.phone_last3 || req.query.phone_last_digits || '')
      .replace(/\D/g, '');
    const phoneLast3 = phoneLast3Digits.length >= 3 ? phoneLast3Digits.slice(-3) : '';
    const verificationType = String(req.query.verification_type || '').trim().toLowerCase();
    const verificationAnswer = String(req.query.verification_answer || '').trim();
    const recoveryVerification =
      Boolean(orderNumber && phoneLast3 && verificationType && verificationAnswer);

    let trackingClaims = null;
    let accessLevel = 'manual_verification';

    if (trackingToken) {
      trackingClaims = verifyOrderTrackingToken(trackingToken);

      if (!trackingClaims) {
        return handleError(res, 401, 'Tracking link is invalid or expired');
      }

      accessLevel = 'secure_link';
    } else if (!orderNumber || (!phoneDigits && !recoveryVerification)) {
      return handleError(res, 400, 'secure tracking token, full phone verification, or recovery verification is required');
    }

    let whereClause;
    let queryParams;

    if (trackingClaims) {
      whereClause = 'WHERE o.id = $1 AND o.order_number = $2';
      queryParams = [trackingClaims.order_id, trackingClaims.order_number];
    } else if (recoveryVerification && !phoneDigits) {
      whereClause = `WHERE o.order_number = $1
        AND RIGHT(regexp_replace(COALESCE(o.customer_phone, ''), '\\D', '', 'g'), 3) = $2`;
      queryParams = [orderNumber, phoneLast3];
      accessLevel = 'recovery_verification';
    } else {
      whereClause = `WHERE o.order_number = $1
        AND regexp_replace(COALESCE(o.customer_phone, ''), '\\D', '', 'g') = ANY($2::text[])`;
      queryParams = [orderNumber, phoneVariants];
    }

    const orderResult = await pool.query(
      `
      SELECT
        o.*,
        COALESCE(o.amount_paid, 0) AS amount_paid,
        COUNT(DISTINCT oi.id) AS item_count,
        COALESCE(SUM(oi.quantity), 0) AS total_items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      ${whereClause}
      GROUP BY o.id
      ORDER BY o.id DESC
      LIMIT 1
      `,
      queryParams
    );

    if (orderResult.rows.length === 0) {
      return handleError(res, 404, 'Order not found for the provided details');
    }

    const order = enrichOrder(orderResult.rows[0]);

    if (accessLevel === 'recovery_verification' && !verifyTrackingRecoveryAnswer(order, verificationType, verificationAnswer)) {
      return handleError(res, 404, 'Order not found for the provided verification details');
    }

    const itemsResult = await pool.query(
      `
      SELECT
        oi.product_id,
        oi.quantity,
        oi.price_at_purchase,
        COALESCE(oi.line_total, oi.quantity * oi.price_at_purchase) AS line_total,
        COALESCE(p.name, '[Product #' || oi.product_id || ' — deleted]') AS product_name,
        p.sku
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id ASC
      `,
      [order.id]
    );

    const items = itemsResult.rows.map((item) => ({
      ...item,
      price_at_purchase: roundMoney(item.price_at_purchase),
      line_total: roundMoney(item.line_total),
      unit_price: roundMoney(item.price_at_purchase),
      total_price: roundMoney(item.line_total),
    }));

    // Attach structured tracking fields for customer-facing progress display.
    // These supplement the raw order fields without removing any existing data.
    const trackingStage = deriveTrackingStage(order);
    order.current_tracking_stage = trackingStage.current_tracking_stage;
    order.tracking_summary = trackingStage.tracking_summary;

    const publicOrder = {
      id: order.id,
      order_number: order.order_number,
      order_type: order.order_type,
      customer_name: order.customer_name,
      customer_phone_masked: maskPhone(order.customer_phone),
      total_amount: order.total_amount,
      amount_paid: order.amount_paid,
      balance_due: order.balance_due,
      payment_status: order.payment_status,
      payment_state: order.payment_state,
      order_status: order.order_status,
      settlement_label: order.settlement_label,
      current_tracking_stage: order.current_tracking_stage,
      tracking_summary: order.tracking_summary,
      item_count: Number(order.item_count || items.length || 0),
      total_items: Number(order.total_items || 0),
      created_at: order.created_at,
      updated_at: order.updated_at,
      status_changed_at: order.status_changed_at,
      last_payment_date: order.last_payment_date,
      items,
      access_level: accessLevel,
      tracking_token_verified: accessLevel === 'secure_link',
    };

    return handleSuccess(
      res,
      200,
      'Order tracking retrieved successfully',
      attachOrderTrackingLink(publicOrder)
    );
  } catch (err) {
    console.error('trackPublicOrder error:', err.message);
    return handleError(res, 500, 'Failed to track order', err);
  }
};

module.exports = {
  getAllOrders,
  getOrderById,
  guestCheckout,
  createOrder,
  updateOrderStatus,
  getOrdersBySalesRep,
  getOrderForPrint,
  getOrderStatistics,
  trackPublicOrder,
  loadPricingContext,
};
