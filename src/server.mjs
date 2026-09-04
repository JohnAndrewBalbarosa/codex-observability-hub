import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import pg from "pg";
import { z } from "zod";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const databaseUrl = process.env.OBS_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("OBS_DATABASE_URL is required. Run scripts/setup.ps1 or provide the environment variable.");
}
const host = process.env.OBS_HOST || "127.0.0.1";
const port = Number(process.env.OBS_PORT || 4319);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
const app = Fastify({ logger: { level: process.env.OBS_LOG_LEVEL || "info", redact: ["req.headers.authorization", "req.body.prompt", "req.body.raw_prompt", "req.body.operations.*.data.rawPrompt", "req.body.operations.*.data.rawResult", "req.body.operations.*.data.rawPayload"] } });

const operationSchema = z.object({
  operationId: z.string().uuid(),
  kind: z.string().min(3).max(80),
  occurredAt: z.string().datetime(),
  data: z.record(z.string(), z.unknown()),
});
const batchSchema = z.object({ operations: z.array(operationSchema).min(1).max(500) });

const bytes = (hex, expected) => {
  if (typeof hex !== "string" || !new RegExp(`^[a-f0-9]{${expected * 2}}$`, "i").test(hex)) throw new Error(`expected ${expected}-byte hex value`);
  return Buffer.from(hex, "hex");
};
const text = (value, max = 1200) => String(value ?? "").slice(0, max);
const jsonArray = (value) => Array.isArray(value) ? value : [];
const jsonObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

async function migrate() {
  for (const migration of ["001_initial.sql", "002_raw_records_and_project_schemas.sql", "003_one_day_log_rollup_view.sql"]) {
    await pool.query(await readFile(join(root, "migrations", migration), "utf8"));
  }
  const existing = await pool.query("SELECT project_id FROM projects ORDER BY project_id");
  for (const row of existing.rows) await ensureProjectSchema(pool, row.project_id);
}

function projectSchemaName(projectId) {
  const value = String(projectId).toLowerCase();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) {
    throw new Error("invalid project id for schema isolation");
  }
  return `project_${value.replaceAll("-", "")}`;
}

async function ensureProjectSchema(client, projectId) {
  const schema = projectSchemaName(projectId);
  const project = `'${String(projectId).toLowerCase()}'::uuid`;
  const expectedSchemaVersion = 3;
  const registered = await client.query("SELECT schema_version FROM project_schemas WHERE project_id=$1", [projectId]);
  if (registered.rows[0]?.schema_version >= expectedSchemaVersion) return schema;
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  const views = {
    project: `SELECT * FROM projects WHERE project_id=${project}`,
    project_aliases: `SELECT * FROM project_aliases WHERE project_id=${project}`,
    project_context_versions: `SELECT * FROM project_context_versions WHERE project_id=${project}`,
    sessions: `SELECT * FROM sessions WHERE project_id=${project}`,
    prompt_nodes: `SELECT p.* FROM prompt_nodes p JOIN sessions s USING(session_id) WHERE s.project_id=${project}`,
    code_versions: `SELECT * FROM code_versions WHERE project_id=${project}`,
    executions: `SELECT * FROM executions WHERE project_id=${project}`,
    change_attributions: `SELECT a.* FROM change_attributions a JOIN executions x USING(execution_id) WHERE x.project_id=${project}`,
    components: `SELECT * FROM components WHERE project_id=${project}`,
    event_definitions: `SELECT DISTINCT d.* FROM event_definitions d JOIN events e USING(event_definition_id) JOIN executions x USING(execution_id) WHERE x.project_id=${project}`,
    events: `SELECT e.* FROM events e JOIN executions x USING(execution_id) WHERE x.project_id=${project}`,
    error_groups: `SELECT * FROM error_groups WHERE project_id=${project}`,
    error_occurrences: `SELECT o.* FROM error_occurrences o JOIN error_groups g USING(error_group_id) WHERE g.project_id=${project}`,
    event_payloads: `SELECT p.* FROM event_payloads p JOIN events e ON e.event_id=p.event_id AND e.occurred_at=p.event_occurred_at JOIN executions x USING(execution_id) WHERE x.project_id=${project}`,
    daily_rollups: `SELECT * FROM daily_rollups WHERE project_id=${project}`,
    one_day_log_rollups: `SELECT * FROM daily_rollups WHERE project_id=${project}`,
  };
  for (const [name, selectSql] of Object.entries(views)) {
    await client.query(`CREATE OR REPLACE VIEW ${schema}.${name} AS ${selectSql}`);
  }
  await client.query(`INSERT INTO project_schemas(project_id,schema_name,schema_version,last_verified_at) VALUES($1,$2,$3,now())
    ON CONFLICT(project_id) DO UPDATE SET schema_name=EXCLUDED.schema_name,schema_version=EXCLUDED.schema_version,last_verified_at=EXCLUDED.last_verified_at`, [projectId, schema, expectedSchemaVersion]);
  return schema;
}

