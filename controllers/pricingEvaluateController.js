'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');
const { evaluateCartPricingWithMeta } = require('../utils/pricingRuleEvaluator');
const {
  PricingEvaluationValidationError,
  normalizeEvaluationItems,
  mapPricingEvaluationItems,
} = require('../utils/pricingEvaluationApi');
const { loadPricingContext } = require('./orderController');

const evaluatePricing = async (req, res) => {
  let client;

  try {
    const rawItems = normalizeEvaluationItems(req.body?.items);

    client = await pool.connect();

    const productIds = rawItems.map((item) => item.product_id);
    const { productMap, tiersMap } = await loadPricingContext(client, productIds);

    for (const item of rawItems) {
      if (!productMap[item.product_id]) {
        throw new PricingEvaluationValidationError(`Product not found: ${item.product_id}`, 404);
      }
    }

    const evaluatedItems = evaluateCartPricingWithMeta(rawItems, productMap, tiersMap);
    return handleSuccess(res, 200, 'Pricing evaluated successfully', mapPricingEvaluationItems(evaluatedItems));
  } catch (err) {
    if (err instanceof PricingEvaluationValidationError) {
      return handleError(res, err.statusCode || 400, err.message);
    }

    console.error('evaluatePricing error:', err.message);
    return handleError(res, 500, 'Failed to evaluate pricing', err);
  } finally {
    if (client) client.release();
  }
};

module.exports = {
  evaluatePricing,
};
