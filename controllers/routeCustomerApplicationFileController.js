'use strict';

const fs = require('fs/promises');
const path = require('path');
const pool = require('../config/database');
const {
  logRouteCustomerApplicationEvent,
} = require('../utils/routeCustomerApplicationEvents');

const VALID_FILE_TYPES = new Set([
  'received_form',
  'signed_form',
  'supporting_document',
]);

function success(res, status, message, data = {}) {
  return res.status(status).json({
    success: true,
    message,
    data,
  });
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({
    success: false,
    message,
    ...extra,
  });
}

function buildDownloadPath(applicationId, fileId) {
  return `/api/route-customer-portal/applications/${applicationId}/files/${fileId}/download`;
}

function serializeFile(req, row) {
  return {
    ...row,
    download_path: buildDownloadPath(row.application_id, row.id),
    download_url: `${req.protocol}://${req.get('host')}${buildDownloadPath(row.application_id, row.id)}`,
  };
}

async function ensureApplicationExists(client, applicationId) {
  const result = await client.query(
    `
    SELECT
      id,
      status,
      physically_filed,
      digitally_archived,
      digital_file_name,
      digital_file_reference
    FROM route_customer_applications
    WHERE id = $1
    LIMIT 1
    FOR UPDATE
    `,
    [applicationId]
  );

  if (result.rows.length === 0) {
    const err = new Error('Application not found');
    err.status = 404;
    throw err;
  }

  return result.rows[0];
}

async function getApplicationFileStats(client, applicationId) {
  const result = await client.query(
    `
    SELECT
      COUNT(*)::int AS total_files,
      COUNT(*) FILTER (WHERE file_type = 'received_form')::int AS received_form_files,
      COUNT(*) FILTER (WHERE file_type = 'signed_form')::int AS signed_form_files,
      COUNT(*) FILTER (WHERE file_type = 'supporting_document')::int AS supporting_document_files
    FROM route_customer_application_files
    WHERE application_id = $1
    `,
    [applicationId]
  );

  return (
    result.rows[0] || {
      total_files: 0,
      received_form_files: 0,
      signed_form_files: 0,
      supporting_document_files: 0,
    }
  );
}

function normalizeFileType(value) {
  const fileType = String(value || '').trim().toLowerCase();

  if (!VALID_FILE_TYPES.has(fileType)) {
    const err = new Error('file_type must be one of: received_form, signed_form, supporting_document');
    err.status = 400;
    throw err;
  }

  return fileType;
}

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