async function maintainStorage() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(732019431)");
    for (let offset = 1; offset <= 3; offset++) {
      const base = new Date();
      const start = new Date(Date.UTC(base.getUTCFullYear(),base.getUTCMonth()+offset,1));
      const end = new Date(Date.UTC(base.getUTCFullYear(),base.getUTCMonth()+offset+1,1));
      const suffix = `${start.getUTCFullYear()}${String(start.getUTCMonth()+1).padStart(2,"0")}`;
      const isoDate = value => value.toISOString().slice(0,10);
      await client.query(`CREATE TABLE IF NOT EXISTS events_${suffix} PARTITION OF events FOR VALUES FROM ('${isoDate(start)}') TO ('${isoDate(end)}')`);
    }
    await client.query(`INSERT INTO daily_rollups(project_id,day,event_definition_id,severity,outcome,event_count)
      SELECT x.project_id,e.occurred_at::date,e.event_definition_id,e.severity,COALESCE(e.outcome,0),count(*)
      FROM events e JOIN executions x USING(execution_id)
      WHERE e.occurred_at >= current_date-interval '2 days' AND e.occurred_at < current_date
      GROUP BY x.project_id,e.occurred_at::date,e.event_definition_id,e.severity,COALESCE(e.outcome,0)
      ON CONFLICT(project_id,day,event_definition_id,severity,outcome) DO UPDATE SET event_count=EXCLUDED.event_count`);
    await client.query("DELETE FROM event_payloads WHERE expires_at < now()");
    await client.query("DELETE FROM events WHERE occurred_at < now()-interval '30 days'");
    await client.query("DELETE FROM daily_rollups WHERE day < current_date-365");
  } finally {
    await client.query("SELECT pg_advisory_unlock(732019431)").catch(() => {});
    client.release();
  }
}

