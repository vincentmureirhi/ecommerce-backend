-- Migration: Flash Sales tables
-- Creates flash_sales and flash_sale_products tables for managing
-- promotional deals and discounts on products.

BEGIN;

CREATE TABLE IF NOT EXISTS public.flash_sales (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name character varying(150) NOT NULL,
    description text,
    discount_type character varying(20) NOT NULL DEFAULT 'percentage',
    discount_value numeric(10,2) NOT NULL,
    start_date timestamp with time zone NOT NULL,
    end_date timestamp with time zone NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_by_user_id integer,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT flash_sales_discount_type_check
        CHECK (discount_type IN ('percentage', 'fixed')),
    CONSTRAINT flash_sales_discount_value_check
        CHECK (discount_value >= 0),
    CONSTRAINT flash_sales_date_check
        CHECK (end_date > start_date),
    CONSTRAINT flash_sales_created_by_user_id_fkey
        FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.flash_sale_products (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    flash_sale_id integer NOT NULL,
    product_id integer NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT flash_sale_products_flash_sale_id_fkey
        FOREIGN KEY (flash_sale_id) REFERENCES public.flash_sales(id) ON DELETE CASCADE,
    CONSTRAINT flash_sale_products_product_id_fkey
        FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE,
    CONSTRAINT flash_sale_products_unique
        UNIQUE (flash_sale_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_flash_sales_active_dates
    ON public.flash_sales (is_active, start_date, end_date);

CREATE INDEX IF NOT EXISTS idx_flash_sale_products_product
    ON public.flash_sale_products (product_id);

COMMIT;
