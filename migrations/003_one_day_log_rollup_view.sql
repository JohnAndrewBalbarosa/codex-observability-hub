CREATE OR REPLACE VIEW one_day_log_rollups AS
SELECT * FROM daily_rollups;

ALTER TABLE project_schemas
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 2;

INSERT INTO schema_migrations(version) VALUES (3) ON CONFLICT DO NOTHING;
