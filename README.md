# Codex Observability Hub

A Windows-first, local-only observability stack for **Codex**. It captures Codex
lifecycle events, correlates prompts, tool activity, executions, code versions,
and runtime logs, and keeps a bounded SQLite WAL spool when PostgreSQL is offline.

This package is intentionally scoped to Codex. It has not been tested with other
AI coding agents.

## What is included

- Codex hooks for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, and
  `SessionEnd`
- a loopback Fastify service and PostgreSQL schema/migrations
- a bounded local SQLite WAL fallback and dead-letter handling
- `obs.cmd` commands for registration, events, errors, traces, diagnosis, prompt
  enrichment, runtime ingestion, and spool flushing
- Python and JavaScript structured-logging SDKs
- a reusable detached-command supervisor with bounded progress events
- full and token-lean `AGENTS.md` templates
- a bounded, redacting browser-extension logger example

The database compatibility table is named `daily_rollups`. In user-facing terms,
it is a **one-day log rollup**: it groups one day's logs by event type, severity,
and outcome; it does not necessarily collapse the entire day into one row.

## Requirements

- Codex on Windows
- PowerShell 7 or Windows PowerShell 5.1
- Python 3.11+
- Node.js 20+
- Docker Desktop with Docker Compose

## Install

Clone the repository, review `templates/AGENTS.minimal.md`, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -GlobalInstructions Minimal
```

The setup script generates a random local PostgreSQL credential in ignored
`.env`, installs locked Node dependencies, adds the lifecycle hooks to
`%USERPROFILE%\.codex\hooks.json`, starts the local service, and leaves existing
global instructions untouched unless you explicitly select a template.

If you already have `%USERPROFILE%\.codex\AGENTS.md`, omit
`-GlobalInstructions` and merge the reviewed template manually. To install the
longer policy template, use `-GlobalInstructions Full`. `-ForceInstructions`
backs up an existing file before replacement.

Restart Codex after installing hooks.

## CLI

```powershell
.\obs.cmd project register --init
.\obs.cmd prompt enrich --summary "Short summary" --intent "Goal" --target "Subsystem"
.\obs.cmd event emit --code build.succeeded --outcome 1
.\obs.cmd errors
.\obs.cmd diagnose ERROR_GROUP_ID
.\obs.cmd trace TRACE_ID
.\obs.cmd runtime ingest --file PATH_TO_JSONL --match '"event"'
```

Add this repository directory to `PATH` if you want `obs.cmd` available from any
project.

## Data model and privacy

The identity graph is:

```text
project -> session -> prompt -> execution -> event/error
```

Each registered project gets a stable UUID and filtered PostgreSQL views in a
deterministic `project_<uuid>` schema. Canonical rows remain normalized rather
than duplicated.

Raw capture can include exact prompts, assistant results, tool inputs/outputs,
paths, and application payloads. Treat the local database as sensitive. The
repository excludes all runtime databases, SQLite spools, logs, keys, `.env`
files, dependency folders, and machine-specific configuration. The server and
database ports bind to `127.0.0.1` by default.

See [SECURITY.md](SECURITY.md) before changing network bindings or retention.

## Runtime SDKs

`sdk/python.py` and `sdk/javascript.mjs` send bounded, redacted events without
blocking application work. `examples/browser-extension-logger.js` shows a
500-entry local browser logger with secret-field and bearer-token redaction.

## Verify

```powershell
python -m unittest discover -s tests -v
npm test
Invoke-RestMethod http://127.0.0.1:4319/health
```

## Official Codex references

- [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)

## License

MIT. The optional `codex-cli-notify` integration is a separate third-party
project and is not vendored here.
