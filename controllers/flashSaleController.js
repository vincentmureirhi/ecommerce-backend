'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

// GET ALL FLASH SALES
const getAllFlashSales = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        fs.*,
        COUNT(DISTINCT fsp.product_id)::INT AS product_count
      FROM flash_sales fs
      LEFT JOIN flash_sale_products fsp
        ON fsp.flash_sale_id = fs.id
      GROUP BY fs.id
      ORDER BY fs.created_at DESC
    `);

    return handleSuccess(
      res,
      200,
      'Flash sales retrieved successfully',
      result.rows
    );
  } catch (err) {
    console.error('getAllFlashSales error:', err.message);

    return handleError(
      res,
      500,
      'Failed to retrieve flash sales',
      err
    );
  }
};

// GET ACTIVE FLASH SALES
// Public storefront endpoint with embedded products
const getActiveFlashSales = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        fs.*,

        (
          COUNT(DISTINCT fsp.product_id)
          FILTER (WHERE p.id IS NOT NULL AND COALESCE(p.is_active, TRUE) = TRUE)
        )::INT AS product_count,

        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', p.id,
              'name', p.name,
              'sku', p.sku,
              'retail_price', p.retail_price::FLOAT,
              'price', p.retail_price::FLOAT,
              'image_url', p.image_url,
              'category_name', c.name,
              'is_active', COALESCE(p.is_active, TRUE),
              'current_stock', COALESCE(p.current_stock, 0)::INT,
              'stock', COALESCE(p.current_stock, 0)::INT,
              'stock_status_override', NULLIF(p.stock_status_override, ''),
              'stock_status',
              COALESCE(NULLIF(p.stock_status_override, ''), CASE
                WHEN COALESCE(p.current_stock, 0) <= 0 THEN 'out_of_stock'
                WHEN COALESCE(p.current_stock, 0) <= GREATEST(COALESCE(p.min_order_qty, 1), 10) THEN 'limited_stock'
                ELSE 'in_stock'
              END),
              'min_order_qty', COALESCE(p.min_order_qty, 1)::INT,
              'order_qty_step', COALESCE(p.order_qty_step, 1)::INT,
              'selling_unit_label', COALESCE(NULLIF(p.selling_unit_label, ''), 'piece'),

              'discounted_price',
              CASE
                WHEN fs.discount_type = 'percentage'
                  THEN ROUND(
                    (
                      p.retail_price *
                      (1 - fs.discount_value / 100.0)
                    )::numeric,
                    2
                  )::FLOAT

                ELSE GREATEST(
                  (
                    p.retail_price - fs.discount_value
                  )::numeric,
                  0
                )::FLOAT
              END
            )
            ORDER BY fsp.created_at DESC
          ) FILTER (WHERE p.id IS NOT NULL),

          '[]'::json
        ) AS products

      FROM flash_sales fs

      LEFT JOIN flash_sale_products fsp
        ON fsp.flash_sale_id = fs.id

      LEFT JOIN products p
        ON p.id = fsp.product_id

      LEFT JOIN categories c
        ON c.id = p.category_id

      WHERE
        fs.is_active = TRUE
        AND fs.start_date <= NOW()
        AND fs.end_date >= NOW()

      GROUP BY fs.id

      ORDER BY fs.end_date ASC
    `);

    return handleSuccess(
      res,
      200,
      'Active flash sales retrieved successfully',
      result.rows
    );
  } catch (err) {
    console.error('getActiveFlashSales error:', err.message);

    return handleError(
      res,
      500,
      'Failed to retrieve active flash sales',
      err
    );
  }
};

