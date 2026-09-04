CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  project_id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9._-]{0,119}$'),
  status smallint NOT NULL DEFAULT 1 CHECK (status IN (0,1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_aliases (
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  alias_kind smallint NOT NULL CHECK (alias_kind IN (1,2,3)),
  alias_hash bytea NOT NULL CHECK (octet_length(alias_hash)=32),
  is_current boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, alias_kind, alias_hash)
);

CREATE TABLE IF NOT EXISTS project_context_versions (
  context_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no>0),
  language_code varchar(16) NOT NULL DEFAULT 'tl-en',
  vision_summary text NOT NULL DEFAULT '' CHECK (length(vision_summary)<=2000),
  architecture_summary text NOT NULL DEFAULT '' CHECK (length(architecture_summary)<=2000),
  current_goal_summary text NOT NULL DEFAULT '' CHECK (length(current_goal_summary)<=2000),
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(constraints)='array'),
  source_prompt_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,version_no)
);

CREATE TABLE IF NOT EXISTS agent_instances (
  agent_instance_id uuid PRIMARY KEY,
  instance_key varchar(80) NOT NULL UNIQUE,
  source_kind smallint NOT NULL CHECK (source_kind IN (1,2,3)),
  display_name varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  agent_instance_id uuid NOT NULL REFERENCES agent_instances(agent_instance_id),
  session_kind smallint NOT NULL CHECK (session_kind IN (1,2,3,4)),
  session_fingerprint bytea NOT NULL CHECK (octet_length(session_fingerprint)=32),
  status smallint NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,agent_instance_id,session_fingerprint)
);

CREATE TABLE IF NOT EXISTS prompt_nodes (
  prompt_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  parent_prompt_id uuid REFERENCES prompt_nodes(prompt_id),
  ordinal integer NOT NULL CHECK (ordinal>0),
  prompt_hmac bytea NOT NULL CHECK (octet_length(prompt_hmac)=32),
  language_code varchar(16) NOT NULL DEFAULT 'tl-en',
  summary text NOT NULL DEFAULT '' CHECK (length(summary)<=1200),
  intent text NOT NULL DEFAULT '' CHECK (length(intent)<=1200),
  target_system text NOT NULL DEFAULT '' CHECK (length(target_system)<=400),
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(constraints)='array'),
  success_criteria jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(success_criteria)='array'),
  result_summary text NOT NULL DEFAULT '' CHECK (length(result_summary)<=1200),
  status smallint NOT NULL DEFAULT 1 CHECK (status IN (1,2,3,4)),
  created_at timestamptz NOT NULL,
  enriched_at timestamptz,
  completed_at timestamptz,
  UNIQUE(session_id,ordinal)
);

CREATE TABLE IF NOT EXISTS code_versions (
  code_version_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  commit_sha varchar(64),
  branch_name varchar(240),
  dirty_fingerprint bytea,
  build_version varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,commit_sha,dirty_fingerprint)
);

CREATE TABLE IF NOT EXISTS executions (
  execution_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(session_id) ON DELETE SET NULL,
  prompt_id uuid REFERENCES prompt_nodes(prompt_id) ON DELETE SET NULL,
  parent_execution_id uuid REFERENCES executions(execution_id),
  code_version_id uuid REFERENCES code_versions(code_version_id),
  execution_kind smallint NOT NULL CHECK (execution_kind IN (1,2,3,4,5)),
  attempt_no integer NOT NULL DEFAULT 1 CHECK (attempt_no>0),
  trace_id bytea NOT NULL CHECK (octet_length(trace_id)=16),
  status smallint NOT NULL DEFAULT 1 CHECK (status IN (1,2,3,4)),
  outcome smallint CHECK (outcome IN (1,2,3)),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms>=0),
  result_summary text NOT NULL DEFAULT '' CHECK (length(result_summary)<=1200)
);

