const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

const trimOrNull = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const parseLeadTimeDays = (value, defaultValue = 0) => {
  if (value === undefined || value === null || value === '') return defaultValue;

  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
};

// Get all suppliers with stock value
// NOTE: This currently reads from departments table because the DB has not been migrated yet.
const getAllSuppliers = async (req, res) => {
  try {
    const { search } = req.query;

    let query = `
      SELECT
        d.id,
        d.name,
        d.description,
        d.contact_person,
        d.phone,
        d.email,
        d.address,
        d.notes,
        d.is_active,
        d.payment_terms,
        d.lead_time_days,
        d.created_at,
        d.updated_at,
        COUNT(DISTINCT p.id) AS product_count,
        COALESCE(SUM(p.current_stock), 0) AS total_stock,
        COALESCE(SUM(p.current_stock * COALESCE(p.retail_price, 0)), 0) AS stock_value
      FROM departments d
      LEFT JOIN products p ON d.id = p.department_id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (search) {
      params.push(`%${search}%`);
      query += ` AND d.name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    query += `
      GROUP BY
        d.id,
        d.name,
        d.description,
        d.contact_person,
        d.phone,
        d.email,
        d.address,
        d.notes,
        d.is_active,
        d.payment_terms,
        d.lead_time_days,
        d.created_at,
        d.updated_at
      ORDER BY d.name ASC
    `;

    const result = await pool.query(query, params);
    return handleSuccess(res, 200, 'Suppliers retrieved successfully', result.rows);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve suppliers', err);
  }
};

// Get single supplier
// NOTE: This currently reads from departments table because the DB has not been migrated yet.
const getSupplierById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        d.id,
        d.name,
        d.description,
        d.contact_person,
        d.phone,
        d.email,
        d.address,
        d.notes,
        d.is_active,
        d.payment_terms,
        d.lead_time_days,
        d.created_at,
        d.updated_at,
        COUNT(DISTINCT p.id) AS product_count,
        COALESCE(SUM(p.current_stock), 0) AS total_stock,
        COALESCE(SUM(p.current_stock * COALESCE(p.retail_price, 0)), 0) AS stock_value
      FROM departments d
      LEFT JOIN products p ON d.id = p.department_id
      WHERE d.id = $1
      GROUP BY
        d.id,
        d.name,
        d.description,
        d.contact_person,
        d.phone,
        d.email,
        d.address,
        d.notes,
        d.is_active,
        d.payment_terms,
        d.lead_time_days,
        d.created_at,
        d.updated_at
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Supplier not found');
    }

    return handleSuccess(res, 200, 'Supplier retrieved successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve supplier', err);
  }
};

// Create supplier
// NOTE: This currently writes to departments table because the DB has not been migrated yet.
const createSupplier = async (req, res) => {
  try {
    const {
      name,
      description,
      contact_person,
      phone,
      email,
      address,
      notes,
      is_active,
      payment_terms,
      lead_time_days
    } = req.body;

    if (!name || !name.trim()) {
      return handleError(res, 400, 'name is required');
    }

    const result = await pool.query(
      `
      INSERT INTO departments
        (
          name,
          description,
          contact_person,
          phone,
          email,
          address,
          notes,
          is_active,
          payment_terms,
          lead_time_days
        )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
      `,
      [
        name.trim(),
        trimOrNull(description),
        trimOrNull(contact_person),
        trimOrNull(phone),
        trimOrNull(email),
        trimOrNull(address),
        trimOrNull(notes),
        typeof is_active === 'boolean' ? is_active : true,
        trimOrNull(payment_terms),
        parseLeadTimeDays(lead_time_days, 0)
      ]
    );

    return handleSuccess(res, 201, 'Supplier created successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'Supplier name already exists');
    }
    return handleError(res, 500, 'Failed to create supplier', err);
  }
};

// Update supplier
// NOTE: This currently writes to departments table because the DB has not been migrated yet.
const updateSupplier = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      contact_person,
      phone,
      email,
      address,
      notes,
      is_active,
      payment_terms,
      lead_time_days
    } = req.body;

    const result = await pool.query(
      `
      UPDATE departments
      SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        contact_person = COALESCE($3, contact_person),
        phone = COALESCE($4, phone),
        email = COALESCE($5, email),
        address = COALESCE($6, address),
        notes = COALESCE($7, notes),
        is_active = COALESCE($8, is_active),
        payment_terms = COALESCE($9, payment_terms),
        lead_time_days = COALESCE($10, lead_time_days),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $11
      RETURNING *
      `,
      [
        trimOrNull(name),
        trimOrNull(description),
        trimOrNull(contact_person),
        trimOrNull(phone),
        trimOrNull(email),
        trimOrNull(address),
        trimOrNull(notes),
        typeof is_active === 'boolean' ? is_active : null,
        trimOrNull(payment_terms),
        lead_time_days === undefined || lead_time_days === null || lead_time_days === ''
          ? null
          : parseLeadTimeDays(lead_time_days, null),
        id
      ]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Supplier not found');
    }

    return handleSuccess(res, 200, 'Supplier updated successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'Supplier name already exists');
    }
    return handleError(res, 500, 'Failed to update supplier', err);
  }
};

// Delete supplier - WITH VALIDATION
// NOTE: This currently deletes from departments table because the DB has not been migrated yet.
const deleteSupplier = async (req, res) => {
  try {
    const { id } = req.params;

    const productsResult = await pool.query(
      'SELECT COUNT(*) AS count FROM products WHERE department_id = $1',
      [id]
    );

    const productCount = parseInt(productsResult.rows[0].count, 10);

    if (productCount > 0) {
      return handleError(
        res,
        400,
        `Cannot delete supplier. It has ${productCount} product(s) assigned to it. Please reassign or delete the products first.`
      );
    }

    const result = await pool.query(
      'DELETE FROM departments WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Supplier not found');
    }

    return handleSuccess(res, 200, 'Supplier deleted successfully');
  } catch (err) {
    return handleError(res, 500, 'Failed to delete supplier', err);
  }
};

module.exports = {
  getAllSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  deleteSupplier,
};