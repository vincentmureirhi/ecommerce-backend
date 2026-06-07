'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

const DEFAULT_TERMS = `## Terms & Conditions

Welcome to XPOSE Distributors. These terms are managed from the admin panel.
`;

async function ensureTermsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS terms_conditions (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(
    `
    INSERT INTO terms_conditions (id, content)
    VALUES (1, $1)
    ON CONFLICT (id) DO NOTHING
    `,
    [DEFAULT_TERMS]
  );
}

async function getTerms(req, res) {
  try {
    await ensureTermsTable();

    const result = await pool.query(
      `
      SELECT content, updated_at
      FROM terms_conditions
      WHERE id = 1
      `
    );

    return handleSuccess(res, 200, 'Terms retrieved successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve terms', err);
  }
}

async function updateTerms(req, res) {
  try {
    await ensureTermsTable();

    const content = String(req.body?.content || '').trim();
    if (!content) {
      return handleError(res, 400, 'Terms content is required');
    }

    const result = await pool.query(
      `
      INSERT INTO terms_conditions (id, content, updated_at)
      VALUES (1, $1, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        content = EXCLUDED.content,
        updated_at = NOW()
      RETURNING content, updated_at
      `,
      [content]
    );

    return handleSuccess(res, 200, 'Terms updated successfully', result.rows[0]);
  } catch (err) {
    return handleError(res, 500, 'Failed to update terms', err);
  }
}

module.exports = {
  getTerms,
  updateTerms,
};