CREATE TABLE IF NOT EXISTS change_attributions (
  attribution_id uuid PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  code_version_id uuid REFERENCES code_versions(code_version_id) ON DELETE CASCADE,
  artifact_kind smallint NOT NULL CHECK (artifact_kind IN (1,2,3,4,5)),
  locator_hash bytea NOT NULL CHECK (octet_length(locator_hash)=32),
  locator_label text NOT NULL DEFAULT '' CHECK (length(locator_label)<=500),
  content_hash bytea,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS components (
  component_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  component_kind smallint NOT NULL DEFAULT 1,
  name varchar(160) NOT NULL,
  UNIQUE(project_id,name)
);

CREATE TABLE IF NOT EXISTS event_definitions (
  event_definition_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code varchar(160) NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9._-]{1,159}$'),
  category smallint NOT NULL CHECK (category BETWEEN 1 AND 16),
  default_severity smallint NOT NULL CHECK (default_severity BETWEEN 1 AND 5),
  description varchar(500) NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
  event_id uuid NOT NULL,
  execution_id uuid NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
  component_id bigint REFERENCES components(component_id),
  event_definition_id bigint NOT NULL REFERENCES event_definitions(event_definition_id),
  sequence_no bigint NOT NULL CHECK (sequence_no>=0),
  severity smallint NOT NULL CHECK (severity BETWEEN 1 AND 5),
  outcome smallint CHECK (outcome IN (1,2,3)),
  trace_id bytea NOT NULL CHECK (octet_length(trace_id)=16),
  span_id bytea CHECK (span_id IS NULL OR octet_length(span_id)=8),
  parent_span_id bytea CHECK (parent_span_id IS NULL OR octet_length(parent_span_id)=8),
  message_summary varchar(500) NOT NULL DEFAULT '',
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes)='object'),
  occurred_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(event_id,occurred_at),
  UNIQUE(execution_id,sequence_no,occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS events_default PARTITION OF events DEFAULT;

CREATE TABLE IF NOT EXISTS error_groups (
  error_group_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint)=32),
  exception_class varchar(240) NOT NULL DEFAULT '',
  normalized_summary varchar(500) NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  occurrence_count bigint NOT NULL DEFAULT 1,
  status smallint NOT NULL DEFAULT 1 CHECK (status IN (1,2,3)),
  UNIQUE(project_id,fingerprint)
);

CREATE TABLE IF NOT EXISTS error_occurrences (
  event_id uuid NOT NULL,
  event_occurred_at timestamptz NOT NULL,
  error_group_id uuid NOT NULL REFERENCES error_groups(error_group_id) ON DELETE CASCADE,
  handled boolean NOT NULL,
  retryable boolean NOT NULL,
  stack_hash bytea,
  top_frame varchar(500) NOT NULL DEFAULT '',
  PRIMARY KEY(event_id,event_occurred_at),
  FOREIGN KEY(event_id,event_occurred_at) REFERENCES events(event_id,occurred_at) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_payloads (
  event_id uuid NOT NULL,
  event_occurred_at timestamptz NOT NULL,
  encoding smallint NOT NULL DEFAULT 1,
  redaction_version integer NOT NULL,
  compressed_payload bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(event_id,event_occurred_at),
  FOREIGN KEY(event_id,event_occurred_at) REFERENCES events(event_id,occurred_at) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS daily_rollups (
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  day date NOT NULL,
  event_definition_id bigint NOT NULL REFERENCES event_definitions(event_definition_id),
  severity smallint NOT NULL,
  outcome smallint,
  event_count bigint NOT NULL,
  duration_sum_ms bigint NOT NULL DEFAULT 0,
  duration_max_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id,day,event_definition_id,severity,outcome)
);

CREATE INDEX IF NOT EXISTS sessions_project_time ON sessions(project_id,started_at DESC);
CREATE INDEX IF NOT EXISTS prompts_session_time ON prompt_nodes(session_id,created_at DESC);
CREATE INDEX IF NOT EXISTS executions_prompt_time ON executions(prompt_id,started_at DESC);
CREATE INDEX IF NOT EXISTS executions_project_time ON executions(project_id,started_at DESC);
CREATE INDEX IF NOT EXISTS events_execution_time ON events(execution_id,occurred_at,sequence_no);
CREATE INDEX IF NOT EXISTS events_severity_time ON events(severity,occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_trace ON events(trace_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS error_groups_project_last ON error_groups(project_id,last_seen_at DESC);
CREATE INDEX IF NOT EXISTS error_occurrences_group ON error_occurrences(error_group_id,event_occurred_at DESC);
CREATE INDEX IF NOT EXISTS attributions_code_version ON change_attributions(code_version_id);

INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
