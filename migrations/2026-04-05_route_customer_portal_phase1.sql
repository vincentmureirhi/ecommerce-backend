BEGIN;

CREATE TABLE IF NOT EXISTS public.route_customer_applications (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    applicant_name character varying(100) NOT NULL,
    business_name character varying(150),
    email character varying(100) NOT NULL,
    phone character varying(20) NOT NULL,
    address text,
    region_id integer,
    location_id integer,
    requested_credit_limit numeric(12,2) DEFAULT 0 NOT NULL,
    submitted_via character varying(20) DEFAULT 'email' NOT NULL,
    form_reference text,
    admin_notes text,
    status character varying(20) DEFAULT 'pending' NOT NULL,
    reviewed_by_user_id integer,
    reviewed_at timestamp with time zone,
    approved_customer_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT route_customer_applications_status_check
        CHECK (status IN ('pending', 'under_review', 'approved', 'rejected')),
    CONSTRAINT route_customer_applications_submitted_via_check
        CHECK (submitted_via IN ('email', 'upload', 'manual')),
    CONSTRAINT route_customer_applications_requested_credit_limit_check
        CHECK (requested_credit_limit >= 0),
    CONSTRAINT route_customer_applications_region_id_fkey
        FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE SET NULL,
    CONSTRAINT route_customer_applications_location_id_fkey
        FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL,
    CONSTRAINT route_customer_applications_reviewed_by_user_id_fkey
        FOREIGN KEY (reviewed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT route_customer_applications_approved_customer_id_fkey
        FOREIGN KEY (approved_customer_id) REFERENCES public.customers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.route_customer_accounts (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id integer NOT NULL,
    username character varying(50) NOT NULL,
    password_hash character varying(255) NOT NULL,
    must_change_password boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    approved_by_user_id integer,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT route_customer_accounts_customer_id_fkey
        FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE,
    CONSTRAINT route_customer_accounts_approved_by_user_id_fkey
        FOREIGN KEY (approved_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT route_customer_accounts_customer_id_key UNIQUE (customer_id)
);

CREATE TABLE IF NOT EXISTS public.route_customer_credit_profiles (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id integer NOT NULL,
    credit_limit numeric(12,2) DEFAULT 0 NOT NULL,
    is_credit_active boolean DEFAULT true NOT NULL,
    credit_notes text,
    created_by_user_id integer,
    updated_by_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT route_customer_credit_profiles_customer_id_fkey
        FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE,
    CONSTRAINT route_customer_credit_profiles_created_by_user_id_fkey
        FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT route_customer_credit_profiles_updated_by_user_id_fkey
        FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT route_customer_credit_profiles_credit_limit_check
        CHECK (credit_limit >= 0),
    CONSTRAINT route_customer_credit_profiles_customer_id_key UNIQUE (customer_id)
);

CREATE TABLE IF NOT EXISTS public.route_customer_login_audit (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id integer,
    customer_id integer,
    login_status character varying(20) NOT NULL,
    failure_reason character varying(255),
    ip_address character varying(64),
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT route_customer_login_audit_account_id_fkey
        FOREIGN KEY (account_id) REFERENCES public.route_customer_accounts(id) ON DELETE SET NULL,
    CONSTRAINT route_customer_login_audit_customer_id_fkey
        FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL,
    CONSTRAINT route_customer_login_audit_login_status_check
        CHECK (login_status IN ('success', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_route_customer_accounts_username_lower
    ON public.route_customer_accounts (LOWER(username));

CREATE INDEX IF NOT EXISTS idx_route_customer_applications_status
    ON public.route_customer_applications (status);

CREATE INDEX IF NOT EXISTS idx_route_customer_applications_email
    ON public.route_customer_applications (email);

CREATE INDEX IF NOT EXISTS idx_route_customer_login_audit_customer_id
    ON public.route_customer_login_audit (customer_id);

CREATE INDEX IF NOT EXISTS idx_route_customer_login_audit_created_at
    ON public.route_customer_login_audit (created_at DESC);

CREATE OR REPLACE VIEW public.route_customer_financial_summary AS
SELECT
    c.id AS customer_id,
    c.name AS customer_name,
    c.email,
    c.phone,
    c.location_id,
    l.name AS location_name,
    r.id AS region_id,
    r.name AS region_name,
    COALESCE(cp.credit_limit, 0)::numeric(12,2) AS credit_limit,
    COALESCE(SUM(CASE WHEN o.order_type = 'route' THEN o.total_amount ELSE 0 END), 0)::numeric(12,2) AS total_ordered_value,
    COALESCE(SUM(CASE WHEN o.order_type = 'route' THEN COALESCE(o.amount_paid, 0) ELSE 0 END), 0)::numeric(12,2) AS total_paid_value,
    COALESCE(
        SUM(
            CASE
                WHEN o.order_type = 'route'
                THEN GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)
                ELSE 0
            END
        ),
        0
    )::numeric(12,2) AS current_balance,
    COALESCE(
        SUM(
            CASE
                WHEN o.order_type = 'route'
                 AND o.due_date IS NOT NULL
                 AND o.due_date < CURRENT_DATE
                THEN GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)
                ELSE 0
            END
        ),
        0
    )::numeric(12,2) AS overdue_balance,
    GREATEST(
        COALESCE(cp.credit_limit, 0) -
        COALESCE(
            SUM(
                CASE
                    WHEN o.order_type = 'route'
                    THEN GREATEST(COALESCE(o.total_amount, 0) - COALESCE(o.amount_paid, 0), 0)
                    ELSE 0
                END
            ),
            0
        ),
        0
    )::numeric(12,2) AS available_credit,
    COUNT(DISTINCT CASE WHEN o.order_type = 'route' THEN o.id END) AS total_route_orders,
    MAX(CASE WHEN o.order_type = 'route' THEN o.created_at END) AS last_route_order_at
FROM public.customers c
LEFT JOIN public.route_customer_credit_profiles cp
    ON cp.customer_id = c.id
LEFT JOIN public.locations l
    ON l.id = c.location_id
LEFT JOIN public.regions r
    ON r.id = l.region_id
LEFT JOIN public.orders o
    ON o.customer_id = c.id
WHERE c.customer_type = 'route'
GROUP BY
    c.id,
    c.name,
    c.email,
    c.phone,
    c.location_id,
    l.name,
    r.id,
    r.name,
    cp.credit_limit;

COMMIT;
