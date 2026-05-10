'use strict';

const Decimal = require('decimal.js');

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

function normalizeUnitPrice(unitPrice) {
  if (unitPrice == null) return null;

  const amount =
    unitPrice instanceof Decimal
      ? unitPrice
      : new Decimal(typeof unitPrice.toFixed === 'function' ? unitPrice.toFixed(2) : unitPrice);

  return roundMoney(amount.toNumber());
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
    const unitPrice = normalizeUnitPrice(item.unit_price);
    const lineTotal =
      unitPrice != null
        ? roundMoney(new Decimal(item.unit_price).mul(Number(item.quantity || 0)).toNumber())
        : null;

    return {
      product_id: item.product_id,
      quantity: item.quantity,
      unit_price: unitPrice,
      line_total: lineTotal,
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
