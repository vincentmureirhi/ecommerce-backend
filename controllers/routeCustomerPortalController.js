'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const {
  logRouteCustomerApplicationEvent,
  listRouteCustomerApplicationEvents,
} = require('../utils/routeCustomerApplicationEvents');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const ROUTE_CUSTOMER_TOKEN_EXPIRY = '24h';

const VALID_REVIEW_STAGES = new Set([
  'received',
  'printed',
  'security_reviewed',
  'finance_reviewed',
  'admin_reviewed',
  'approved',
  'rejected',
  'filed',
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

function normalizeUsernameSeed(value) {
  const base = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.');

  return base || 'customer';
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return String(forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || null;
}

function generateTemporaryPassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function signRouteCustomerToken(account) {
  return jwt.sign(
    {
      token_type: 'route_customer',
      account_id: account.id,
      customer_id: account.customer_id,
      username: account.username,
    },
    JWT_SECRET,
    { expiresIn: ROUTE_CUSTOMER_TOKEN_EXPIRY }
  );
}

function normalizeOptionalBoolean(value, fieldName) {
  if (value === undefined) return undefined;

  if (typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }

  const err = new Error(`${fieldName} must be a boolean`);
  err.status = 400;
  throw err;
}

function sanitizeOptionalString(value) {
  if (value === undefined) return undefined;
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function normalizeOptionalPositiveInteger(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const num = Number(value);

  if (!Number.isInteger(num) || num <= 0) {
    const err = new Error(`${fieldName} must be a positive integer`);
    err.status = 400;
    throw err;
  }

  return num;
}

function normalizeOptionalTimestamp(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    const err = new Error(`${fieldName} must be a valid datetime`);
    err.status = 400;
    throw err;
  }

  return date.toISOString();
}

function deriveToggleTimestamp(currentValue, nextBoolean) {
  if (nextBoolean === undefined) return currentValue;
  if (nextBoolean === true) return currentValue || new Date().toISOString();
  return null;
}

function inferReviewStage({ explicitStage, status, workflow }) {
  if (explicitStage) return explicitStage;
  if (workflow.physically_filed) return 'filed';
  if (status === 'approved') return 'approved';
  if (status === 'rejected') return 'rejected';
  if (workflow.admin_reviewed) return 'admin_reviewed';
  if (workflow.finance_reviewed) return 'finance_reviewed';
  if (workflow.security_reviewed) return 'security_reviewed';
  if (workflow.is_printed) return 'printed';
  return 'received';
}

async function insertLoginAudit(client, payload) {
  await client.query(
    `
    INSERT INTO route_customer_login_audit
    (
      account_id,
      customer_id,
      login_status,
      failure_reason,
      ip_address,
      user_agent
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      payload.account_id || null,
      payload.customer_id || null,
      payload.login_status,
      payload.failure_reason || null,
      payload.ip_address || null,
      payload.user_agent || null,
    ]
  );
}

async function buildUniqueUsername(client, seed) {
  const base = normalizeUsernameSeed(seed);
  let candidate = base;
  let counter = 0;

  while (true) {
    const exists = await client.query(
      `
      SELECT 1
      FROM route_customer_accounts
      WHERE LOWER(username) = LOWER($1)
      LIMIT 1
      `,
      [candidate]
    );

    if (exists.rows.length === 0) {
      return candidate;
    }

    counter += 1;
    candidate = `${base}.${counter}`;

    if (counter > 2000) {
      throw new Error('Failed to generate a unique username');
    }
  }
}

async function resolveRequestedUsername(client, requestedUsername, fallbackSeed) {
  if (requestedUsername && String(requestedUsername).trim()) {
    const normalized = normalizeUsernameSeed(requestedUsername);

    const exists = await client.query(
      `
      SELECT 1
      FROM route_customer_accounts
      WHERE LOWER(username) = LOWER($1)
      LIMIT 1
      `,
      [normalized]
    );

    if (exists.rows.length > 0) {
      const err = new Error('Username already exists');
      err.status = 409;
      throw err;
    }

    return normalized;
  }

  return buildUniqueUsername(client, fallbackSeed);
}

async function provisionRouteCustomerAccount(client, options) {
  const {
    customerId,
    username,
    temporaryPassword,
    creditLimit,
    creditNotes,
    approvedByUserId,
  } = options;

  const customerResult = await client.query(
    `
    SELECT id, name, email, phone, customer_type, is_active
    FROM customers
    WHERE id = $1
    FOR UPDATE
    `,
    [customerId]
  );

  if (customerResult.rows.length === 0) {
    const err = new Error('Customer not found');
    err.status = 404;
    throw err;
  }

  const customer = customerResult.rows[0];

  if (customer.customer_type !== 'route') {
    const err = new Error('Only route customers can receive portal accounts');
    err.status = 400;
    throw err;
  }

  const existingAccount = await client.query(
    `
    SELECT id
    FROM route_customer_accounts
    WHERE customer_id = $1
    LIMIT 1
    `,
    [customerId]
  );

  if (existingAccount.rows.length > 0) {
    const err = new Error('This customer already has a route portal account');
    err.status = 409;
    throw err;
  }

  const finalUsername = await resolveRequestedUsername(
    client,
    username,
    customer.name || customer.email || customer.phone || `customer.${customer.id}`
  );

  const finalTemporaryPassword =
    temporaryPassword && String(temporaryPassword).trim()
      ? String(temporaryPassword).trim()
      : generateTemporaryPassword(10);

  const passwordHash = await bcrypt.hash(finalTemporaryPassword, 10);

  const accountInsert = await client.query(
    `
    INSERT INTO route_customer_accounts
    (
      customer_id,
      username,
      password_hash,
      must_change_password,
      is_active,
      approved_by_user_id,
      approved_at,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, TRUE, TRUE, $4, NOW(), NOW(), NOW())
    RETURNING id, customer_id, username, must_change_password, is_active, approved_at, last_login_at
    `,
    [customerId, finalUsername, passwordHash, approvedByUserId || null]
  );

  const numericCreditLimit =
    creditLimit === undefined || creditLimit === null || creditLimit === ''
      ? 0
      : Number(creditLimit);

  if (!Number.isFinite(numericCreditLimit) || numericCreditLimit < 0) {
    const err = new Error('Credit limit must be a valid non-negative number');
    err.status = 400;
    throw err;
  }

  const creditResult = await client.query(
    `
    INSERT INTO route_customer_credit_profiles
    (
      customer_id,
      credit_limit,
      is_credit_active,
      credit_notes,
      created_by_user_id,
      updated_by_user_id,
      created_at,
      updated_at
    )
    VALUES ($1, $2, TRUE, $3, $4, $4, NOW(), NOW())
    ON CONFLICT (customer_id)
    DO UPDATE SET
      credit_limit = EXCLUDED.credit_limit,
      is_credit_active = TRUE,
      credit_notes = EXCLUDED.credit_notes,
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = NOW()
    RETURNING id, customer_id, credit_limit, is_credit_active, credit_notes, created_at, updated_at
    `,
    [customerId, numericCreditLimit, creditNotes || null, approvedByUserId || null]
  );

  return {
    customer,
    account: accountInsert.rows[0],
    credit_profile: creditResult.rows[0],
    temporary_password: finalTemporaryPassword,
  };
}

async function assertRouteCustomerForAdmin(client, customerId) {
  const result = await client.query(
    `
    SELECT id, name, email, phone, customer_type, is_active
    FROM customers
    WHERE id = $1
    FOR UPDATE
    `,
    [customerId]
  );

  if (result.rows.length === 0) {
    const err = new Error('Customer not found');
    err.status = 404;
    throw err;
  }

  const customer = result.rows[0];

  if (customer.customer_type !== 'route') {
    const err = new Error('Only route customers can be managed here');
    err.status = 400;
    throw err;
  }

  return customer;
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

function resolvePatchedValue(currentValue, patchedValue) {
  return patchedValue === undefined ? currentValue : patchedValue;
}

function throwGuardrail(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function validateWorkflowGuardrails({ currentApplication, nextWorkflow, patchValues, fileStats }) {
  const nextFiledReference = resolvePatchedValue(
    currentApplication.filed_reference,
    patchValues.filed_reference
  );

  const nextReceivedEmailSubject = resolvePatchedValue(
    currentApplication.received_email_subject,
    patchValues.received_email_subject
  );

  const nextReceivedEmailFrom = resolvePatchedValue(
    currentApplication.received_email_from,
    patchValues.received_email_from
  );

  const nextReceivedOnEmailAt = resolvePatchedValue(
    currentApplication.received_on_email_at,
    patchValues.received_on_email_at
  );

  const submittedVia = String(currentApplication.submitted_via || '').toLowerCase();

  if (nextWorkflow.physically_filed && !String(nextFiledReference || '').trim()) {
    throwGuardrail('Filed reference is required before marking an application as physically filed');
  }

  if (nextWorkflow.digitally_archived && Number(fileStats.total_files || 0) < 1) {
    throwGuardrail('You cannot mark an application as digitally archived without at least one uploaded file');
  }

  const hasAnyEmailEvidence =
    Boolean(String(nextReceivedEmailSubject || '').trim()) ||
    Boolean(String(nextReceivedEmailFrom || '').trim()) ||
    Boolean(nextReceivedOnEmailAt);

  const hasMovedPastIntake =
    nextWorkflow.security_reviewed ||
    nextWorkflow.finance_reviewed ||
    nextWorkflow.admin_reviewed ||
    nextWorkflow.physically_filed ||
    nextWorkflow.digitally_archived ||
    ['approved', 'rejected'].includes(String(currentApplication.status || '').toLowerCase());

  if (submittedVia === 'email' && (hasAnyEmailEvidence || hasMovedPastIntake)) {
    if (!String(nextReceivedEmailSubject || '').trim()) {
      throwGuardrail('Email-submitted applications require the received email subject before review, filing, or archive');
    }

    if (!String(nextReceivedEmailFrom || '').trim()) {
      throwGuardrail('Email-submitted applications require the sender email before review, filing, or archive');
    }

    if (!nextReceivedOnEmailAt) {
      throwGuardrail('Email-submitted applications require the received email timestamp before review, filing, or archive');
    }
  }
}

function validateApprovalGuardrails({ application, creditLimit, fileStats }) {
  if (creditLimit === undefined || creditLimit === null || creditLimit === '') {
    throwGuardrail('Approved credit limit must be set before approval');
  }

  const numericCreditLimit = Number(creditLimit);

  if (!Number.isFinite(numericCreditLimit) || numericCreditLimit < 0) {
    throwGuardrail('Approved credit limit must be a valid non-negative number');
  }

  if (!application.admin_reviewed) {
    throwGuardrail('Admin review must be completed before approval');
  }

  if (Number(fileStats.received_form_files || 0) < 1) {
    throwGuardrail('Upload at least one received form before approving this application');
  }

  const submittedVia = String(application.submitted_via || '').toLowerCase();

  if (submittedVia === 'email') {
    if (!String(application.received_email_subject || '').trim()) {
      throwGuardrail('Email-submitted applications cannot be approved without a received email subject');
    }

    if (!String(application.received_email_from || '').trim()) {
      throwGuardrail('Email-submitted applications cannot be approved without a sender email');
    }

    if (!application.received_on_email_at) {
      throwGuardrail('Email-submitted applications cannot be approved without a received email timestamp');
    }
  }

  return numericCreditLimit;
}

async function ensureUsernameAvailableForUpdate(client, rawUsername, excludeAccountId = null) {
  const normalized = normalizeUsernameSeed(rawUsername);

  const result = await client.query(
    `
    SELECT id
    FROM route_customer_accounts
    WHERE LOWER(username) = LOWER($1)
      AND ($2::int IS NULL OR id <> $2)
    LIMIT 1
    `,
    [normalized, excludeAccountId]
  );

  if (result.rows.length > 0) {
    const err = new Error('Username already exists');
    err.status = 409;
    throw err;
  }

  return normalized;
}

const submitApplication = async (req, res) => {
  try {
    const {
      applicant_name,
      business_name,
      email,
      phone,
      address,
      region_id,
      location_id,
      requested_credit_limit,
      submitted_via,
      form_reference,
    } = req.body;

    if (!applicant_name || !String(applicant_name).trim()) {
      return fail(res, 400, 'Applicant name is required');
    }

    if (!email || !String(email).trim()) {
      return fail(res, 400, 'Email is required');
    }

    if (!phone || !String(phone).trim()) {
      return fail(res, 400, 'Phone is required');
    }

    const numericCreditLimit =
      requested_credit_limit === undefined || requested_credit_limit === null || requested_credit_limit === ''
        ? 0
        : Number(requested_credit_limit);

    if (!Number.isFinite(numericCreditLimit) || numericCreditLimit < 0) {
      return fail(res, 400, 'Requested credit limit must be a valid non-negative number');
    }

    const validSubmittedVia = ['email', 'upload', 'manual'];
    const submittedVia = validSubmittedVia.includes(submitted_via) ? submitted_via : 'email';

    const result = await pool.query(
      `
      INSERT INTO route_customer_applications
      (
        applicant_name,
        business_name,
        email,
        phone,
        address,
        region_id,
        location_id,
        requested_credit_limit,
        submitted_via,
        form_reference,
        status,
        review_stage,
        received_email_from,
        received_on_email_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'received', $11, $12, NOW(), NOW())
      RETURNING *
      `,
      [
        String(applicant_name).trim(),
        business_name ? String(business_name).trim() : null,
        String(email).trim().toLowerCase(),
        String(phone).trim(),
        address ? String(address).trim() : null,
        region_id || null,
        location_id || null,
        numericCreditLimit,
        submittedVia,
        form_reference ? String(form_reference).trim() : null,
        submittedVia === 'email' ? String(email).trim().toLowerCase() : null,
        submittedVia === 'email' ? new Date().toISOString() : null,
      ]
    );

    await logRouteCustomerApplicationEvent(pool, {
      applicationId: result.rows[0].id,
      eventType: 'application_received',
      eventLabel: 'Application received',
      eventNotes: form_reference ? `Form reference: ${form_reference}` : null,
      actorUserId: null,
      metadata: {
        submitted_via: submittedVia,
        applicant_name: result.rows[0].applicant_name,
        business_name: result.rows[0].business_name,
        email: result.rows[0].email,
        requested_credit_limit: result.rows[0].requested_credit_limit,
      },
    });

    return success(res, 201, 'Application submitted successfully', {
      application: result.rows[0],
    });
  } catch (err) {
    console.error('❌ submitApplication error:', err.message);
    return fail(res, 500, 'Failed to submit application', { error: err.message });
  }
};

const getApplications = async (req, res) => {
  try {
    const { status } = req.query;

    let query = `
      SELECT
        a.*,
        r.name AS region_name,
        l.name AS location_name,
        c.name AS approved_customer_name,
        reviewer.email AS reviewed_by_email,
        receiver.email AS received_by_email,
        archiver.email AS archived_by_email
      FROM route_customer_applications a
      LEFT JOIN regions r ON a.region_id = r.id
      LEFT JOIN locations l ON a.location_id = l.id
      LEFT JOIN customers c ON a.approved_customer_id = c.id
      LEFT JOIN users reviewer ON a.reviewed_by_user_id = reviewer.id
      LEFT JOIN users receiver ON a.received_by_user_id = receiver.id
      LEFT JOIN users archiver ON a.archived_by_user_id = archiver.id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (status && String(status).trim()) {
      params.push(String(status).trim());
      query += ` AND a.status = $${paramIndex}`;
      paramIndex += 1;
    }

    query += ` ORDER BY a.created_at DESC`;

    const result = await pool.query(query, params);

    return success(res, 200, 'Applications retrieved successfully', {
      applications: result.rows,
      total: result.rows.length,
    });
  } catch (err) {
    console.error('❌ getApplications error:', err.message);
    return fail(res, 500, 'Failed to get applications', { error: err.message });
  }
};

const getApplicationEvents = async (req, res) => {
  try {
    const applicationId = Number(req.params.id);

    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      return fail(res, 400, 'Invalid application id');
    }

    const applicationCheck = await pool.query(
      `
      SELECT id
      FROM route_customer_applications
      WHERE id = $1
      LIMIT 1
      `,
      [applicationId]
    );

    if (applicationCheck.rows.length === 0) {
      return fail(res, 404, 'Application not found');
    }

    const events = await listRouteCustomerApplicationEvents(pool, applicationId);

    return success(res, 200, 'Application events retrieved successfully', {
      events,
      total: events.length,
    });
  } catch (err) {
    console.error('❌ getApplicationEvents error:', err.message);
    return fail(res, 500, 'Failed to get application events', { error: err.message });
  }
};

const saveApplicationWorkflow = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const applicationId = Number(req.params.id);

    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      await client.query('ROLLBACK');
      return fail(res, 400, 'Invalid application id');
    }

    const isPrintedInput = normalizeOptionalBoolean(req.body.is_printed, 'is_printed');
    const securityReviewedInput = normalizeOptionalBoolean(req.body.security_reviewed, 'security_reviewed');
    const financeReviewedInput = normalizeOptionalBoolean(req.body.finance_reviewed, 'finance_reviewed');
    const adminReviewedInput = normalizeOptionalBoolean(req.body.admin_reviewed, 'admin_reviewed');
    const physicallyFiledInput = normalizeOptionalBoolean(req.body.physically_filed, 'physically_filed');
    const digitallyArchivedInput = normalizeOptionalBoolean(req.body.digitally_archived, 'digitally_archived');

    const workflowNotesInput = sanitizeOptionalString(req.body.workflow_notes);
    const filedReferenceInput = sanitizeOptionalString(req.body.filed_reference);
    const adminNotesInput = sanitizeOptionalString(req.body.admin_notes);

    const receivedEmailSubjectInput = sanitizeOptionalString(req.body.received_email_subject);
    const receivedEmailFromInput = sanitizeOptionalString(req.body.received_email_from);
    const receivedOnEmailAtInput = normalizeOptionalTimestamp(req.body.received_on_email_at, 'received_on_email_at');
    const digitalFileNameInput = sanitizeOptionalString(req.body.digital_file_name);
    const digitalFileReferenceInput = sanitizeOptionalString(req.body.digital_file_reference);
    const explicitReceivedByUserIdInput = normalizeOptionalPositiveInteger(req.body.received_by_user_id, 'received_by_user_id');
    const explicitArchivedByUserIdInput = normalizeOptionalPositiveInteger(req.body.archived_by_user_id, 'archived_by_user_id');

    const explicitStage = sanitizeOptionalString(req.body.review_stage);

    if (explicitStage && !VALID_REVIEW_STAGES.has(explicitStage)) {
      await client.query('ROLLBACK');
      return fail(res, 400, `review_stage must be one of: ${Array.from(VALID_REVIEW_STAGES).join(', ')}`);
    }

    const applicationResult = await client.query(
      `
      SELECT *
      FROM route_customer_applications
      WHERE id = $1
      FOR UPDATE
      `,
      [applicationId]
    );

    if (applicationResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Application not found');
    }

    const current = applicationResult.rows[0];
    const fileStats = await getApplicationFileStats(client, applicationId);

    const nextWorkflow = {
      is_printed: isPrintedInput === undefined ? current.is_printed : isPrintedInput,
      security_reviewed: securityReviewedInput === undefined ? current.security_reviewed : securityReviewedInput,
      finance_reviewed: financeReviewedInput === undefined ? current.finance_reviewed : financeReviewedInput,
      admin_reviewed: adminReviewedInput === undefined ? current.admin_reviewed : adminReviewedInput,
      physically_filed: physicallyFiledInput === undefined ? current.physically_filed : physicallyFiledInput,
      digitally_archived: digitallyArchivedInput === undefined ? current.digitally_archived : digitallyArchivedInput,
    };

    validateWorkflowGuardrails({
      currentApplication: current,
      nextWorkflow,
      fileStats,
      patchValues: {
        filed_reference: filedReferenceInput,
        received_email_subject: receivedEmailSubjectInput,
        received_email_from: receivedEmailFromInput,
        received_on_email_at: receivedOnEmailAtInput,
      },
    });

    const nextReviewStage = inferReviewStage({
      explicitStage,
      status: current.status,
      workflow: nextWorkflow,
    });

    const shouldSetReceivedBy =
      explicitReceivedByUserIdInput !== undefined
        ? explicitReceivedByUserIdInput
        : (
            (receivedEmailSubjectInput !== undefined ||
              receivedEmailFromInput !== undefined ||
              receivedOnEmailAtInput !== undefined) &&
            req.user?.id
          )
          ? req.user.id
          : current.received_by_user_id;

    const shouldSetArchivedBy =
      explicitArchivedByUserIdInput !== undefined
        ? explicitArchivedByUserIdInput
        : (
            digitallyArchivedInput === true ||
            digitalFileNameInput !== undefined ||
            digitalFileReferenceInput !== undefined
          ) && req.user?.id
          ? req.user.id
          : current.archived_by_user_id;

    const nextArchivedAt =
      digitallyArchivedInput === undefined
        ? current.archived_at
        : digitallyArchivedInput === true
        ? current.archived_at || new Date().toISOString()
        : null;

    const updateResult = await client.query(
      `
      UPDATE route_customer_applications
      SET
        is_printed = $1,
        security_reviewed = $2,
        finance_reviewed = $3,
        admin_reviewed = $4,
        physically_filed = $5,
        digitally_archived = $6,
        printed_at = $7,
        security_reviewed_at = $8,
        finance_reviewed_at = $9,
        admin_reviewed_at = $10,
        physically_filed_at = $11,
        digitally_archived_at = $12,
        review_stage = $13,
        workflow_notes = $14,
        filed_reference = $15,
        admin_notes = $16,
        reviewed_by_user_id = $17,
        received_by_user_id = $18,
        received_email_subject = $19,
        received_email_from = $20,
        received_on_email_at = $21,
        digital_file_name = $22,
        digital_file_reference = $23,
        archived_by_user_id = $24,
        archived_at = $25,
        updated_at = NOW()
      WHERE id = $26
      RETURNING *
      `,
      [
        nextWorkflow.is_printed,
        nextWorkflow.security_reviewed,
        nextWorkflow.finance_reviewed,
        nextWorkflow.admin_reviewed,
        nextWorkflow.physically_filed,
        nextWorkflow.digitally_archived,
        deriveToggleTimestamp(current.printed_at, isPrintedInput),
        deriveToggleTimestamp(current.security_reviewed_at, securityReviewedInput),
        deriveToggleTimestamp(current.finance_reviewed_at, financeReviewedInput),
        deriveToggleTimestamp(current.admin_reviewed_at, adminReviewedInput),
        deriveToggleTimestamp(current.physically_filed_at, physicallyFiledInput),
        deriveToggleTimestamp(current.digitally_archived_at, digitallyArchivedInput),
        nextReviewStage,
        workflowNotesInput === undefined ? current.workflow_notes : workflowNotesInput,
        filedReferenceInput === undefined ? current.filed_reference : filedReferenceInput,
        adminNotesInput === undefined ? current.admin_notes : adminNotesInput,
        req.user?.id || current.reviewed_by_user_id || null,
        shouldSetReceivedBy,
        receivedEmailSubjectInput === undefined ? current.received_email_subject : receivedEmailSubjectInput,
        receivedEmailFromInput === undefined ? current.received_email_from : receivedEmailFromInput,
        receivedOnEmailAtInput === undefined ? current.received_on_email_at : receivedOnEmailAtInput,
        digitalFileNameInput === undefined ? current.digital_file_name : digitalFileNameInput,
        digitalFileReferenceInput === undefined ? current.digital_file_reference : digitalFileReferenceInput,
        shouldSetArchivedBy,
        nextArchivedAt,
        applicationId,
      ]
    );

    const updatedApplication = updateResult.rows[0];

    await logRouteCustomerApplicationEvent(client, {
      applicationId,
      eventType: 'workflow_updated',
      eventLabel: 'Workflow updated',
      eventNotes:
        workflowNotesInput ||
        adminNotesInput ||
        filedReferenceInput ||
        null,
      actorUserId: req.user?.id || null,
      metadata: {
        before: {
          is_printed: current.is_printed,
          security_reviewed: current.security_reviewed,
          finance_reviewed: current.finance_reviewed,
          admin_reviewed: current.admin_reviewed,
          physically_filed: current.physically_filed,
          digitally_archived: current.digitally_archived,
          review_stage: current.review_stage,
          digital_file_name: current.digital_file_name,
          digital_file_reference: current.digital_file_reference,
          received_email_subject: current.received_email_subject,
          received_email_from: current.received_email_from,
          filed_reference: current.filed_reference,
        },
        after: {
          is_printed: updatedApplication.is_printed,
          security_reviewed: updatedApplication.security_reviewed,
          finance_reviewed: updatedApplication.finance_reviewed,
          admin_reviewed: updatedApplication.admin_reviewed,
          physically_filed: updatedApplication.physically_filed,
          digitally_archived: updatedApplication.digitally_archived,
          review_stage: updatedApplication.review_stage,
          digital_file_name: updatedApplication.digital_file_name,
          digital_file_reference: updatedApplication.digital_file_reference,
          received_email_subject: updatedApplication.received_email_subject,
          received_email_from: updatedApplication.received_email_from,
          filed_reference: updatedApplication.filed_reference,
        },
      },
    });

    await client.query('COMMIT');

    return success(res, 200, 'Application workflow updated successfully', {
      application: updatedApplication,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ saveApplicationWorkflow error:', err.message);
    return fail(res, err.status || 500, err.message || 'Failed to update application workflow');
  } finally {
    client.release();
  }
};

const approveApplication = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const applicationId = Number(req.params.id);
    const {
      customer_id,
      username,
      temporary_password,
      credit_limit,
      credit_notes,
      admin_notes,
    } = req.body;

    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      await client.query('ROLLBACK');
      return fail(res, 400, 'Invalid application id');
    }

    const appResult = await client.query(
      `
      SELECT *
      FROM route_customer_applications
      WHERE id = $1
      FOR UPDATE
      `,
      [applicationId]
    );

    if (appResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Application not found');
    }

    const application = appResult.rows[0];

    if (application.status === 'approved') {
      await client.query('ROLLBACK');
      return fail(res, 409, 'Application is already approved');
    }

    const fileStats = await getApplicationFileStats(client, applicationId);
    const numericApprovedCreditLimit = validateApprovalGuardrails({
      application,
      creditLimit: credit_limit,
      fileStats,
    });

    let routeCustomerId = customer_id || application.approved_customer_id || null;

    if (routeCustomerId) {
      const existingCustomer = await client.query(
        `
        SELECT id, customer_type
        FROM customers
        WHERE id = $1
        `,
        [routeCustomerId]
      );

      if (existingCustomer.rows.length === 0) {
        await client.query('ROLLBACK');
        return fail(res, 404, 'Selected customer does not exist');
      }

      if (existingCustomer.rows[0].customer_type !== 'route') {
        await client.query('ROLLBACK');
        return fail(res, 400, 'Selected customer must be a route customer');
      }
    } else {
      const insertedCustomer = await client.query(
        `
        INSERT INTO customers
        (
          name,
          email,
          phone,
          address,
          customer_type,
          location_id,
          is_active,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, 'route', $5, TRUE, NOW(), NOW())
        RETURNING id, name, email, phone, customer_type, is_active
        `,
        [
          application.business_name || application.applicant_name,
          application.email,
          application.phone,
          application.address || null,
          application.location_id || null,
        ]
      );

      routeCustomerId = insertedCustomer.rows[0].id;
    }

    const provisioned = await provisionRouteCustomerAccount(client, {
      customerId: routeCustomerId,
      username,
      temporaryPassword: temporary_password,
      creditLimit: numericApprovedCreditLimit,
      creditNotes: credit_notes || null,
      approvedByUserId: req.user?.id || null,
    });

    await client.query(
      `
      UPDATE route_customer_applications
      SET
        status = 'approved',
        reviewed_by_user_id = $1,
        reviewed_at = NOW(),
        approved_customer_id = $2,
        admin_notes = $3,
        admin_reviewed = TRUE,
        admin_reviewed_at = COALESCE(admin_reviewed_at, NOW()),
        review_stage = CASE
          WHEN physically_filed = TRUE THEN 'filed'
          ELSE 'approved'
        END,
        updated_at = NOW()
      WHERE id = $4
      `,
      [
        req.user?.id || null,
        routeCustomerId,
        admin_notes || null,
        applicationId,
      ]
    );

    await logRouteCustomerApplicationEvent(client, {
      applicationId,
      eventType: 'application_approved',
      eventLabel: 'Application approved',
      eventNotes: admin_notes || null,
      actorUserId: req.user?.id || null,
      metadata: {
        approved_customer_id: routeCustomerId,
        username: provisioned.account.username,
        credit_limit: provisioned.credit_profile.credit_limit,
        is_credit_active: provisioned.credit_profile.is_credit_active,
        created_account_id: provisioned.account.id,
      },
    });

    await client.query('COMMIT');

    return success(res, 200, 'Application approved successfully', {
      application_id: applicationId,
      customer: provisioned.customer,
      account: provisioned.account,
      credit_profile: provisioned.credit_profile,
      credentials: {
        username: provisioned.account.username,
        temporary_password: provisioned.temporary_password,
        must_change_password: true,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ approveApplication error:', err.message);
    return fail(res, err.status || 500, err.message || 'Failed to approve application');
  } finally {
    client.release();
  }
};

const rejectApplication = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const applicationId = Number(req.params.id);
    const { admin_notes } = req.body;

    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      await client.query('ROLLBACK');
      return fail(res, 400, 'Invalid application id');
    }

    const result = await client.query(
      `
      UPDATE route_customer_applications
      SET
        status = 'rejected',
        reviewed_by_user_id = $1,
        reviewed_at = NOW(),
        admin_notes = $2,
        admin_reviewed = TRUE,
        admin_reviewed_at = COALESCE(admin_reviewed_at, NOW()),
        review_stage = 'rejected',
        updated_at = NOW()
      WHERE id = $3
      RETURNING *
      `,
      [req.user?.id || null, admin_notes || null, applicationId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Application not found');
    }

    await logRouteCustomerApplicationEvent(client, {
      applicationId,
      eventType: 'application_rejected',
      eventLabel: 'Application rejected',
      eventNotes: admin_notes || null,
      actorUserId: req.user?.id || null,
      metadata: {
        status: 'rejected',
      },
    });

    await client.query('COMMIT');

    return success(res, 200, 'Application rejected successfully', {
      application: result.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ rejectApplication error:', err.message);
    return fail(res, err.status || 500, err.message || 'Failed to reject application');
  } finally {
    client.release();
  }
};

const listRouteCustomers = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        c.id,
        c.name,
        c.email,
        c.phone,
        c.is_active,
        c.created_at,
        c.updated_at,
        l.name AS location_name,
        r.name AS region_name,
        a.username,
        a.must_change_password,
        a.is_active AS account_is_active,
        COALESCE(cp.is_credit_active, TRUE) AS is_credit_active,
        COALESCE(cp.credit_notes, '') AS credit_notes,
        fs.credit_limit,
        fs.current_balance,
        fs.available_credit,
        fs.overdue_balance,
        fs.total_route_orders,
        fs.total_ordered_value,
        fs.total_paid_value,
        fs.last_route_order_at
      FROM customers c
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN regions r ON l.region_id = r.id
      LEFT JOIN route_customer_accounts a ON a.customer_id = c.id
      LEFT JOIN route_customer_credit_profiles cp ON cp.customer_id = c.id
      LEFT JOIN route_customer_financial_summary fs ON fs.customer_id = c.id
      WHERE c.customer_type = 'route'
      ORDER BY c.id ASC
      `
    );

    return success(res, 200, 'Route customers retrieved successfully', {
      customers: result.rows,
      total: result.rows.length,
    });
  } catch (err) {
    console.error('❌ listRouteCustomers error:', err.message);
    return fail(res, 500, 'Failed to list route customers', { error: err.message });
  }
};

const createAccountForExistingCustomer = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const customerId = req.params.customerId;
    const { username, temporary_password, credit_limit, credit_notes } = req.body;

    const provisioned = await provisionRouteCustomerAccount(client, {
      customerId,
      username,
      temporaryPassword: temporary_password,
      creditLimit: credit_limit,
      creditNotes: credit_notes || null,
      approvedByUserId: req.user?.id || null,
    });

    await client.query('COMMIT');

    return success(res, 201, 'Route customer account created successfully', {
      customer: provisioned.customer,
      account: provisioned.account,
      credit_profile: provisioned.credit_profile,
      credentials: {
        username: provisioned.account.username,
        temporary_password: provisioned.temporary_password,
        must_change_password: true,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ createAccountForExistingCustomer error:', err.message);
    return fail(res, err.status || 500, err.message || 'Failed to create route customer account');
  } finally {
    client.release();
  }
};

const saveRouteCustomerAccess = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const customerId = Number(req.params.customerId);
    const {
      username,
      temporary_password,
      is_active,
      credit_limit,
      credit_notes,
      is_credit_active,
    } = req.body;

    const parsedIsActive = normalizeOptionalBoolean(is_active, 'is_active');
    const parsedIsCreditActive = normalizeOptionalBoolean(is_credit_active, 'is_credit_active');

    const customer = await assertRouteCustomerForAdmin(client, customerId);

    const existingAccountResult = await client.query(
      `
      SELECT *
      FROM route_customer_accounts
      WHERE customer_id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [customerId]
    );

    const existingAccount = existingAccountResult.rows[0] || null;

    let accountPayload = existingAccount;
    let issuedTemporaryPassword = null;

    if (!existingAccount) {
      const finalUsername =
        username && String(username).trim()
          ? await ensureUsernameAvailableForUpdate(client, username, null)
          : await buildUniqueUsername(
              client,
              customer.name || customer.email || customer.phone || `customer.${customer.id}`
            );

      issuedTemporaryPassword =
        temporary_password && String(temporary_password).trim()
          ? String(temporary_password).trim()
          : generateTemporaryPassword(10);

      const passwordHash = await bcrypt.hash(issuedTemporaryPassword, 10);

      const accountInsert = await client.query(
        `
        INSERT INTO route_customer_accounts
        (
          customer_id,
          username,
          password_hash,
          must_change_password,
          is_active,
          approved_by_user_id,
          approved_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, TRUE, $4, $5, NOW(), NOW(), NOW())
        RETURNING id, customer_id, username, must_change_password, is_active, approved_at, last_login_at
        `,
        [
          customerId,
          finalUsername,
          passwordHash,
          parsedIsActive === undefined ? true : parsedIsActive,
          req.user?.id || null,
        ]
      );

      accountPayload = accountInsert.rows[0];
    } else {
      const nextUsername =
        username && String(username).trim()
          ? await ensureUsernameAvailableForUpdate(client, username, existingAccount.id)
          : existingAccount.username;

      let nextPasswordHash = existingAccount.password_hash;
      let nextMustChangePassword = existingAccount.must_change_password;

      if (temporary_password !== undefined && String(temporary_password).trim() !== '') {
        issuedTemporaryPassword = String(temporary_password).trim();
        nextPasswordHash = await bcrypt.hash(issuedTemporaryPassword, 10);
        nextMustChangePassword = true;
      }

      const accountUpdate = await client.query(
        `
        UPDATE route_customer_accounts
        SET
          username = $1,
          password_hash = $2,
          must_change_password = $3,
          is_active = $4,
          updated_at = NOW()
        WHERE id = $5
        RETURNING id, customer_id, username, must_change_password, is_active, approved_at, last_login_at
        `,
        [
          nextUsername,
          nextPasswordHash,
          nextMustChangePassword,
          parsedIsActive === undefined ? existingAccount.is_active : parsedIsActive,
          existingAccount.id,
        ]
      );

      accountPayload = accountUpdate.rows[0];
    }

    const numericCreditLimit =
      credit_limit === undefined || credit_limit === null || credit_limit === ''
        ? 0
        : Number(credit_limit);

    if (!Number.isFinite(numericCreditLimit) || numericCreditLimit < 0) {
      const err = new Error('Credit limit must be a valid non-negative number');
      err.status = 400;
      throw err;
    }

    const creditResult = await client.query(
      `
      INSERT INTO route_customer_credit_profiles
      (
        customer_id,
        credit_limit,
        is_credit_active,
        credit_notes,
        created_by_user_id,
        updated_by_user_id,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $5, NOW(), NOW())
      ON CONFLICT (customer_id)
      DO UPDATE SET
        credit_limit = EXCLUDED.credit_limit,
        is_credit_active = EXCLUDED.is_credit_active,
        credit_notes = EXCLUDED.credit_notes,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = NOW()
      RETURNING id, customer_id, credit_limit, is_credit_active, credit_notes, created_at, updated_at
      `,
      [
        customerId,
        numericCreditLimit,
        parsedIsCreditActive === undefined ? true : parsedIsCreditActive,
        credit_notes || null,
        req.user?.id || null,
      ]
    );

    await client.query('COMMIT');

    return success(res, 200, 'Route customer access saved successfully', {
      customer,
      account: accountPayload,
      credit_profile: creditResult.rows[0],
      credentials: issuedTemporaryPassword
        ? {
            username: accountPayload?.username || null,
            temporary_password: issuedTemporaryPassword,
            must_change_password: true,
          }
        : null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ saveRouteCustomerAccess error:', err.message);
    return fail(res, err.status || 500, err.message || 'Failed to save route customer access');
  } finally {
    client.release();
  }
};

