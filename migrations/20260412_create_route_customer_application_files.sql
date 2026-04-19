BEGIN;

CREATE TABLE IF NOT EXISTS public.route_customer_application_files (
  id BIGSERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL,
  file_type VARCHAR(30) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  relative_path VARCHAR(500) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  file_size BIGINT NOT NULL CHECK (file_size >= 0),
  uploaded_by_user_id INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_customer_application_files_application_id
  ON public.route_customer_application_files(application_id);

CREATE INDEX IF NOT EXISTS idx_route_customer_application_files_file_type
  ON public.route_customer_application_files(file_type);

CREATE INDEX IF NOT EXISTS idx_route_customer_application_files_uploaded_by_user_id
  ON public.route_customer_application_files(uploaded_by_user_id);

COMMIT;
