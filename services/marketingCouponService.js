'use strict';

class CouponValidationError extends Error {
  constructor(message, code = 'COUPON_NOT_APPLICABLE', details = null) {
    super(message);
    this.name = 'CouponValidationError';
    this.code = code;
    this.details = details;
    this.isCouponValidationError = true;
  }
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Number(toNumber(value, 0).toFixed(2));
}

function normalizeCouponCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
}

function normalizeScope(value) {
  const scope = String(value || 'all').trim().toLowerCase();
  if (['normal', 'route', 'vendor', 'all'].includes(scope)) return scope;
  return 'all';
}

function isInWindow(row) {
  const now = Date.now();
  const startsAt = row.starts_at ? new Date(row.starts_at).getTime() : null;
  const endsAt = row.ends_at ? new Date(row.ends_at).getTime() : null;

  if (startsAt && Number.isFinite(startsAt) && startsAt > now) return false;
  if (endsAt && Number.isFinite(endsAt) && endsAt < now) return false;
  return true;
}

function normalizeItem(item) {
  const quantity = Math.max(0, toNumber(item.quantity, 0));
  const suppliedLineTotal = item.line_total ?? item.total_price;
  const unitPrice = roundMoney(item.unit_price ?? item.price_at_purchase ?? item.price ?? 0);

  return {
    product_id: Number(item.product_id),
    category_id: item.category_id == null || item.category_id === '' ? null : Number(item.category_id),
    quantity,
    line_total: suppliedLineTotal == null
      ? roundMoney(quantity * unitPrice)
      : roundMoney(suppliedLineTotal),
  };
}

async function loadCampaignTargets(client, campaignId) {
  if (!campaignId) {
    return { productIds: new Set(), categoryIds: new Set(), regionIds: new Set() };
  }

  const [products, categories, regions] = await Promise.all([
    client.query('SELECT product_id FROM marketing_campaign_products WHERE campaign_id = $1', [campaignId]),
    client.query('SELECT category_id FROM marketing_campaign_categories WHERE campaign_id = $1', [campaignId]),
    client.query('SELECT region_id FROM marketing_campaign_regions WHERE campaign_id = $1', [campaignId]),
  ]);

  return {
    productIds: new Set(products.rows.map((row) => Number(row.product_id)).filter(Number.isFinite)),
    categoryIds: new Set(categories.rows.map((row) => Number(row.category_id)).filter(Number.isFinite)),
    regionIds: new Set(regions.rows.map((row) => Number(row.region_id)).filter(Number.isFinite)),
  };
}

function itemMatchesTargets(item, targets) {
  const hasProductTargets = targets.productIds.size > 0;
  const hasCategoryTargets = targets.categoryIds.size > 0;

  if (!hasProductTargets && !hasCategoryTargets) return true;
  if (hasProductTargets && targets.productIds.has(Number(item.product_id))) return true;
  if (hasCategoryTargets && item.category_id != null && targets.categoryIds.has(Number(item.category_id))) return true;
  return false;
}

function calculateDiscount(row, eligibleSubtotal) {
  const discountType = String(row.discount_type || '').trim().toLowerCase();
  const discountValue = toNumber(row.discount_value, 0);
  const maxDiscount = row.max_discount_amount == null ? null : toNumber(row.max_discount_amount, null);

  if (eligibleSubtotal <= 0) return 0;

  let discount = 0;
  if (discountType === 'percentage') {
    discount = eligibleSubtotal * (discountValue / 100);
  } else if (discountType === 'fixed_amount') {
    discount = discountValue;
  } else {
    throw new CouponValidationError('Coupon discount type is not supported', 'COUPON_CONFIGURATION_ERROR');
  }

  if (maxDiscount != null && Number.isFinite(maxDiscount) && maxDiscount > 0) {
    discount = Math.min(discount, maxDiscount);
  }

  return roundMoney(Math.min(Math.max(discount, 0), eligibleSubtotal));
}

async function countCustomerCouponUses(client, couponId, customerId, customerPhone) {
  const phoneDigits = String(customerPhone || '').replace(/\D/g, '');

  const result = await client.query(
    `
    SELECT COUNT(*)::int AS uses
    FROM coupon_redemptions
    WHERE coupon_id = $1
      AND status = 'redeemed'
      AND (
        ($2::int IS NOT NULL AND customer_id = $2)
        OR ($3::text <> '' AND regexp_replace(COALESCE(customer_phone, ''), '\\D', '', 'g') = $3)
      )
    `,
    [couponId, customerId ? Number(customerId) : null, phoneDigits]
  );

  return Number(result.rows[0]?.uses || 0);
}

