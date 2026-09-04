ALTER TABLE prompt_nodes
  ADD COLUMN IF NOT EXISTS raw_prompt text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS raw_result text NOT NULL DEFAULT '';

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS project_schemas (
  project_id uuid PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  schema_name varchar(64) NOT NULL UNIQUE CHECK (schema_name ~ '^project_[a-f0-9]{32}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
