const express = require('express');
const {
  listStorefrontProducts,
  listFeaturedStorefrontProducts,
  searchStorefrontProducts,
  listStorefrontCategories,
} = require('../controllers/storefrontController');

const router = express.Router();

router.get('/products', listStorefrontProducts);
router.get('/products/featured', listFeaturedStorefrontProducts);
router.get('/products/search', searchStorefrontProducts);
router.get('/categories', listStorefrontCategories);

module.exports = router;
