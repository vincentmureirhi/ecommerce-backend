CREATE TABLE IF NOT EXISTS public.terms_conditions (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.terms_conditions (id, content)
VALUES (
  1,
  '## Terms & Conditions

Welcome to XPOSE Distributors. These terms are managed from the admin panel.'
)
ON CONFLICT (id) DO NOTHING;