const loginRouteCustomer = async (req, res) => {
  const client = await pool.connect();

  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return fail(res, 400, 'Username and password are required');
    }

    const accountResult = await client.query(
      `
      SELECT
        a.id,
        a.customer_id,
        a.username,
        a.password_hash,
        a.must_change_password,
        a.is_active AS account_is_active,
        a.last_login_at,
        c.name AS customer_name,
        c.email AS customer_email,
        c.phone AS customer_phone,
        c.is_active AS customer_is_active
      FROM route_customer_accounts a
      INNER JOIN customers c ON c.id = a.customer_id
      WHERE LOWER(a.username) = LOWER($1)
      LIMIT 1
      `,
      [String(username).trim()]
    );

    const account = accountResult.rows[0] || null;
    const auditIp = getClientIp(req);
    const auditUserAgent = req.headers['user-agent'] || null;

    if (!account) {
      await insertLoginAudit(client, {
        login_status: 'failed',
        failure_reason: 'Unknown username',
        ip_address: auditIp,
        user_agent: auditUserAgent,
      });

      return fail(res, 401, 'Invalid credentials');
    }

    if (!account.account_is_active || !account.customer_is_active) {
      await insertLoginAudit(client, {
        account_id: account.id,
        customer_id: account.customer_id,
        login_status: 'failed',
        failure_reason: 'Account is disabled',
        ip_address: auditIp,
        user_agent: auditUserAgent,
      });

      return fail(res, 403, 'Account is disabled');
    }

    const passwordMatch = await bcrypt.compare(password, account.password_hash);

    if (!passwordMatch) {
      await insertLoginAudit(client, {
        account_id: account.id,
        customer_id: account.customer_id,
        login_status: 'failed',
        failure_reason: 'Invalid password',
        ip_address: auditIp,
        user_agent: auditUserAgent,
      });

      return fail(res, 401, 'Invalid credentials');
    }

    await client.query(
      `
      UPDATE route_customer_accounts
      SET
        last_login_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      `,
      [account.id]
    );

    await insertLoginAudit(client, {
      account_id: account.id,
      customer_id: account.customer_id,
      login_status: 'success',
      ip_address: auditIp,
      user_agent: auditUserAgent,
    });

    const token = signRouteCustomerToken(account);

    return success(res, 200, 'Route customer login successful', {
      token,
      account: {
        id: account.id,
        customer_id: account.customer_id,
        username: account.username,
        must_change_password: account.must_change_password,
        last_login_at: account.last_login_at,
      },
      customer: {
        id: account.customer_id,
        name: account.customer_name,
        email: account.customer_email,
        phone: account.customer_phone,
      },
    });
  } catch (err) {
    console.error('❌ loginRouteCustomer error:', err.message);
    return fail(res, 500, 'Route customer login failed', { error: err.message });
  } finally {
    client.release();
  }
};