async function applyOperation(client, operation) {
  const d = operation.data;
  switch (operation.kind) {
    case "project.register": {
      await client.query(`INSERT INTO projects(project_id,display_name,slug,last_seen_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(project_id) DO UPDATE SET display_name=EXCLUDED.display_name,slug=EXCLUDED.slug,last_seen_at=EXCLUDED.last_seen_at`,
        [d.projectId, text(d.displayName,160), text(d.slug,120), operation.occurredAt]);
      for (const alias of Array.isArray(d.aliases) ? d.aliases : []) {
        await client.query(`INSERT INTO project_aliases(project_id,alias_kind,alias_hash,last_seen_at) VALUES($1,$2,$3,$4)
          ON CONFLICT(project_id,alias_kind,alias_hash) DO UPDATE SET is_current=true,last_seen_at=EXCLUDED.last_seen_at`,
          [d.projectId, alias.kind, bytes(alias.hash,32), operation.occurredAt]);
      }
      await ensureProjectSchema(client, d.projectId);
      break;
    }
    case "agent.register":
      await client.query(`INSERT INTO agent_instances(agent_instance_id,instance_key,source_kind,display_name,last_seen_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(instance_key) DO UPDATE SET display_name=EXCLUDED.display_name,last_seen_at=EXCLUDED.last_seen_at`,
        [d.agentInstanceId,text(d.instanceKey,80),d.sourceKind || 1,text(d.displayName,160),operation.occurredAt]);
      break;
    case "session.start":
      await client.query(`INSERT INTO sessions(session_id,project_id,agent_instance_id,session_kind,session_fingerprint,status,started_at)
        VALUES($1,$2,$3,$4,$5,1,$6) ON CONFLICT(project_id,agent_instance_id,session_fingerprint) DO UPDATE SET status=1,ended_at=NULL`,
        [d.sessionId,d.projectId,d.agentInstanceId,d.sessionKind || 1,bytes(d.sessionFingerprint,32),operation.occurredAt]);
      break;
    case "session.end":
      await client.query("UPDATE sessions SET status=2,ended_at=$2 WHERE session_id=$1",[d.sessionId,operation.occurredAt]);
      break;
    case "prompt.begin":
      await client.query(`INSERT INTO prompt_nodes(prompt_id,session_id,parent_prompt_id,ordinal,prompt_hmac,raw_prompt,language_code,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(prompt_id) DO UPDATE SET raw_prompt=EXCLUDED.raw_prompt`,
        [d.promptId,d.sessionId,d.parentPromptId || null,d.ordinal,bytes(d.promptHmac,32),String(d.rawPrompt ?? ""),text(d.languageCode || "tl-en",16),operation.occurredAt]);
      break;
    case "prompt.enrich":
      await client.query(`UPDATE prompt_nodes SET summary=$2,intent=$3,target_system=$4,constraints=$5,success_criteria=$6,result_summary=$7,
        language_code=$8,enriched_at=$9 WHERE prompt_id=$1`,[d.promptId,text(d.summary),text(d.intent),text(d.targetSystem,400),JSON.stringify(jsonArray(d.constraints)),JSON.stringify(jsonArray(d.successCriteria)),text(d.resultSummary),text(d.languageCode || "tl-en",16),operation.occurredAt]);
      break;
    case "prompt.finish":
      await client.query("UPDATE prompt_nodes SET status=$2,result_summary=CASE WHEN $3='' THEN result_summary ELSE $3 END,raw_result=$4,completed_at=$5 WHERE prompt_id=$1",
        [d.promptId,d.status || 2,text(d.resultSummary),String(d.rawResult ?? ""),operation.occurredAt]);
      break;
    case "execution.start":
      await client.query(`INSERT INTO executions(execution_id,project_id,session_id,prompt_id,parent_execution_id,execution_kind,attempt_no,trace_id,status,started_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9) ON CONFLICT(execution_id) DO NOTHING`,
        [d.executionId,d.projectId,d.sessionId || null,d.promptId || null,d.parentExecutionId || null,d.executionKind || 1,d.attemptNo || 1,bytes(d.traceId,16),operation.occurredAt]);
      if (d.codeVersionId) await client.query("UPDATE executions SET code_version_id=$2 WHERE execution_id=$1",[d.executionId,d.codeVersionId]);
      break;
    case "execution.finish":
      await client.query(`UPDATE executions SET status=$2,outcome=$3,ended_at=$4,duration_ms=GREATEST(0,EXTRACT(EPOCH FROM ($4::timestamptz-started_at))*1000)::bigint,result_summary=$5 WHERE execution_id=$1`,
        [d.executionId,d.status || 2,d.outcome || 1,operation.occurredAt,text(d.resultSummary)]);
      break;
    case "execution.code-version":
      await client.query("UPDATE executions SET code_version_id=$2 WHERE execution_id=$1",[d.executionId,d.codeVersionId]);
      break;
    case "event.emit": {
      const definition = await client.query(`INSERT INTO event_definitions(code,category,default_severity,description) VALUES($1,$2,$3,$4)
        ON CONFLICT(code) DO UPDATE SET code=EXCLUDED.code RETURNING event_definition_id`,[text(d.code,160),d.category || 1,d.severity || 1,text(d.description,500)]);
      let componentId = null;
      if (d.component) {
        const component = await client.query(`INSERT INTO components(project_id,name,component_kind) VALUES($1,$2,$3)
          ON CONFLICT(project_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING component_id`,[d.projectId,text(d.component,160),d.componentKind || 1]);
        componentId = component.rows[0].component_id;
      }
      await client.query(`INSERT INTO events(event_id,execution_id,component_id,event_definition_id,sequence_no,severity,outcome,trace_id,span_id,parent_span_id,message_summary,attributes,raw_payload,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(event_id,occurred_at) DO NOTHING`,
        [d.eventId,d.executionId,componentId,definition.rows[0].event_definition_id,d.sequenceNo || 0,d.severity || 1,d.outcome || null,bytes(d.traceId,16),d.spanId ? bytes(d.spanId,8) : null,d.parentSpanId ? bytes(d.parentSpanId,8) : null,text(d.messageSummary,500),JSON.stringify(jsonObject(d.attributes)),JSON.stringify(d.rawPayload ?? {}),operation.occurredAt]);
      break;
    }
    case "context.record": {
      const version = await client.query("SELECT COALESCE(max(version_no),0)+1 version FROM project_context_versions WHERE project_id=$1",[d.projectId]);
      await client.query(`INSERT INTO project_context_versions(context_id,project_id,version_no,language_code,vision_summary,architecture_summary,current_goal_summary,constraints,source_prompt_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(context_id) DO NOTHING`,[d.contextId,d.projectId,version.rows[0].version,text(d.languageCode || "tl-en",16),text(d.visionSummary,2000),text(d.architectureSummary,2000),text(d.currentGoalSummary,2000),JSON.stringify(jsonArray(d.constraints)),d.sourcePromptId || null]);
      break;
    }
    case "code-version.register":
      await client.query(`INSERT INTO code_versions(code_version_id,project_id,commit_sha,branch_name,dirty_fingerprint,build_version)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(code_version_id) DO UPDATE SET branch_name=EXCLUDED.branch_name,build_version=COALESCE(EXCLUDED.build_version,code_versions.build_version)`,[d.codeVersionId,d.projectId,d.commitSha || null,text(d.branchName,240) || null,d.dirtyFingerprint ? bytes(d.dirtyFingerprint,32) : null,text(d.buildVersion,120) || null]);
      break;
    case "attribution.record":
      await client.query(`INSERT INTO change_attributions(attribution_id,execution_id,code_version_id,artifact_kind,locator_hash,locator_label,content_hash,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(attribution_id) DO NOTHING`,[d.attributionId,d.executionId,d.codeVersionId || null,d.artifactKind || 1,bytes(d.locatorHash,32),text(d.locatorLabel,500),d.contentHash ? bytes(d.contentHash,32) : null,JSON.stringify(jsonObject(d.metadata))]);
      break;
    case "error.record": {
      const existing = await client.query(`SELECT error_group_id FROM error_groups WHERE project_id=$1 AND fingerprint=$2`,[d.projectId,bytes(d.fingerprint,32)]);
      let groupId = existing.rows[0]?.error_group_id || d.errorGroupId;
      if (existing.rowCount) {
        await client.query("UPDATE error_groups SET last_seen_at=$2,occurrence_count=occurrence_count+1 WHERE error_group_id=$1",[groupId,operation.occurredAt]);
      } else {
        await client.query(`INSERT INTO error_groups(error_group_id,project_id,fingerprint,exception_class,normalized_summary,first_seen_at,last_seen_at)
          VALUES($1,$2,$3,$4,$5,$6,$6)`,[groupId,d.projectId,bytes(d.fingerprint,32),text(d.exceptionClass,240),text(d.normalizedSummary,500),operation.occurredAt]);
      }
      await client.query(`INSERT INTO error_occurrences(event_id,event_occurred_at,error_group_id,handled,retryable,stack_hash,top_frame)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_id,event_occurred_at) DO NOTHING`,
        [d.eventId,d.eventOccurredAt,groupId,Boolean(d.handled),Boolean(d.retryable),d.stackHash ? bytes(d.stackHash,32) : null,text(d.topFrame,500)]);
      break;
    }
    default: throw new Error(`unsupported operation kind: ${operation.kind}`);
  }
}

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok", schemaVersion: 1 };
});

