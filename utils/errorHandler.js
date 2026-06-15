'use strict';

function getRequestId(res) {
  return res?.locals?.requestId || null;
}

function getDefaultErrorCode(statusCode) {
  if (statusCode === 400) return 'VALIDATION_ERROR';
  if (statusCode === 401) return 'AUTHENTICATION_REQUIRED';
  if (statusCode === 403) return 'FORBIDDEN';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 409) return 'CONFLICT';
  if (statusCode === 422) return 'BUSINESS_RULE_FAILED';
  if (statusCode === 429) return 'RATE_LIMITED';
  if (statusCode >= 500) return 'INTERNAL_ERROR';
  return 'REQUEST_FAILED';
}

function buildErrorPayload(res, statusCode, message, error = null) {
  const requestId = getRequestId(res);
  const isDevelopment = process.env.NODE_ENV === 'development';
  const details = isDevelopment && error ? error.message : undefined;
  const code = error?.code && typeof error.code === 'string'
    ? error.code
    : getDefaultErrorCode(statusCode);

  return {
    success: false,
    error: message,
    message,
    ...(requestId && { requestId }),
    ...(details && { details }),
    errorDetails: {
      code,
      message,
      ...(requestId && { requestId }),
      ...(details && { details }),
    },
  };
}

const handleError = (res, statusCode, message, error = null) => {
  const requestId = getRequestId(res) || '-';
  console.error(
    `[ERROR ${statusCode}] requestId=${requestId} ${message}`,
    error?.message || ''
  );

  return res.status(statusCode).json(buildErrorPayload(res, statusCode, message, error));
};

const handleSuccess = (res, statusCode, message, data = null) => {
  const requestId = getRequestId(res);

  return res.status(statusCode).json({
    success: true,
    message,
    ...(data !== null && data !== undefined && { data }),
    ...(requestId && { meta: { requestId } }),
  });
};

module.exports = {
  handleError,
  handleSuccess,
  buildErrorPayload,
};
