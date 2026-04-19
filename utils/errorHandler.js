const handleError = (res, statusCode, message, error = null) => {
  console.error(`[ERROR ${statusCode}] ${message}`, error?.message || '');
  return res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === 'development' && error && { details: error.message })
  });
};

const handleSuccess = (res, statusCode, message, data = null) => {
  return res.status(statusCode).json({
    success: true,
    message,
    ...(data && { data })
  });
};

module.exports = { handleError, handleSuccess };