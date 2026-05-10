'use strict';

class PricingEvaluationValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'PricingEvaluationValidationError';
    this.statusCode = statusCode;
  }
}

function roundMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Number(amount.toFixed(2));
}

function normalizeEvaluationItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PricingEvaluationValidationError('items must be a non-empty array');
  }

  return items.map((item, index) => {
    const productId = Number(item?.product_id);
    const quantity = Number(item?.quantity);

    if (!Number.isInteger(productId) || productId <= 0) {
      throw new PricingEvaluationValidationError(`items[${index}].product_id must be a positive integer`);
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new PricingEvaluationValidationError(`items[${index}].quantity must be a positive integer`);
    }

    return { product_id: productId, quantity };
  });
}

function mapPricingEvaluationItems(evaluatedItems) {
  const safeItems = Array.isArray(evaluatedItems) ? evaluatedItems : [];

  return safeItems.map((item) => {
    const unitPrice =
      item.unit_price != null
        ? roundMoney(typeof item.unit_price.toFixed === 'function' ? item.unit_price.toFixed(2) : item.unit_price)
        : null;

    return {
      product_id: item.product_id,
      quantity: item.quantity,
      unit_price: unitPrice,
      line_total: unitPrice != null ? roundMoney(unitPrice * Number(item.quantity || 0)) : null,
      wholesale_eligible: Boolean(item.is_wholesale_eligible),
      threshold_quantity: item.threshold_qty != null ? Number(item.threshold_qty) : null,
      effective_quantity: item.effective_qty != null ? Number(item.effective_qty) : Number(item.quantity || 0),
      rule_type: item.rule_type,
      pricing_label: item.pricing_label,
    };
  });
}

module.exports = {
  PricingEvaluationValidationError,
  normalizeEvaluationItems,
  mapPricingEvaluationItems,
};