// GET PUBLIC FLASH SALE FEED
// Public storefront endpoint with live and upcoming deals.
const getPublicFlashSaleFeed = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        fs.*,

        CASE
          WHEN fs.start_date <= NOW() AND fs.end_date >= NOW() THEN 'active'
          WHEN fs.start_date > NOW() THEN 'upcoming'
          ELSE 'ended'
        END AS sale_status,

        (
          COUNT(DISTINCT fsp.product_id)
          FILTER (WHERE p.id IS NOT NULL AND COALESCE(p.is_active, TRUE) = TRUE)
        )::INT AS product_count,

        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', p.id,
              'name', p.name,
              'sku', p.sku,
              'retail_price', p.retail_price::FLOAT,
              'price', p.retail_price::FLOAT,
              'image_url', p.image_url,
              'category_name', c.name,
              'is_active', COALESCE(p.is_active, TRUE),
              'current_stock', COALESCE(p.current_stock, 0)::INT,
              'stock', COALESCE(p.current_stock, 0)::INT,
              'stock_status_override', NULLIF(p.stock_status_override, ''),
              'stock_status',
              COALESCE(NULLIF(p.stock_status_override, ''), CASE
                WHEN COALESCE(p.current_stock, 0) <= 0 THEN 'out_of_stock'
                WHEN COALESCE(p.current_stock, 0) <= GREATEST(COALESCE(p.min_order_qty, 1), 10) THEN 'limited_stock'
                ELSE 'in_stock'
              END),
              'min_order_qty', COALESCE(p.min_order_qty, 1)::INT,
              'order_qty_step', COALESCE(p.order_qty_step, 1)::INT,
              'selling_unit_label', COALESCE(NULLIF(p.selling_unit_label, ''), 'piece'),
              'is_flash', fs.start_date <= NOW() AND fs.end_date >= NOW(),
              'flash_sale_id', fs.id,
              'flash_sale_name', fs.name,
              'flash_sale_start_date', fs.start_date,
              'flash_sale_end_date', fs.end_date,

              'discounted_price',
              CASE
                WHEN fs.discount_type = 'percentage'
                  THEN ROUND(
                    (
                      p.retail_price *
                      (1 - fs.discount_value / 100.0)
                    )::numeric,
                    2
                  )::FLOAT

                ELSE GREATEST(
                  (
                    p.retail_price - fs.discount_value
                  )::numeric,
                  0
                )::FLOAT
              END
            )
            ORDER BY fsp.created_at DESC
          ) FILTER (WHERE p.id IS NOT NULL AND COALESCE(p.is_active, TRUE) = TRUE),

          '[]'::json
        ) AS products

      FROM flash_sales fs

      LEFT JOIN flash_sale_products fsp
        ON fsp.flash_sale_id = fs.id

      LEFT JOIN products p
        ON p.id = fsp.product_id

      LEFT JOIN categories c
        ON c.id = p.category_id

      WHERE
        fs.is_active = TRUE
        AND fs.end_date >= NOW()

      GROUP BY fs.id

      ORDER BY
        CASE
          WHEN fs.start_date <= NOW() AND fs.end_date >= NOW() THEN 0
          ELSE 1
        END,
        fs.start_date ASC,
        fs.end_date ASC
    `);

    const active = [];
    const upcoming = [];

    for (const row of result.rows) {
      if (row.sale_status === 'active') active.push(row);
      if (row.sale_status === 'upcoming') upcoming.push(row);
    }

    return handleSuccess(
      res,
      200,
      'Public flash sale feed retrieved successfully',
      { active, upcoming }
    );
  } catch (err) {
    console.error('getPublicFlashSaleFeed error:', err.message);

    return handleError(
      res,
      500,
      'Failed to retrieve public flash sale feed',
      err
    );
  }
};

// CREATE FLASH SALE
const createFlashSale = async (req, res) => {
  try {
    const {
      name,
      description,
      discount_type,
      discount_value,
      start_date,
      end_date,
      is_active,
    } = req.body;

    const normalizedName = String(name || '').trim();

    if (!normalizedName) {
      return handleError(res, 400, 'name is required');
    }

    const normalizedDiscountType = String(
      discount_type || 'percentage'
    )
      .trim()
      .toLowerCase();

    if (!['percentage', 'fixed'].includes(normalizedDiscountType)) {
      return handleError(
        res,
        400,
        'discount_type must be either percentage or fixed'
      );
    }

    const parsedDiscountValue = Number(discount_value);

    if (
      !Number.isFinite(parsedDiscountValue) ||
      parsedDiscountValue < 0
    ) {
      return handleError(
        res,
        400,
        'discount_value must be a valid non-negative number'
      );
    }

    if (
      normalizedDiscountType === 'percentage' &&
      parsedDiscountValue > 100
    ) {
      return handleError(
        res,
        400,
        'Percentage discount cannot exceed 100'
      );
    }

    if (!start_date || !end_date) {
      return handleError(
        res,
        400,
        'start_date and end_date are required'
      );
    }

    if (new Date(end_date) <= new Date(start_date)) {
      return handleError(
        res,
        400,
        'end_date must be after start_date'
      );
    }

    const userId = req.user ? req.user.id : null;

    const result = await pool.query(
      `
      INSERT INTO flash_sales
      (
        name,
        description,
        discount_type,
        discount_value,
        start_date,
        end_date,
        is_active,
        created_by_user_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        normalizedName,
        description ? String(description).trim() : null,
        normalizedDiscountType,
        parsedDiscountValue,
        start_date,
        end_date,
        is_active !== false,
        userId,
      ]
    );

    return handleSuccess(
      res,
      201,
      'Flash sale created successfully',
      result.rows[0]
    );
  } catch (err) {
    console.error('createFlashSale error:', err.message);

    return handleError(
      res,
      500,
      'Failed to create flash sale',
      err
    );
  }
};