const changeRouteCustomerPassword = async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    const accountId = req.routeCustomerAuth?.account_id;

    if (!current_password || !new_password || !confirm_password) {
      return fail(res, 400, 'Current password, new password, and confirm password are required');
    }

    if (String(new_password) !== String(confirm_password)) {
      return fail(res, 400, 'New password and confirmation do not match');
    }

    if (String(new_password).length < 8) {
      return fail(res, 400, 'New password must be at least 8 characters long');
    }

    const accountResult = await pool.query(
      `
      SELECT
        a.id,
        a.customer_id,
        a.password_hash,
        a.must_change_password,
        a.is_active AS account_is_active,
        c.is_active AS customer_is_active
      FROM route_customer_accounts a
      INNER JOIN customers c ON c.id = a.customer_id
      WHERE a.id = $1
      LIMIT 1
      `,
      [accountId]
    );

    if (accountResult.rows.length === 0) {
      return fail(res, 404, 'Route customer account not found');
    }

    const account = accountResult.rows[0];

    if (!account.account_is_active || !account.customer_is_active) {
      return fail(res, 403, 'Account is disabled');
    }

    const currentMatches = await bcrypt.compare(current_password, account.password_hash);

    if (!currentMatches) {
      return fail(res, 401, 'Current password is incorrect');
    }

    const newHash = await bcrypt.hash(String(new_password), 10);

    await pool.query(
      `
      UPDATE route_customer_accounts
      SET
        password_hash = $1,
        must_change_password = FALSE,
        updated_at = NOW()
      WHERE id = $2
      `,
      [newHash, accountId]
    );

    return success(res, 200, 'Password changed successfully');
  } catch (err) {
    console.error('❌ changeRouteCustomerPassword error:', err.message);
    return fail(res, 500, 'Failed to change password', { error: err.message });
  }
};