app.post("/v1/operations", async (request, reply) => {
  const parsed = batchSchema.safeParse(request.body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => ({ path: i.path, code: i.code }));
    request.log.warn({ issues }, "invalid operation batch");
    return reply.code(400).send({ error: "invalid operation batch", issues });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const operation of parsed.data.operations) await applyOperation(client, operation);
    await client.query("COMMIT");
    return { accepted: parsed.data.operations.length };
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ err: error, operationKinds: parsed.data.operations.map(o => o.kind) }, "operation batch failed");
    return reply.code(400).send({ error: text(error?.message || "operation failed",300) });
  } finally { client.release(); }
});

app.get("/v1/projects/:projectId/errors", async request => {
  const result = await pool.query(`SELECT encode(g.fingerprint,'hex') fingerprint,g.error_group_id,g.exception_class,g.normalized_summary,g.first_seen_at,g.last_seen_at,g.occurrence_count,g.status
    FROM error_groups g WHERE g.project_id=$1 ORDER BY g.last_seen_at DESC LIMIT 200`,[request.params.projectId]);
  return { items: result.rows };
});

app.get("/v1/errors/:errorGroupId", async (request,reply) => {
  const group = await pool.query(`SELECT g.*,encode(g.fingerprint,'hex') fingerprint,p.display_name project_name
    FROM error_groups g JOIN projects p USING(project_id) WHERE error_group_id=$1`,[request.params.errorGroupId]);
  if (!group.rowCount) return reply.code(404).send({ error: "error group not found" });
  const occurrences = await pool.query(`SELECT o.event_id,o.event_occurred_at,o.handled,o.retryable,o.top_frame,e.message_summary,e.attributes,e.raw_payload,
      x.execution_id,encode(x.trace_id,'hex') trace_id,x.code_version_id,v.commit_sha,v.branch_name,
      (v.dirty_fingerprint IS NOT NULL) code_version_dirty,p.prompt_id,p.summary prompt_summary,p.intent prompt_intent,p.target_system
    FROM error_occurrences o JOIN events e ON e.event_id=o.event_id AND e.occurred_at=o.event_occurred_at
    JOIN executions x USING(execution_id) LEFT JOIN code_versions v USING(code_version_id) LEFT JOIN prompt_nodes p USING(prompt_id)
    WHERE o.error_group_id=$1 ORDER BY o.event_occurred_at DESC LIMIT 200`,[request.params.errorGroupId]);
  return { errorGroup: group.rows[0], occurrences: occurrences.rows };
});

