const express = require('express');
const {
  listStorefrontProducts,
  listFeaturedStorefrontProducts,
  searchStorefrontProducts,
  getStorefrontProductById,
  listStorefrontCategories,
} = require('../controllers/storefrontController');
const { listHomeMerchandising, trackProductEvent } = require('../controllers/collectionController');

const router = express.Router();

router.get('/products', listStorefrontProducts);
router.get('/products/featured', listFeaturedStorefrontProducts);
router.get('/products/search', searchStorefrontProducts);
router.get('/merchandising/home', listHomeMerchandising);
router.post('/products/:id/events', trackProductEvent);
router.get('/products/:id', getStorefrontProductById);
router.get('/categories', listStorefrontCategories);

module.exports = router;