const getRouteCustomerDashboard = async (req, res) => {
  try {
    const customerId = req.routeCustomerAuth?.customer_id;
    const accountId = req.routeCustomerAuth?.account_id;

    const accountResult = await pool.query(
      `
      SELECT
        a.id,
        a.username,
        a.must_change_password,
        a.is_active AS account_is_active,
        a.last_login_at,
        c.id AS customer_id,
        c.name AS customer_name,
        c.email,
        c.phone,
        c.is_active AS customer_is_active,
        c.created_at AS customer_created_at
      FROM route_customer_accounts a
      INNER JOIN customers c ON c.id = a.customer_id
      WHERE a.id = $1 AND c.id = $2
      LIMIT 1
      `,
      [accountId, customerId]
    );

    if (accountResult.rows.length === 0) {
      return fail(res, 404, 'Route customer account not found');
    }

    const account = accountResult.rows[0];

    if (!account.account_is_active || !account.customer_is_active) {
      return fail(res, 403, 'Account is disabled');
    }

    const summaryResult = await pool.query(
      `
      SELECT *
      FROM route_customer_financial_summary
      WHERE customer_id = $1
      LIMIT 1
      `,
      [customerId]
    );

    const assignedRepResult = await pool.query(
      `
      SELECT
        sr.id,
        sr.name,
        sr.phone_number,
        sr.email
      FROM customers c
      LEFT JOIN sales_reps sr ON c.sales_rep_id = sr.id
      WHERE c.id = $1
      LIMIT 1
      `,
      [customerId]
    );

    const servedByRepsResult = await pool.query(
      `
      SELECT DISTINCT
        u.id,
        TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS full_name,
        u.email,
        u.phone_number
      FROM orders o
      LEFT JOIN users u ON o.sales_rep_id = u.id
      WHERE o.customer_id = $1
        AND o.order_type = 'route'
        AND o.sales_rep_id IS NOT NULL
      ORDER BY full_name ASC NULLS LAST, u.email ASC NULLS LAST
      `,
      [customerId]
    );

    const recentOrdersResult = await pool.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.order_type,
        o.total_amount,
        COALESCE(o.amount_paid, 0)::numeric(12,2) AS amount_paid,
        GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)::numeric(12,2) AS balance_due,
        o.order_status,
        o.payment_status,
        o.payment_state,
        o.due_date,
        o.created_at,
        TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS sales_rep_name,
        u.email AS sales_rep_email
      FROM orders o
      LEFT JOIN users u ON o.sales_rep_id = u.id
      WHERE o.customer_id = $1
        AND o.order_type = 'route'
      ORDER BY o.created_at DESC
      LIMIT 10
      `,
      [customerId]
    );

    const recentPaymentsResult = await pool.query(
      `
      SELECT
        p.id,
        p.amount,
        p.status,
        p.method,
        p.transaction_id,
        p.mpesa_receipt_number,
        p.created_at,
        p.completed_at,
        o.order_number
      FROM payments p
      INNER JOIN orders o ON p.order_id = o.id
      WHERE o.customer_id = $1
      ORDER BY p.created_at DESC
      LIMIT 10
      `,
      [customerId]
    );

    return success(res, 200, 'Route customer dashboard retrieved successfully', {
      account: {
        id: account.id,
        username: account.username,
        must_change_password: account.must_change_password,
        last_login_at: account.last_login_at,
      },
      customer: {
        id: account.customer_id,
        name: account.customer_name,
        email: account.email,
        phone: account.phone,
        member_since: account.customer_created_at,
      },
      financial_summary: summaryResult.rows[0] || null,
      assigned_sales_rep: assignedRepResult.rows[0] || null,
      served_by_sales_reps: servedByRepsResult.rows,
      recent_orders: recentOrdersResult.rows,
      recent_payments: recentPaymentsResult.rows,
    });
  } catch (err) {
    console.error('❌ getRouteCustomerDashboard error:', err.message);
    return fail(res, 500, 'Failed to get route customer dashboard', { error: err.message });
  }
};

module.exports = {
  submitApplication,
  getApplications,
  getApplicationEvents,
  saveApplicationWorkflow,
  approveApplication,
  rejectApplication,
  listRouteCustomers,
  createAccountForExistingCustomer,
  saveRouteCustomerAccess,
  loginRouteCustomer,
  changeRouteCustomerPassword,
  getRouteCustomerDashboard,
};