app.get("/v1/prompts/:promptId", async (request,reply) => {
  const result = await pool.query(`SELECT p.*,s.project_id,pr.display_name project_name FROM prompt_nodes p JOIN sessions s USING(session_id) JOIN projects pr USING(project_id) WHERE prompt_id=$1`,[request.params.promptId]);
  if (!result.rowCount) return reply.code(404).send({ error: "prompt not found" });
  const executions = await pool.query("SELECT execution_id,status,outcome,started_at,ended_at,result_summary,encode(trace_id,'hex') trace_id FROM executions WHERE prompt_id=$1 ORDER BY started_at",[request.params.promptId]);
  return { prompt: result.rows[0], executions: executions.rows };
});

app.get("/v1/traces/:traceId", async request => {
  const result = await pool.query(`SELECT e.event_id,e.occurred_at,e.sequence_no,e.severity,e.outcome,d.code,e.message_summary,e.attributes,e.raw_payload,x.execution_id,x.prompt_id
    FROM events e JOIN event_definitions d USING(event_definition_id) JOIN executions x USING(execution_id)
    WHERE e.trace_id=$1 ORDER BY e.occurred_at,e.sequence_no`,[bytes(request.params.traceId,16)]);
  return { items: result.rows };
});

await migrate();
await maintainStorage();
setInterval(() => maintainStorage().catch(error => app.log.error({ err: error }, "storage maintenance failed")), 86_400_000).unref();
await app.listen({ host, port });

for (const signal of ["SIGINT","SIGTERM"]) process.on(signal, async () => { await app.close(); await pool.end(); process.exit(0); });