// UPDATE FLASH SALE
const updateFlashSale = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      name,
      description,
      discount_type,
      discount_value,
      start_date,
      end_date,
      is_active,
    } = req.body;

    const existing = await pool.query(
      `
      SELECT
        id,
        discount_type,
        discount_value
      FROM flash_sales
      WHERE id = $1
      `,
      [id]
    );

    if (existing.rows.length === 0) {
      return handleError(res, 404, 'Flash sale not found');
    }

    const updates = [];
    const params = [];

    let idx = 1;

    if (name !== undefined) {
      const normalizedName = String(name).trim();

      if (!normalizedName) {
        return handleError(res, 400, 'name cannot be empty');
      }

      updates.push(`name = $${idx++}`);
      params.push(normalizedName);
    }

    if (description !== undefined) {
      updates.push(`description = $${idx++}`);
      params.push(description ? String(description).trim() : null);
    }

    if (discount_type !== undefined) {
      const normalizedType = String(discount_type)
        .trim()
        .toLowerCase();

      if (!['percentage', 'fixed'].includes(normalizedType)) {
        return handleError(
          res,
          400,
          'discount_type must be either percentage or fixed'
        );
      }

      updates.push(`discount_type = $${idx++}`);
      params.push(normalizedType);
    }

    if (discount_value !== undefined) {
      const val = Number(discount_value);

      if (!Number.isFinite(val) || val < 0) {
        return handleError(
          res,
          400,
          'discount_value must be a valid non-negative number'
        );
      }

      updates.push(`discount_value = $${idx++}`);
      params.push(val);
    }

    if (start_date !== undefined) {
      updates.push(`start_date = $${idx++}`);
      params.push(start_date);
    }

    if (end_date !== undefined) {
      updates.push(`end_date = $${idx++}`);
      params.push(end_date);
    }

    if (is_active !== undefined) {
      updates.push(`is_active = $${idx++}`);
      params.push(Boolean(is_active));
    }

    if (updates.length === 0) {
      return handleError(
        res,
        400,
        'No fields provided to update'
      );
    }

    const finalDiscountType =
      req.body.discount_type !== undefined
        ? String(req.body.discount_type)
            .trim()
            .toLowerCase()
        : existing.rows[0].discount_type;

    const finalDiscountValue =
      req.body.discount_value !== undefined
        ? Number(req.body.discount_value)
        : Number(existing.rows[0].discount_value);

    if (
      finalDiscountType === 'percentage' &&
      finalDiscountValue > 100
    ) {
      return handleError(
        res,
        400,
        'Percentage discount cannot exceed 100'
      );
    }

    updates.push(`updated_at = NOW()`);

    params.push(id);

    const result = await pool.query(
      `
      UPDATE flash_sales
      SET ${updates.join(', ')}
      WHERE id = $${idx}
      RETURNING *
      `,
      params
    );

    return handleSuccess(
      res,
      200,
      'Flash sale updated successfully',
      result.rows[0]
    );
  } catch (err) {
    console.error('updateFlashSale error:', err.message);

    return handleError(
      res,
      500,
      'Failed to update flash sale',
      err
    );
  }
};

// DELETE FLASH SALE
const deleteFlashSale = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      DELETE FROM flash_sales
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Flash sale not found');
    }

    return handleSuccess(
      res,
      200,
      'Flash sale deleted successfully'
    );
  } catch (err) {
    console.error('deleteFlashSale error:', err.message);

    return handleError(
      res,
      500,
      'Failed to delete flash sale',
      err
    );
  }
};