async function validateCouponForOrder(client, input = {}, options = {}) {
  const code = normalizeCouponCode(input.couponCode || input.coupon_code || input.promo_code);
  if (!code) {
    throw new CouponValidationError('Coupon code is required', 'COUPON_CODE_REQUIRED');
  }

  const lockClause = options.lock ? 'FOR UPDATE OF c' : '';
  const couponResult = await client.query(
    `
    SELECT
      c.*,
      mc.id AS campaign_id,
      mc.campaign_code,
      mc.name AS campaign_name,
      mc.status AS campaign_status,
      mc.customer_scope AS campaign_customer_scope,
      mc.starts_at AS campaign_starts_at,
      mc.ends_at AS campaign_ends_at
    FROM coupons c
    LEFT JOIN marketing_campaigns mc ON mc.id = c.campaign_id
    WHERE UPPER(c.code) = $1
    LIMIT 1
    ${lockClause}
    `,
    [code]
  );

  const coupon = couponResult.rows[0];
  if (!coupon) {
    throw new CouponValidationError('Coupon code was not found', 'COUPON_NOT_FOUND');
  }

  if (String(coupon.status || '').toLowerCase() !== 'active') {
    throw new CouponValidationError('This coupon is not active', 'COUPON_INACTIVE');
  }

  if (!isInWindow(coupon)) {
    throw new CouponValidationError('This coupon is not available right now', 'COUPON_OUTSIDE_WINDOW');
  }

  if (coupon.campaign_id) {
    if (String(coupon.campaign_status || '').toLowerCase() !== 'active') {
      throw new CouponValidationError('The campaign linked to this coupon is not active', 'CAMPAIGN_INACTIVE');
    }

    if (!isInWindow({ starts_at: coupon.campaign_starts_at, ends_at: coupon.campaign_ends_at })) {
      throw new CouponValidationError('The campaign linked to this coupon is not available right now', 'CAMPAIGN_OUTSIDE_WINDOW');
    }
  }

  const orderType = normalizeScope(input.orderType || input.order_type || 'normal');
  const couponScope = normalizeScope(coupon.customer_scope);
  const campaignScope = normalizeScope(coupon.campaign_customer_scope);
  const effectiveScope = couponScope !== 'all' ? couponScope : campaignScope;

  if (effectiveScope !== 'all' && effectiveScope !== orderType) {
    throw new CouponValidationError(
      effectiveScope === 'route'
        ? 'This coupon is only for route customers'
        : 'This coupon is not available for this order type',
      'COUPON_SCOPE_MISMATCH',
      { required_scope: effectiveScope, order_type: orderType }
    );
  }

  const subtotal = roundMoney(input.subtotalAmount ?? input.subtotal_amount ?? input.cart_total ?? 0);
  if (subtotal <= 0) {
    throw new CouponValidationError('Cart total must be greater than zero', 'COUPON_EMPTY_CART');
  }

  const minOrderAmount = roundMoney(coupon.min_order_amount || 0);
  if (minOrderAmount > 0 && subtotal < minOrderAmount) {
    throw new CouponValidationError(
      `Spend at least KES ${minOrderAmount.toLocaleString('en-KE')} to use this coupon`,
      'COUPON_MINIMUM_NOT_MET',
      { min_order_amount: minOrderAmount, subtotal_amount: subtotal }
    );
  }

  const maxTotalUses = Number(coupon.max_total_uses || 0);
  const usesCount = Number(coupon.uses_count || 0);
  if (maxTotalUses > 0 && usesCount >= maxTotalUses) {
    throw new CouponValidationError('This coupon has reached its usage limit', 'COUPON_USAGE_LIMIT_REACHED');
  }

  const perCustomerLimit = Math.max(
    0,
    Number(coupon.max_uses_per_customer || 0),
    Number(coupon.max_uses_per_phone || 0)
  );

  if (perCustomerLimit > 0) {
    const existingUses = await countCustomerCouponUses(
      client,
      coupon.id,
      input.customerId || input.customer_id || null,
      input.customerPhone || input.customer_phone || null
    );

    if (existingUses >= perCustomerLimit) {
      throw new CouponValidationError('This customer has already used this coupon', 'COUPON_CUSTOMER_LIMIT_REACHED');
    }
  }

  const targets = await loadCampaignTargets(client, coupon.campaign_id);
  const normalizedItems = Array.isArray(input.items) ? input.items.map(normalizeItem) : [];
  if (targets.categoryIds.size > 0 && normalizedItems.length > 0) {
    const productIds = normalizedItems.map((item) => item.product_id).filter(Number.isFinite);
    const categoryRows = await client.query(
      `SELECT id, category_id FROM products WHERE id = ANY($1::int[])`,
      [productIds]
    );
    const categoryByProduct = new Map(categoryRows.rows.map((row) => [Number(row.id), row.category_id == null ? null : Number(row.category_id)]));
    normalizedItems.forEach((item) => {
      if (categoryByProduct.has(item.product_id)) item.category_id = categoryByProduct.get(item.product_id);
    });
  }
  const hasTargets = targets.productIds.size > 0 || targets.categoryIds.size > 0;
  const eligibleItems = normalizedItems.length
    ? normalizedItems.filter((item) => itemMatchesTargets(item, targets))
    : [];
  const eligibleSubtotal = normalizedItems.length
    ? roundMoney(eligibleItems.reduce((sum, item) => sum + item.line_total, 0))
    : subtotal;

  if (hasTargets && eligibleSubtotal <= 0) {
    throw new CouponValidationError('This coupon does not apply to the selected products', 'COUPON_TARGET_MISMATCH');
  }

  const discountAmount = calculateDiscount(coupon, eligibleSubtotal);
  if (discountAmount <= 0) {
    throw new CouponValidationError('This coupon did not produce a discount', 'COUPON_NO_DISCOUNT');
  }

  const finalTotal = roundMoney(Math.max(0, subtotal - discountAmount));

  return {
    coupon_id: coupon.id,
    campaign_id: coupon.campaign_id || null,
    campaign_code: coupon.campaign_code || null,
    campaign_name: coupon.campaign_name || null,
    coupon_code: coupon.code,
    coupon_name: coupon.name,
    discount_type: coupon.discount_type,
    discount_value: roundMoney(coupon.discount_value),
    subtotal_amount: subtotal,
    eligible_subtotal_amount: eligibleSubtotal,
    discount_amount: discountAmount,
    final_total_amount: finalTotal,
    customer_scope: effectiveScope,
    applies_to: coupon.applies_to || (hasTargets ? 'campaign_targets' : 'all'),
    metadata: {
      product_targets: targets.productIds.size,
      category_targets: targets.categoryIds.size,
      matched_items: eligibleItems.length,
      total_items: normalizedItems.length,
    },
  };
}

