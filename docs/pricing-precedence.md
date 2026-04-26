# Pricing Precedence and Backend Authority

> **Scope**: `ecommerce-backend` — authoritative pricing reference for contributors.

---

## 1. Backend is the Final Pricing Authority

All order prices are **computed server-side** at order-creation time.
Client-submitted `unit_price` values are:

- **Ignored** for all standard products (retail, wholesale, tiered, threshold-based).
- **Required only** for `requires_manual_price` products (admin-created orders only).

The storefront and admin UI may *display* estimated prices for UX purposes, but the
backend always recalculates and locks the price at order creation.  The locked price
is immutable via the `trg_prevent_order_item_pricing_update` trigger.

---

## 2. Pricing Rule Types

Rules are stored in the `pricing_rules` table and assigned to products via
`products.pricing_rule_id`.

| Rule Type        | Description |
|------------------|-------------|
| `CONSTANT`       | Always uses `retail_price`, regardless of quantity.  No quantity-based switching. |
| `SKU_THRESHOLD`  | Uses `wholesale_price` when the quantity of **this exact SKU** in the order ≥ `threshold_qty`.  Falls back to `retail_price` below threshold. |
| `GROUP_THRESHOLD`| Uses `wholesale_price` when the **combined quantity of all products sharing this rule** in the order ≥ `threshold_qty`.  Falls back to `retail_price`. |
| `TIERED`         | Uses `product_price_tiers` rows for the product.  Tiers are matched by quantity range.  Falls back to `retail_price` if no tier matches. |

Rules are managed via `GET/POST/PUT/DELETE /api/pricing-rules` (admin auth required for mutations).

---

## 3. Pricing Precedence / Order of Evaluation

For each line item the evaluator (`utils/pricingRuleEvaluator.js → evaluateCartPricing`) applies:

```
1. requires_manual_price = true
   → price_source = 'manual_price', unit_price = null
   → admin must supply unit_price; order rejected if missing

2. Product has a pricing_rule assigned:
   a. TIERED          → resolve via product_price_tiers
                         price_source = 'tiered'
   b. CONSTANT        → retail_price always
                         price_source = 'constant'
   c. SKU_THRESHOLD   → wholesale_price if this-SKU qty ≥ threshold_qty
                         price_source = 'sku_threshold'
                         else retail_price, price_source = 'retail_fallback'
   d. GROUP_THRESHOLD → wholesale_price if sum(qty) for this rule ≥ threshold_qty
                         price_source = 'group_threshold'
                         else retail_price, price_source = 'retail_fallback'

3. No pricing_rule (legacy fallback):
   a. tier match in product_price_tiers → tier.unit_price
      price_source = 'tier'
   b. qty ≥ min_qty_wholesale AND wholesale_price set → wholesale_price
      price_source = 'wholesale'
   c. retail_price set → retail_price
      price_source = 'retail_fallback'
   d. retail_price not set → unit_price = null
      price_source = 'retail_fallback'
```

---

## 4. `price_source` Values

Written to `order_items.price_source` at insert time and propagated to
`order_item_pricing_audit` via the `trg_audit_order_item_pricing_insert` trigger.

| Value               | Meaning |
|---------------------|---------|
| `retail_fallback`   | Retail price; no rule or below threshold. |
| `wholesale`         | Legacy `min_qty_wholesale` threshold met (no named rule). |
| `tier`              | `product_price_tiers` match in legacy fallback path. |
| `constant`          | `CONSTANT` rule applied. |
| `sku_threshold`     | `SKU_THRESHOLD` rule; this-SKU qty ≥ threshold. |
| `group_threshold`   | `GROUP_THRESHOLD` rule; group qty ≥ threshold. |
| `tiered`            | `TIERED` rule; resolved via `product_price_tiers`. |
| `manual_price`      | Admin-supplied price for `requires_manual_price` product. |

---

## 5. Legacy Fallback (Products Without a Pricing Rule)

Products with `pricing_rule_id = NULL` use the **legacy pricing path**:

1. `product_price_tiers` rows (if any) are checked first.
2. Then `wholesale_price` if `min_qty_wholesale` is set and `qty ≥ min_qty_wholesale`.
3. Then `retail_price`.

This ensures existing products continue to function correctly without requiring
an immediate migration to named rules.

**Adding a pricing rule to a product** is opt-in and does not break existing behaviour
for products that remain unassigned.

---

## 6. Category-Based Combo Pricing — DEPRECATED

The fields `categories.combo_discount_qty` and `categories.combo_discount_price`, and
the function `applyCategoryComboDiscounts()` in `utils/pricingEngine.js`, are **deprecated**.

- These columns and the function are retained for backward compatibility only.
- They are **not** called in the current order creation flow.
- Categories are taxonomy/inventory entities; they are **not** the pricing engine.
- New products must use named `pricing_rules` for quantity-based discounts.
- The old columns will be removed in a future migration once all dependents are confirmed clear.

---

## 7. Flash Sales — Informational Only

Flash sale discounts are stored in `flash_sales` / `flash_sale_products` and returned
by the products API (`discounted_price` field) for display purposes.

**Flash sale prices are NOT applied at order-creation time.**

`price_source` will never be `'flash_sale'` in the current implementation.

If flash sale pricing needs to become authoritative (i.e., enforced at order time),
it must be integrated into `evaluateCartPricing()` as an explicit precedence step —
ideally **highest priority** (before named rules) — and covered by tests before
being shipped.  Do not implement this in an ad-hoc way on the storefront side.

---

## 8. Audit Trail

The `order_item_pricing_audit` table captures a snapshot of every `order_items` row
at insert time via the `trg_audit_order_item_pricing_insert` DB trigger.

Audit fields captured:

| Column            | Source                        |
|-------------------|-------------------------------|
| `order_item_id`   | `order_items.id`              |
| `order_id`        | `order_items.order_id`        |
| `product_id`      | `order_items.product_id`      |
| `quantity`        | `order_items.quantity`        |
| `price_at_purchase` | `order_items.price_at_purchase` |
| `line_total`      | `order_items.line_total`      |
| `price_source`    | `order_items.price_source`    |
| `pricing_locked_at` | `order_items.pricing_locked_at` (set by lock trigger) |
| `pricing_rule_id` | `order_items.pricing_rule_id` |
| `rule_type`       | `order_items.rule_type`       |

`pricing_rule_id` and `rule_type` are snapshotted so the audit record is
self-contained even if the live pricing rule is later modified or deleted.

Pricing fields on `order_items` are **immutable** after insert
(`trg_prevent_order_item_pricing_update`).  Any attempt to update them raises
SQLSTATE `23514`.

---

## 9. Admin Guidance — When to Use Which Rule

| Scenario | Rule to Use |
|----------|-------------|
| Product always sold at retail, no discounts | No rule (legacy fallback) or `CONSTANT` |
| Buy N+ of **this product** for wholesale | `SKU_THRESHOLD` with `threshold_qty = N` |
| Buy N+ of **any mix** of products in a group for wholesale | `GROUP_THRESHOLD` with `threshold_qty = N` |
| Product has per-quantity price breaks | `TIERED` — manage tiers via `/api/price-tiers` |
| Admin prices each order manually | `requires_manual_price = true` on product |

---

## 10. Running Tests

```bash
# Pricing rule evaluator unit tests (no DB required)
node utils/pricingRuleEvaluator.test.js

# Legacy pricing engine tests
node utils/pricingEngine.test.js
```