// ADD PRODUCTS TO FLASH SALE
const addProductsToFlashSale = async (req, res) => {
  try {
    const { id } = req.params;
    const { product_ids } = req.body;

    if (
      !Array.isArray(product_ids) ||
      product_ids.length === 0
    ) {
      return handleError(
        res,
        400,
        'product_ids must be a non-empty array'
      );
    }

    const saleCheck = await pool.query(
      `
      SELECT id
      FROM flash_sales
      WHERE id = $1
      `,
      [id]
    );

    if (saleCheck.rows.length === 0) {
      return handleError(res, 404, 'Flash sale not found');
    }

    const validIds = [
      ...new Set(
        product_ids
          .map((pid) => Number(pid))
          .filter(
            (n) => Number.isInteger(n) && n > 0
          )
      ),
    ];

    if (validIds.length === 0) {
      return handleError(
        res,
        400,
        'No valid product IDs provided'
      );
    }

    const placeholders = validIds
      .map((_, i) => `$${i + 1}`)
      .join(', ');

    const existingProducts = await pool.query(
      `
      SELECT id
      FROM products
      WHERE id IN (${placeholders})
      `,
      validIds
    );

    const existingProductIds = new Set(
      existingProducts.rows.map((r) => r.id)
    );

    const insertableIds = validIds.filter((pid) =>
      existingProductIds.has(pid)
    );

    if (insertableIds.length === 0) {
      return handleSuccess(
        res,
        200,
        'No valid products found to add',
        { inserted: [] }
      );
    }

    const valueParams = [];

    const valuePlaceholders = insertableIds.map(
      (pid, i) => {
        valueParams.push(id, pid);

        return `($${i * 2 + 1}, $${i * 2 + 2})`;
      }
    );

    await pool.query(
      `
      INSERT INTO flash_sale_products
      (
        flash_sale_id,
        product_id
      )
      VALUES ${valuePlaceholders.join(', ')}

      ON CONFLICT
      (
        flash_sale_id,
        product_id
      )
      DO NOTHING
      `,
      valueParams
    );

    return handleSuccess(
      res,
      200,
      'Products added to flash sale',
      { inserted: insertableIds }
    );
  } catch (err) {
    console.error(
      'addProductsToFlashSale error:',
      err.message
    );

    return handleError(
      res,
      500,
      'Failed to add products to flash sale',
      err
    );
  }
};

// REMOVE PRODUCT FROM FLASH SALE
const removeProductFromFlashSale = async (
  req,
  res
) => {
  try {
    const { id, productId } = req.params;

    const result = await pool.query(
      `
      DELETE FROM flash_sale_products
      WHERE flash_sale_id = $1
      AND product_id = $2
      RETURNING id
      `,
      [id, productId]
    );

    if (result.rows.length === 0) {
      return handleError(
        res,
        404,
        'Product not found in flash sale'
      );
    }

    return handleSuccess(
      res,
      200,
      'Product removed from flash sale'
    );
  } catch (err) {
    console.error(
      'removeProductFromFlashSale error:',
      err.message
    );

    return handleError(
      res,
      500,
      'Failed to remove product from flash sale',
      err
    );
  }
};

// GET PRODUCTS IN FLASH SALE
const getFlashSaleProducts = async (req, res) => {
  try {
    const { id } = req.params;

    const saleCheck = await pool.query(
      `
      SELECT id, name
      FROM flash_sales
      WHERE id = $1
      `,
      [id]
    );

    if (saleCheck.rows.length === 0) {
      return handleError(res, 404, 'Flash sale not found');
    }

    const result = await pool.query(
      `
      SELECT
        p.id,
        p.name,
        p.sku,
        COALESCE(p.is_active, TRUE) AS is_active,
        p.retail_price::FLOAT,
        p.retail_price::FLOAT AS price,
        p.image_url,
        c.name AS category_name,
        COALESCE(p.current_stock, 0)::INT AS current_stock,
        COALESCE(p.current_stock, 0)::INT AS stock,
        NULLIF(p.stock_status_override, '') AS stock_status_override,
        COALESCE(NULLIF(p.stock_status_override, ''), CASE
          WHEN COALESCE(p.current_stock, 0) <= 0 THEN 'out_of_stock'
          WHEN COALESCE(p.current_stock, 0) <= GREATEST(COALESCE(p.min_order_qty, 1), 10) THEN 'limited_stock'
          ELSE 'in_stock'
        END) AS stock_status,
        COALESCE(p.min_order_qty, 1)::INT AS min_order_qty,
        COALESCE(p.order_qty_step, 1)::INT AS order_qty_step,
        COALESCE(NULLIF(p.selling_unit_label, ''), 'piece') AS selling_unit_label,
        fsp.created_at AS added_at,

        CASE
          WHEN fs.discount_type = 'percentage'
            THEN ROUND(
              (
                p.retail_price *
                (1 - fs.discount_value / 100.0)
              )::numeric,
              2
            )::FLOAT

          ELSE GREATEST(
            (
              p.retail_price - fs.discount_value
            )::numeric,
            0
          )::FLOAT
        END AS discounted_price

      FROM flash_sale_products fsp

      JOIN products p
        ON p.id = fsp.product_id

      JOIN flash_sales fs
        ON fs.id = fsp.flash_sale_id

      LEFT JOIN categories c
        ON c.id = p.category_id

      WHERE
        fsp.flash_sale_id = $1
        AND COALESCE(p.is_active, TRUE) = TRUE

      ORDER BY fsp.created_at DESC
      `,
      [id]
    );

    return handleSuccess(
      res,
      200,
      'Flash sale products retrieved successfully',
      result.rows
    );
  } catch (err) {
    console.error(
      'getFlashSaleProducts error:',
      err.message
    );

    return handleError(
      res,
      500,
      'Failed to retrieve flash sale products',
      err
    );
  }
};

