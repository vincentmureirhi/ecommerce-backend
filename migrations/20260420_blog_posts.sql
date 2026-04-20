-- Migration: Blog posts table
-- Creates blog_posts table for managing blog content from the admin panel.

BEGIN;

CREATE TABLE IF NOT EXISTS public.blog_posts (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title character varying(255) NOT NULL,
    slug character varying(255) NOT NULL,
    excerpt text,
    content text NOT NULL,
    featured_image_url text,
    associated_product_id integer,
    status character varying(20) NOT NULL DEFAULT 'draft',
    published_at timestamp with time zone,
    created_by_user_id integer,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT blog_posts_slug_unique UNIQUE (slug),
    CONSTRAINT blog_posts_status_check CHECK (status IN ('draft', 'published')),
    CONSTRAINT blog_posts_associated_product_id_fkey
        FOREIGN KEY (associated_product_id) REFERENCES public.products(id) ON DELETE SET NULL,
    CONSTRAINT blog_posts_created_by_user_id_fkey
        FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_status
    ON public.blog_posts (status);

CREATE INDEX IF NOT EXISTS idx_blog_posts_slug
    ON public.blog_posts (slug);

CREATE INDEX IF NOT EXISTS idx_blog_posts_published_at
    ON public.blog_posts (published_at DESC);

COMMIT;
