'use strict';

const pool = require('../config/database');
const { handleError, handleSuccess } = require('../utils/errorHandler');

// Helper: generate a URL-friendly slug from a title
const generateSlug = (title) => {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
};

// Helper: ensure slug is unique by appending a counter if needed
const ensureUniqueSlug = async (baseSlug, excludeId = null) => {
  let slug = baseSlug;
  let counter = 1;
  while (true) {
    const params = [slug];
    let query = 'SELECT id FROM blog_posts WHERE slug = $1';
    if (excludeId) {
      query += ' AND id != $2';
      params.push(excludeId);
    }
    const result = await pool.query(query, params);
    if (result.rows.length === 0) break;
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
  return slug;
};

// GET /api/blog — public list; returns published posts for storefront,
// all posts for admin (when ?all=true is passed with a valid admin token)
const getAllBlogPosts = async (req, res) => {
  try {
    const { all, search, limit, offset } = req.query;

    const params = [];
    let paramIndex = 1;

    let whereClause = '';
    // Admin can request all posts (draft + published); storefront only sees published
    if (all === 'true' && req.user) {
      // No status filter
    } else {
      whereClause = `WHERE bp.status = 'published'`;
    }

    if (search) {
      const connector = whereClause ? 'AND' : 'WHERE';
      params.push(`%${search}%`);
      whereClause += ` ${connector} (bp.title ILIKE $${paramIndex} OR bp.excerpt ILIKE $${paramIndex})`;
      paramIndex++;
    }

    const limitVal = parseInt(limit) > 0 ? parseInt(limit) : 20;
    const offsetVal = parseInt(offset) >= 0 ? parseInt(offset) : 0;

    params.push(limitVal);
    params.push(offsetVal);

    const query = `
      SELECT
        bp.id,
        bp.title,
        bp.slug,
        bp.excerpt,
        bp.featured_image_url,
        bp.status,
        bp.published_at,
        bp.associated_product_id,
        bp.created_by_user_id,
        bp.created_at,
        bp.updated_at
      FROM blog_posts bp
      ${whereClause}
      ORDER BY bp.published_at DESC NULLS LAST, bp.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM blog_posts bp
      ${whereClause}
    `;
    // Build count params (exclude limit/offset at end of params array)
    const countParams = params.slice(0, params.length - 2);

    const [result, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, countParams),
    ]);

    return handleSuccess(res, 200, 'Blog posts retrieved successfully', {
      posts: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit: limitVal,
      offset: offsetVal,
    });
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve blog posts', err);
  }
};

// GET /api/blog/:idOrSlug — public single post by numeric id or slug
const getBlogPost = async (req, res) => {
  try {
    const { idOrSlug } = req.params;

    const isNumeric = /^\d+$/.test(idOrSlug);

    let query;
    let params;

    if (isNumeric) {
      query = `
        SELECT
          bp.id,
          bp.title,
          bp.slug,
          bp.excerpt,
          bp.content,
          bp.featured_image_url,
          bp.status,
          bp.published_at,
          bp.associated_product_id,
          bp.created_by_user_id,
          bp.created_at,
          bp.updated_at
        FROM blog_posts bp
        WHERE bp.id = $1
      `;
      params = [parseInt(idOrSlug)];
    } else {
      query = `
        SELECT
          bp.id,
          bp.title,
          bp.slug,
          bp.excerpt,
          bp.content,
          bp.featured_image_url,
          bp.status,
          bp.published_at,
          bp.associated_product_id,
          bp.created_by_user_id,
          bp.created_at,
          bp.updated_at
        FROM blog_posts bp
        WHERE bp.slug = $1
      `;
      params = [idOrSlug];
    }

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Blog post not found');
    }

    const post = result.rows[0];

    // Non-admin public requests should only see published posts
    if (post.status !== 'published' && !req.user) {
      return handleError(res, 404, 'Blog post not found');
    }

    return handleSuccess(res, 200, 'Blog post retrieved successfully', post);
  } catch (err) {
    return handleError(res, 500, 'Failed to retrieve blog post', err);
  }
};

