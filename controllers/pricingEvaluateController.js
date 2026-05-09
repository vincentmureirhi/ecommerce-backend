'use strict';

/**
 * Public pricing evaluation endpoint.
 *
 * Allows the customer frontend to compute the server-authoritative price for a
 * set of cart items BEFORE placing an order.  The response includes:
 *   - The resolved unit price and price_source for every item
 *   - Whether wholesale is currently eligible for each item
 *   - The threshold quantity that governs wholesale eligibility
 *   - A human-readable pricing_label suitable for display in the UI
 *
 * This endpoint is intentionally public (no auth required) so that the
 * storefront can show live pricing without the customer being signed in.
 */

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const {
  evaluateCartPricingWithMeta,
  describePricing,
  RULE_TYPES,
} = require('../utils/pricingRuleEvaluator');

/**
 * Batch-fetch products with their active pricing rule and price tiers.
 * Returns { productMap, tiersMap } keyed by product id.
 * (Mirrors the same helper in orderController — kept DRY-enough by staying
 *  in this module; if a shared db-helper module is added later this can move.)
 */
async function loadPricingContext(client, productIds) {
  if (!productIds || productIds.length === 0) {
    return { productMap: {}, tiersMap: {} };
  }

  const productResult = await client.query(
    `
    SELECT
      p.id, p.name, p.sku,
      p.retail_price, p.wholesale_price, p.min_qty_wholesale,
      p.requires_manual_price, p.pricing_rule_id,
      pr.rule_type  AS pricing_rule_type,
      pr.threshold_qty AS pricing_rule_threshold_qty,
      pr.name       AS pricing_rule_name
    FROM products p
    LEFT JOIN pricing_rules pr
      ON pr.id = p.pricing_rule_id AND pr.is_active = TRUE
    WHERE p.id = ANY($1)
    `,
    [productIds]
  );

  const productMap = {};
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
            }
          : null,
    };
  }

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

  return { productMap, tiersMap };
}

/**
 * POST /api/pricing/evaluate
 *
 * Body: { items: [{ product_id: number, quantity: number }] }
 *
 * Returns per-item pricing metadata so the frontend can:
 *  1. Show the correct price for each quantity
 *  2. Know whether wholesale is currently unlocked
 *  3. Know what threshold must be reached to unlock wholesale
 *  4. Display a human-readable pricing label to the customer
 */
const evaluatePricing = async (req, res) => {
  const client = await pool.connect();
  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return handleError(res, 400, 'items must be a non-empty array');
    }

    const rawItems = [];
    for (const item of items) {
      const productId = Number(item.product_id);
      const quantity = Number(item.quantity);

      if (!Number.isInteger(productId) || productId <= 0) {
        return handleError(res, 400, 'Each item must have a valid product_id');
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return handleError(res, 400, `quantity must be a positive integer for product_id ${productId}`);
      }
      rawItems.push({ product_id: productId, quantity });
    }

    const productIds = rawItems.map((i) => i.product_id);
    const { productMap, tiersMap } = await loadPricingContext(client, productIds);

    // Evaluate pricing with full metadata
    const evaluated = evaluateCartPricingWithMeta(rawItems, productMap, tiersMap);

    // Shape response — expose enough for the UI; omit internal Decimal objects
    const result = evaluated.map((line) => {
      const product = productMap[line.product_id];
      const productName = product ? product.name : null;
      const productSku  = product ? product.sku  : null;

      return {
        product_id:            line.product_id,
        product_name:          productName,
        product_sku:           productSku,
        quantity:              line.quantity,
        unit_price:            line.unit_price != null ? Number(line.unit_price.toFixed(2)) : null,
        retail_price:          line.retail_price != null ? Number(line.retail_price.toFixed(2)) : null,
        wholesale_price:       line.wholesale_price != null ? Number(line.wholesale_price.toFixed(2)) : null,
        price_source:          line.price_source,
        is_wholesale_eligible: line.is_wholesale_eligible,
        threshold_qty:         line.threshold_qty,
        effective_qty:         line.effective_qty,
        rule_type:             line.rule_type,
        rule_name:             line.rule_name,
        pricing_label:         line.pricing_label,
        line_total:
          line.unit_price != null
            ? Number(line.unit_price.mul(line.quantity).toFixed(2))
            : null,
      };
    });

    return handleSuccess(res, 200, 'Pricing evaluated', result);
  } catch (err) {
    console.error('evaluatePricing error:', err.message);
    return handleError(res, 500, 'Failed to evaluate pricing', err);
  } finally {
    client.release();
  }
};

/**
 * GET /api/pricing/rule-summary/:id
 *
 * Returns a human-readable summary of a specific pricing rule.
 * Authenticated endpoint (token required) for admin / storefront use.
 */
const getPricingRuleSummary = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return handleError(res, 400, 'Invalid rule id');
    }

    const ruleResult = await pool.query(
      `SELECT * FROM pricing_rules WHERE id = $1`,
      [id]
    );
    if (ruleResult.rowCount === 0) {
      return handleError(res, 404, 'Pricing rule not found');
    }

    const rule = ruleResult.rows[0];

    // Build a human-readable explanation of what this rule means
    let explanation = '';
    switch (rule.rule_type) {
      case RULE_TYPES.CONSTANT:
        explanation =
          'Products using this rule are always sold at retail price regardless of quantity ordered.';
        break;
      case RULE_TYPES.SKU_THRESHOLD:
        explanation = rule.threshold_qty
          ? `Products using this rule are sold at retail price until ${rule.threshold_qty} or more units of that specific product are ordered, at which point the wholesale price applies.`
          : 'Products using this rule are sold at retail price until the per-product minimum wholesale quantity is reached.';
        break;
      case RULE_TYPES.GROUP_THRESHOLD:
        explanation = rule.threshold_qty
          ? `Products sharing this rule form a combo group. When the combined quantity across all products in this group reaches ${rule.threshold_qty} units, every product in the group qualifies for wholesale pricing.`
          : 'Products sharing this rule form a combo group. Wholesale pricing applies when the combined quantity meets the configured threshold.';
        break;
      case RULE_TYPES.TIERED:
        explanation =
          'Products using this rule follow a tiered pricing schedule. The price per unit decreases as quantity increases, according to the price tiers configured on each product.';
        break;
      default:
        explanation = 'Unknown rule type.';
    }

    return handleSuccess(res, 200, 'Pricing rule summary', {
      id:            rule.id,
      name:          rule.name,
      description:   rule.description,
      rule_type:     rule.rule_type,
      threshold_qty: rule.threshold_qty,
      is_active:     rule.is_active,
      explanation,
    });
  } catch (err) {
    console.error('getPricingRuleSummary error:', err.message);
    return handleError(res, 500, 'Failed to get pricing rule summary', err);
  }
};

module.exports = {
  evaluatePricing,
  getPricingRuleSummary,
};