// GET ACTIVE FLASH SALE PRODUCTS
// Public endpoint
const getActiveFlashSaleProducts = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const saleCheck = await pool.query(
      `
      SELECT
        id,
        name,
        discount_type,
        discount_value
      FROM flash_sales
      WHERE
        id = $1
        AND is_active = TRUE
        AND start_date <= NOW()
        AND end_date >= NOW()
      `,
      [id]
    );

    if (saleCheck.rows.length === 0) {
      return handleError(
        res,
        404,
        'Flash sale not found or not currently active'
      );
    }

    const result = await pool.query(
      `
      SELECT
        p.id,
        p.name,
        p.sku,
        COALESCE(p.is_active, TRUE) AS is_active,
        p.retail_price::FLOAT,
        p.retail_price::FLOAT AS price,
        p.image_url,
        c.name AS category_name,
        COALESCE(p.current_stock, 0)::INT AS current_stock,
        COALESCE(p.current_stock, 0)::INT AS stock,
        NULLIF(p.stock_status_override, '') AS stock_status_override,
        COALESCE(NULLIF(p.stock_status_override, ''), CASE
          WHEN COALESCE(p.current_stock, 0) <= 0 THEN 'out_of_stock'
          WHEN COALESCE(p.current_stock, 0) <= GREATEST(COALESCE(p.min_order_qty, 1), 10) THEN 'limited_stock'
          ELSE 'in_stock'
        END) AS stock_status,
        COALESCE(p.min_order_qty, 1)::INT AS min_order_qty,
        COALESCE(p.order_qty_step, 1)::INT AS order_qty_step,
        COALESCE(NULLIF(p.selling_unit_label, ''), 'piece') AS selling_unit_label,
        fsp.created_at AS added_at,

        CASE
          WHEN fs.discount_type = 'percentage'
            THEN ROUND(
              (
                p.retail_price *
                (1 - fs.discount_value / 100.0)
              )::numeric,
              2
            )::FLOAT

          ELSE GREATEST(
            (
              p.retail_price - fs.discount_value
            )::numeric,
            0
          )::FLOAT
        END AS discounted_price

      FROM flash_sale_products fsp

      JOIN products p
        ON p.id = fsp.product_id

      JOIN flash_sales fs
        ON fs.id = fsp.flash_sale_id

      LEFT JOIN categories c
        ON c.id = p.category_id

      WHERE
        fsp.flash_sale_id = $1
        AND COALESCE(p.is_active, TRUE) = TRUE

      ORDER BY fsp.created_at DESC
      `,
      [id]
    );

    return handleSuccess(
      res,
      200,
      'Flash sale products retrieved successfully',
      result.rows
    );
  } catch (err) {
    console.error(
      'getActiveFlashSaleProducts error:',
      err.message
    );

    return handleError(
      res,
      500,
      'Failed to retrieve flash sale products',
      err
    );
  }
};

module.exports = {
  getAllFlashSales,
  getActiveFlashSales,
  getPublicFlashSaleFeed,
  createFlashSale,
  updateFlashSale,
  deleteFlashSale,
  addProductsToFlashSale,
  removeProductFromFlashSale,
  getFlashSaleProducts,
  getActiveFlashSaleProducts,
};