async function recordCouponRedemption(client, validation, order = {}) {
  if (!validation?.coupon_id || !order?.orderId) return null;

  const result = await client.query(
    `
    INSERT INTO coupon_redemptions
      (coupon_id, campaign_id, order_id, customer_id, customer_phone, order_type,
       subtotal_amount, discount_amount, final_total_amount, status, request_id, metadata, redeemed_at, created_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'redeemed', $10, $11::jsonb, NOW(), NOW())
    ON CONFLICT (coupon_id, order_id) DO NOTHING
    RETURNING *
    `,
    [
      validation.coupon_id,
      validation.campaign_id || null,
      order.orderId,
      order.customerId || null,
      order.customerPhone || null,
      order.orderType || null,
      validation.subtotal_amount,
      validation.discount_amount,
      validation.final_total_amount,
      order.requestId || null,
      JSON.stringify({
        ...validation.metadata,
        order_number: order.orderNumber || null,
        coupon_code: validation.coupon_code,
      }),
    ]
  );

  if (!result.rows[0]) {
    const existing = await client.query(
      `SELECT * FROM coupon_redemptions WHERE coupon_id = $1 AND order_id = $2 LIMIT 1`,
      [validation.coupon_id, order.orderId]
    );
    return existing.rows[0] || null;
  }

  if (validation.campaign_id) {
    await client.query(
      `
      INSERT INTO marketing_campaign_events
        (campaign_id, event_type, order_id, customer_id, request_id, metadata, created_at)
      SELECT $1, 'conversion', $2, $3, $4, $5::jsonb, NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM marketing_campaign_events
        WHERE campaign_id = $1 AND event_type = 'conversion' AND order_id = $2
      )
      `,
      [
        validation.campaign_id,
        order.orderId,
        order.customerId || null,
        order.requestId || null,
        JSON.stringify({ coupon_code: validation.coupon_code, final_total_amount: validation.final_total_amount }),
      ]
    );
  }

  await client.query(
    `
    UPDATE coupons
    SET uses_count = COALESCE(uses_count, 0) + 1,
        last_redeemed_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
    `,
    [validation.coupon_id]
  );

  return result.rows[0];
}

module.exports = {
  CouponValidationError,
  normalizeCouponCode,
  validateCouponForOrder,
  recordCouponRedemption,
};