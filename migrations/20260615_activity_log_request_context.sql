CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER,
  details JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE activity_logs
  ADD COLUMN IF NOT EXISTS request_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ip_address TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT,
  ADD COLUMN IF NOT EXISTS actor_type VARCHAR(50) DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS actor_id INTEGER,
  ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'success',
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

UPDATE activity_logs
SET actor_id = user_id
WHERE actor_id IS NULL
  AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activity_user_id ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_logs(action);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_request_id ON activity_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_logs(actor_type, actor_id);
