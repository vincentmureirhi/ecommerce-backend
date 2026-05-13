const assert = require('assert');
const path = require('path');

const routePath = path.resolve(__dirname, './salesReps.js');
const authMiddlewarePath = path.resolve(__dirname, '../middleware/authMiddleware.js');
const salesRepAuthMiddlewarePath = path.resolve(__dirname, '../middleware/salesRepAuthMiddleware.js');
const rateLimitMiddlewarePath = path.resolve(__dirname, '../middleware/rateLimitMiddleware.js');
const controllerPath = path.resolve(__dirname, '../controllers/salesRepController.js');

delete require.cache[routePath];
delete require.cache[authMiddlewarePath];
delete require.cache[salesRepAuthMiddlewarePath];
delete require.cache[rateLimitMiddlewarePath];
delete require.cache[controllerPath];

const verifyToken = (req, res, next) => next();
const requireAdmin = (req, res, next) => next();
const verifySalesRepToken = (req, res, next) => next();
const salesRepLoginRateLimiter = (req, res, next) => next();
const salesRepRateLimiter = (req, res, next) => next();
const noop = (req, res) => res;

require.cache[authMiddlewarePath] = {
  id: authMiddlewarePath,
  filename: authMiddlewarePath,
  loaded: true,
  exports: { verifyToken, requireAdmin },
};

require.cache[salesRepAuthMiddlewarePath] = {
  id: salesRepAuthMiddlewarePath,
  filename: salesRepAuthMiddlewarePath,
  loaded: true,
  exports: { verifySalesRepToken },
};

require.cache[rateLimitMiddlewarePath] = {
  id: rateLimitMiddlewarePath,
  filename: rateLimitMiddlewarePath,
  loaded: true,
  exports: { salesRepLoginRateLimiter, salesRepRateLimiter },
};

require.cache[controllerPath] = {
  id: controllerPath,
  filename: controllerPath,
  loaded: true,
  exports: {
    getAllSalesReps: noop,
    getSalesRepById: noop,
    saveSalesRepLocation: noop,
    saveOwnSalesRepLocation: noop,
    getLatestSalesRepLocation: noop,
    getLatestSalesRepLocations: noop,
    loginSalesRep: noop,
    getSalesRepSession: noop,
    changeSalesRepPassword: noop,
    createSalesRep: noop,
    updateSalesRep: noop,
    resetSalesRepPassword: noop,
    deleteSalesRep: noop,
  },
};

const router = require('./salesReps');

function getRouteHandlers(path, method) {
  const layer = router.stack.find(
    (entry) => entry.route && entry.route.path === path && entry.route.methods[method]
  );
  assert(layer, `Expected route ${method.toUpperCase()} ${path} to exist`);
  return layer.route.stack.map((entry) => entry.handle);
}

{
  const handlers = getRouteHandlers('/me/location', 'post');
  assert(handlers.includes(verifySalesRepToken), 'POST /me/location must require sales rep auth');
  assert(!handlers.includes(requireAdmin), 'POST /me/location must not require admin auth');
}

{
  const handlers = getRouteHandlers('/:id/location', 'post');
  assert(handlers.includes(verifyToken), 'POST /:id/location must require admin token auth');
  assert(handlers.includes(requireAdmin), 'POST /:id/location must require admin role');
}

{
  const handlers = getRouteHandlers('/:id/location/latest', 'get');
  assert(handlers.includes(verifyToken), 'GET /:id/location/latest must require admin token auth');
  assert(handlers.includes(requireAdmin), 'GET /:id/location/latest must require admin role');
}

console.log('salesReps route access tests passed');