// POST /api/blog — admin-only create
const createBlogPost = async (req, res) => {
  try {
    const {
      title,
      slug: rawSlug,
      excerpt,
      content,
      featured_image_url,
      associated_product_id,
      status,
      published_at,
    } = req.body;

    if (!title || !title.trim()) {
      return handleError(res, 400, 'title is required');
    }
    if (!content || !content.trim()) {
      return handleError(res, 400, 'content is required');
    }

    const postStatus = status === 'published' ? 'published' : 'draft';

    const baseSlug = rawSlug
      ? generateSlug(rawSlug)
      : generateSlug(title);

    if (!baseSlug) {
      return handleError(res, 400, 'Unable to generate a valid slug from the provided title');
    }

    const slug = await ensureUniqueSlug(baseSlug);

    // Auto-set published_at when publishing for the first time
    let resolvedPublishedAt = published_at || null;
    if (postStatus === 'published' && !resolvedPublishedAt) {
      resolvedPublishedAt = new Date().toISOString();
    }

    const createdByUserId = req.user ? req.user.id : null;

    const result = await pool.query(
      `INSERT INTO blog_posts
        (title, slug, excerpt, content, featured_image_url, associated_product_id,
         status, published_at, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        title.trim(),
        slug,
        excerpt ? excerpt.trim() : null,
        content.trim(),
        featured_image_url || null,
        associated_product_id || null,
        postStatus,
        resolvedPublishedAt,
        createdByUserId,
      ]
    );

    return handleSuccess(res, 201, 'Blog post created successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'A blog post with this slug already exists');
    }
    return handleError(res, 500, 'Failed to create blog post', err);
  }
};

// PUT /api/blog/:id — admin-only update
const updateBlogPost = async (req, res) => {
  try {
    const { id } = req.params;

    if (!/^\d+$/.test(id)) {
      return handleError(res, 400, 'Invalid blog post id');
    }

    const {
      title,
      slug: rawSlug,
      excerpt,
      content,
      featured_image_url,
      associated_product_id,
      status,
      published_at,
    } = req.body;

    // Fetch existing post
    const existing = await pool.query('SELECT * FROM blog_posts WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return handleError(res, 404, 'Blog post not found');
    }

    const current = existing.rows[0];

    const newTitle = title ? title.trim() : current.title;
    const newContent = content ? content.trim() : current.content;
    const newExcerpt = excerpt !== undefined ? (excerpt ? excerpt.trim() : null) : current.excerpt;
    const newFeaturedImageUrl = featured_image_url !== undefined ? (featured_image_url || null) : current.featured_image_url;
    const newAssociatedProductId = associated_product_id !== undefined ? (associated_product_id || null) : current.associated_product_id;
    const newStatus = status === 'published' ? 'published' : status === 'draft' ? 'draft' : current.status;

    // Handle slug update
    let newSlug = current.slug;
    if (rawSlug && rawSlug.trim()) {
      const baseSlug = generateSlug(rawSlug);
      newSlug = await ensureUniqueSlug(baseSlug, parseInt(id));
    } else if (title && title.trim()) {
      // Only auto-regenerate slug if title changed significantly
      // (keep existing slug by default to avoid breaking links)
      newSlug = current.slug;
    }

    // Auto-set published_at when transitioning to published
    let newPublishedAt;
    if (published_at !== undefined) {
      newPublishedAt = published_at || null;
    } else if (newStatus === 'published' && !current.published_at) {
      newPublishedAt = new Date().toISOString();
    } else {
      newPublishedAt = current.published_at;
    }

    const result = await pool.query(
      `UPDATE blog_posts
       SET title = $1,
           slug = $2,
           excerpt = $3,
           content = $4,
           featured_image_url = $5,
           associated_product_id = $6,
           status = $7,
           published_at = $8,
           updated_at = now()
       WHERE id = $9
       RETURNING *`,
      [
        newTitle,
        newSlug,
        newExcerpt,
        newContent,
        newFeaturedImageUrl,
        newAssociatedProductId,
        newStatus,
        newPublishedAt,
        id,
      ]
    );

    return handleSuccess(res, 200, 'Blog post updated successfully', result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return handleError(res, 400, 'A blog post with this slug already exists');
    }
    return handleError(res, 500, 'Failed to update blog post', err);
  }
};

// DELETE /api/blog/:id — admin-only delete
const deleteBlogPost = async (req, res) => {
  try {
    const { id } = req.params;

    if (!/^\d+$/.test(id)) {
      return handleError(res, 400, 'Invalid blog post id');
    }

    const result = await pool.query(
      'DELETE FROM blog_posts WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return handleError(res, 404, 'Blog post not found');
    }

    return handleSuccess(res, 200, 'Blog post deleted successfully');
  } catch (err) {
    return handleError(res, 500, 'Failed to delete blog post', err);
  }
};

module.exports = {
  getAllBlogPosts,
  getBlogPost,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
};
