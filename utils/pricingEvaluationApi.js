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
  if (value == null) return null;

  try {
    const amount = value instanceof Decimal ? value : new Decimal(value);
    return amount.toDecimalPlaces(2).toNumber();
  } catch {
    return null;
  }
}

function normalizeUnitPrice(unitPrice) {
  if (unitPrice == null) return null;

  const amount =
    unitPrice instanceof Decimal
      ? unitPrice
      : new Decimal(unitPrice);

  return roundMoney(amount);
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
    const originalUnitPrice = normalizeUnitPrice(item.original_unit_price);
    const lineTotal =
      unitPrice != null
        ? roundMoney(new Decimal(unitPrice).mul(Number(item.quantity || 0)))
        : null;

    return {
            rule_name: item.rule_name || null,
      product_id: item.product_id,
      quantity: item.quantity,
      unit_price: unitPrice,
      line_total: lineTotal,
      wholesale_eligible: Boolean(item.is_wholesale_eligible),
      threshold_quantity: item.threshold_qty != null ? Number(item.threshold_qty) : null,
      effective_quantity: item.effective_qty != null ? Number(item.effective_qty) : Number(item.quantity || 0),
      rule_type: item.rule_type,
      rule_name: item.rule_name || null,
      pricing_group_id: item.pricing_group_id || null,
      pricing_group_name: item.pricing_group_name || null,
      pricing_label: item.pricing_label,
      flash_sale_id: item.flash_sale_id || null,
      flash_sale_name: item.flash_sale_name || null,
      flash_sale_end_date: item.flash_sale_end_date || null,
      flash_sale_discount_type: item.flash_sale_discount_type || null,
      flash_sale_discount_value:
        item.flash_sale_discount_value != null ? Number(item.flash_sale_discount_value) : null,
      original_unit_price: originalUnitPrice,
    };
  });
}

module.exports = {
  PricingEvaluationValidationError,
  normalizeEvaluationItems,
  mapPricingEvaluationItems,
};
