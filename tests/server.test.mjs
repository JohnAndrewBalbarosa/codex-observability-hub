import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("schema contains the complete correlation graph", async () => {
  const sql = await readFile(new URL("../migrations/001_initial.sql",import.meta.url),"utf8");
  const rawSql = await readFile(new URL("../migrations/002_raw_records_and_project_schemas.sql",import.meta.url),"utf8");
  const rollupSql = await readFile(new URL("../migrations/003_one_day_log_rollup_view.sql",import.meta.url),"utf8");
  for (const table of ["projects","sessions","prompt_nodes","executions","events","error_groups","error_occurrences","code_versions","change_attributions"]) {
    assert.match(sql,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(sql,/PARTITION BY RANGE \(occurred_at\)/);
  assert.match(sql,/session_fingerprint bytea/);
  assert.match(sql,/prompt_hmac bytea/);
  assert.match(rawSql,/raw_prompt text/);
  assert.match(rawSql,/raw_result text/);
  assert.match(rawSql,/raw_payload jsonb/);
  assert.match(rawSql,/CREATE TABLE IF NOT EXISTS project_schemas/);
  assert.match(rollupSql,/CREATE OR REPLACE VIEW one_day_log_rollups/);
  assert.match(rollupSql,/schema_version integer/);
});

test("server redacts authorization and raw prompt fields", async () => {
  const source = await readFile(new URL("../src/server.mjs",import.meta.url),"utf8");
  assert.match(source,/req\.headers\.authorization/);
  assert.match(source,/req\.body\.raw_prompt/);
  assert.match(source,/data\.rawPrompt/);
  assert.match(source,/data\.rawResult/);
  assert.match(source,/data\.rawPayload/);
  assert.match(source,/invalid operation batch/);
  assert.match(source,/request\.log\.warn/);
});

test("server creates one normalized project namespace as filtered views", async () => {
  const source = await readFile(new URL("../src/server.mjs",import.meta.url),"utf8");
  assert.match(source,/function projectSchemaName/);
  assert.match(source,/async function ensureProjectSchema/);
  assert.match(source,/CREATE SCHEMA IF NOT EXISTS/);
  assert.match(source,/CREATE OR REPLACE VIEW/);
  assert.match(source,/project_schemas/);
});

test("error diagnosis includes the bounded code version identity", async () => {
  const source = await readFile(new URL("../src/server.mjs",import.meta.url),"utf8");
  assert.match(source,/v\.commit_sha,v\.branch_name/);
  assert.match(source,/code_version_dirty/);
  assert.match(source,/LEFT JOIN code_versions v USING\(code_version_id\)/);
});