async function syncApplicationArchiveMetadata(client, applicationId, options = {}) {
  const latestFileResult = await client.query(
    `
    SELECT *
    FROM route_customer_application_files
    WHERE application_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [applicationId]
  );

  const latestFile = latestFileResult.rows[0] || null;

  if (!latestFile) {
    await client.query(
      `
      UPDATE route_customer_applications
      SET
        digital_file_name = NULL,
        digital_file_reference = NULL,
        digitally_archived = FALSE,
        archived_by_user_id = NULL,
        archived_at = NULL,
        updated_at = NOW()
      WHERE id = $1
      `,
      [applicationId]
    );
    return;
  }

  await client.query(
    `
    UPDATE route_customer_applications
    SET
      digital_file_name = $1,
      digital_file_reference = $2,
      digitally_archived = TRUE,
      archived_by_user_id = $3,
      archived_at = COALESCE(archived_at, NOW()),
      updated_at = NOW()
    WHERE id = $4
    `,
    [
      latestFile.original_name,
      latestFile.relative_path,
      options.userId || null,
      applicationId,
    ]
  );
}

const listApplicationFiles = async (req, res) => {
  try {
    const applicationId = Number(req.params.id);

    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      return fail(res, 400, 'Invalid application id');
    }

    const result = await pool.query(
      `
      SELECT
        f.*,
        u.email AS uploaded_by_email
      FROM route_customer_application_files f
      LEFT JOIN users u ON f.uploaded_by_user_id = u.id
      WHERE f.application_id = $1
      ORDER BY f.created_at DESC, f.id DESC
      `,
      [applicationId]
    );

    return success(res, 200, 'Application files retrieved successfully', {
      files: result.rows.map((row) => serializeFile(req, row)),
      total: result.rows.length,
    });
  } catch (err) {
    console.error('❌ listApplicationFiles error:', err.message);
    return fail(res, 500, 'Failed to list application files', { error: err.message });
  }
};

const uploadApplicationFile = async (req, res) => {
  const client = await pool.connect();

  try {
    const applicationId = Number(req.params.id);

    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      return fail(res, 400, 'Invalid application id');
    }

    if (!req.file) {
      return fail(res, 400, 'File is required');
    }

    const fileType = normalizeFileType(req.body.file_type);

    await client.query('BEGIN');

    await ensureApplicationExists(client, applicationId);

    const relativePath = path.relative(
      path.join(__dirname, '..', 'uploads'),
      req.file.path
    ).replace(/\\/g, '/');

    const insertResult = await client.query(
      `
      INSERT INTO route_customer_application_files
      (
        application_id,
        file_type,
        original_name,
        stored_name,
        relative_path,
        mime_type,
        file_size,
        uploaded_by_user_id,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING *
      `,
      [
        applicationId,
        fileType,
        req.file.originalname,
        req.file.filename,
        relativePath,
        req.file.mimetype,
        req.file.size,
        req.user?.id || null,
      ]
    );

    await syncApplicationArchiveMetadata(client, applicationId, {
      userId: req.user?.id || null,
    });

    await logRouteCustomerApplicationEvent(client, {
      applicationId,
      eventType: 'file_uploaded',
      eventLabel: 'Application file uploaded',
      eventNotes: req.file.originalname,
      actorUserId: req.user?.id || null,
      metadata: {
        file_id: insertResult.rows[0].id,
        file_type: fileType,
        original_name: req.file.originalname,
        stored_name: req.file.filename,
        relative_path: relativePath,
        mime_type: req.file.mimetype,
        file_size: req.file.size,
      },
    });

    await client.query('COMMIT');

    return success(res, 201, 'Application file uploaded successfully', {
      file: serializeFile(req, insertResult.rows[0]),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ uploadApplicationFile error:', err.message);
    return fail(res, err.status || 500, err.message || 'Failed to upload application file');
  } finally {
    client.release();
  }
};

const downloadApplicationFile = async (req, res) => {
  try {
    const applicationId = Number(req.params.id);
    const fileId = Number(req.params.fileId);

    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      return fail(res, 400, 'Invalid application id');
    }

    if (!Number.isInteger(fileId) || fileId <= 0) {
      return fail(res, 400, 'Invalid file id');
    }

    const result = await pool.query(
      `
      SELECT *
      FROM route_customer_application_files
      WHERE id = $1
        AND application_id = $2
      LIMIT 1
      `,
      [fileId, applicationId]
    );

    if (result.rows.length === 0) {
      return fail(res, 404, 'Application file not found');
    }

    const file = result.rows[0];
    const absolutePath = path.join(__dirname, '..', 'uploads', file.relative_path);

    return res.download(absolutePath, file.original_name);
  } catch (err) {
    console.error('❌ downloadApplicationFile error:', err.message);
    return fail(res, 500, 'Failed to download application file', { error: err.message });
  }
};

const deleteApplicationFile = async (req, res) => {
  const client = await pool.connect();

  try {
    const applicationId = Number(req.params.id);
    const fileId = Number(req.params.fileId);

    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      return fail(res, 400, 'Invalid application id');
    }

    if (!Number.isInteger(fileId) || fileId <= 0) {
      return fail(res, 400, 'Invalid file id');
    }

    await client.query('BEGIN');

    const app = await ensureApplicationExists(client, applicationId);
    const stats = await getApplicationFileStats(client, applicationId);

    const fileResult = await client.query(
      `
      SELECT *
      FROM route_customer_application_files
      WHERE id = $1
        AND application_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [fileId, applicationId]
    );

    if (fileResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Application file not found');
    }

    const file = fileResult.rows[0];
    const absolutePath = path.join(__dirname, '..', 'uploads', file.relative_path);

    if (
      Number(stats.total_files || 0) <= 1 &&
      (app.digitally_archived || String(app.status || '').toLowerCase() === 'approved')
    ) {
      await client.query('ROLLBACK');
      return fail(
        res,
        400,
        'You cannot delete the last file from an approved or digitally archived application. Upload a replacement file or update workflow first.'
      );
    }

    if (
      file.file_type === 'received_form' &&
      Number(stats.received_form_files || 0) <= 1 &&
      String(app.status || '').toLowerCase() === 'approved'
    ) {
      await client.query('ROLLBACK');
      return fail(
        res,
        400,
        'You cannot delete the last received form from an approved application.'
      );
    }

    if (
      app.digitally_archived &&
      app.digital_file_reference === file.relative_path &&
      Number(stats.total_files || 0) <= 1
    ) {
      await client.query('ROLLBACK');
      return fail(
        res,
        400,
        'You cannot delete the only archived file while the application is still marked as digitally archived.'
      );
    }

    await client.query(
      `
      DELETE FROM route_customer_application_files
      WHERE id = $1
      `,
      [fileId]
    );

    if (app.digital_file_reference === file.relative_path) {
      await syncApplicationArchiveMetadata(client, applicationId, {
        userId: req.user?.id || null,
      });
    }

    await logRouteCustomerApplicationEvent(client, {
      applicationId,
      eventType: 'file_deleted',
      eventLabel: 'Application file deleted',
      eventNotes: file.original_name,
      actorUserId: req.user?.id || null,
      metadata: {
        file_id: file.id,
        file_type: file.file_type,
        original_name: file.original_name,
        stored_name: file.stored_name,
        relative_path: file.relative_path,
        mime_type: file.mime_type,
        file_size: file.file_size,
      },
    });

    await client.query('COMMIT');
    await safeUnlink(absolutePath);

    return success(res, 200, 'Application file deleted successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ deleteApplicationFile error:', err.message);
    return fail(res, err.status || 500, err.message || 'Failed to delete application file');
  } finally {
    client.release();
  }
};

module.exports = {
  listApplicationFiles,
  uploadApplicationFile,
  downloadApplicationFile,
  deleteApplicationFile,
};