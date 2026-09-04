# Codex Observability

For repositories with a configured GitHub upstream, review and test each
code-changing prompt, then commit only that prompt's changes locally. Run
`obs.cmd git check --threshold 5`. Keep fewer than five code commits local. At
the threshold, review every unpushed commit, confirm they are all related, use
`obs.cmd git squash` with its reviewed-HEAD and confirmation safeguards when
there are multiple commits, rerun relevant checks, and normal-push. An explicit
request to push now bypasses only the threshold. Never include unrelated work,
rewrite published history, or force-push without exact user authorization.

Use `obs.cmd` for persistent project repositories. Before the first prompt that
changes a repository, ensure it has `observability.project.toml`; if missing, run
`obs.cmd project register --init`. Do not enroll dependency, cache, generated,
vendor, temporary, or throwaway directories. Read-only work must not create files.

For diagnosis, run `obs.cmd errors`, then `obs.cmd diagnose ERROR_GROUP_ID` and
`obs.cmd trace TRACE_ID` before broad searches. Import structured logs with
`obs.cmd runtime ingest --file PATH --match '"event"'`; do not print raw logs.

Emit bounded, redacted structured events for meaningful decisions, state changes,
external calls, retries, tests, builds, failures, commits, pushes, and runtime
outcomes. Include component, operation, correlation ID, severity, outcome,
duration, code version, and source locator when useful. Never log credentials,
tokens, cookies, private keys, unnecessary personal data, or unrestricted payloads.

Run long-lived commands detached with bounded log files and one local completion
notification. Do not repeatedly poll healthy work; use one bounded readiness check
when proof is required. Keep short, destructive, and interactive commands in the
foreground.

Observability must never block requested work. If the hub is unavailable, start it
once and flush the spool; otherwise continue with the bounded SQLite WAL spool.
