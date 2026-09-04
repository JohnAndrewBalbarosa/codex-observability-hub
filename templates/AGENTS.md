# Global GitHub Save Policy

Apply this policy to every repository and every user prompt that causes file or codebase changes.

1. Before editing, determine whether the current worktree belongs to a Git repository and inspect its remotes.
2. If the repository already has a GitHub remote (a remote URL hosted on `github.com`), save file-changing work locally before ending the prompt:
   - inspect `git status` and review the agent-made diff;
   - run relevant checks when practical;
   - commit only the changes made for the current prompt with a concise message; and
   - run `obs.cmd git check --threshold 5` and report the code-commit count.
3. If fewer than five code commits are ahead, keep them local. At five, review the complete upstream-to-HEAD range. If every unpushed commit is related, squash multiple commits with the reviewed HEAD and `--confirm-all-local-related`, rerun relevant checks, then normal-push the current branch to its configured upstream.
4. An explicit user request to push now bypasses the threshold, but not diff review, checks, related-commit confirmation, safe local squash, or normal-push protections.
5. Preserve unrelated user changes and commits. Never add, commit, squash, revert, overwrite, or discard them. If they overlap the requested work and cannot be separated safely, stop and ask the user.
6. Never force-push, rewrite published history, or bypass branch protection unless the user explicitly requests and authorizes that exact action. The threshold workflow may rewrite only reviewed, unpushed commits.
7. If the directory is not a Git repository, or the repository has no GitHub remote, do not initialize Git, create a GitHub repository, add a remote, commit, or push merely because of this policy.
8. Create or publish a repository only when the user explicitly asks. Once connected to GitHub, apply this local-commit and threshold-push workflow to later file-changing prompts.
9. Read-only questions, diagnostics, reviews, and explanations that make no file changes require no commit or push. Documentation-only and media-only commits do not increment the code threshold.
10. If commit or push cannot complete because of authentication, permissions, conflicts, checks, or connectivity, preserve the worktree, report the blocker precisely, and do not claim the changes were pushed.

# Engineering Design Principles

## Detached commands and failure-driven diagnostics

Use token-efficient execution for commands that are expected to keep running or produce lengthy
progress output.

1. Run long-lived downloads, compiles, development servers, watchers, and similar non-interactive
   commands detached in the background by default. Redirect stdout and stderr to bounded log files
   and report the process ID, relevant URL when applicable, and log paths.
2. Do not continuously poll, stream, or repeatedly summarize a healthy background command. After
   launch, yield promptly. When the user explicitly needs proof of readiness, use one bounded health
   check instead of ongoing monitoring and state clearly whether readiness was verified.
3. Every detached command must arrange one event-driven local notification when it finishes,
   whether it succeeds or fails, and record the same bounded outcome in its log. Do not suppress,
   replace, or disable Codex lifecycle/observability hooks to reduce polling. Investigate only when
   the command exits unsuccessfully, a bounded readiness check fails, or the user reports a problem.
   Start from the error-log tail, then follow the correlated observability trace when available.
4. Keep short commands, tests, builds whose final result is required, credential prompts,
   confirmations, and other interactive operations in the foreground. Never detach an operation
   when doing so could hide a destructive action or a required human decision.
5. Keep logs bounded and secret-safe. Never write credentials, tokens, cookies, private payloads,
   or unrestricted command output merely to support later diagnosis.
6. For a reusable deterministic supervisor with structured checkpoints, use
   `%USERPROFILE%\.codex\tools\observability-hub\interval-supervisor.cmd --label <name> --interval <seconds> -- <command> <args>`.
   Choose intervals by expected workload (short jobs 15-30s, builds 30-60s, services 60-120s).
   This runner emits bounded checkpoints and completion/failure events and reads stderr only on
   failure. The same utility can be shared by multiple Codex home directories.

## Observability-first development

Design systems so errors, unexpected behavior, important activity, and state changes are immediately visible and easy to investigate. During development, favor highly detailed structured observability.

1. Log errors, successful operations, important non-error activity, state transitions, external calls, retries, fallbacks, validation outcomes, and major decisions.
2. Use structured, machine-readable events with consistent names and fields. Include timestamps, severity, component and operation names, correlation or request IDs, durations, and bounded outcome details when applicable.
3. Make multi-step workflows traceable end to end. Catch errors at meaningful boundaries, add useful context, log them once at the owning layer, and propagate them or return an explicit failure. Never silently swallow failures.
4. When useful, complement logs with metrics, traces, audit events, health checks, and diagnostic views. Test that important failure paths are observable.
5. Prefer verbose configurable diagnostics during development. Production may reduce verbosity, but must retain actionable errors, important transitions, security events, and operational outcomes.
6. Never log passwords, API keys, tokens, cookies, private keys, credentials, unnecessary personal data, or sensitive payloads. Redact or omit sensitive fields by default.
7. Avoid uncontrolled high-volume logging. Use levels, sampling, aggregation, retention limits, and configurable verbosity where needed.
8. Observability should explain what happened, where, when, for which bounded entity, why that path was selected, its result, and what to investigate next. Prefer apparent failures over ambiguous or silent behavior.

## Reuse-first engineering

Do not reinvent established solutions without a concrete reason.

1. Before implementing a substantial capability from scratch, search the web for current, widely adopted frameworks, libraries, platform features, standards, and official reference implementations. Prefer official documentation, official repositories, standards, and maintainer guidance.
2. Evaluate compatibility, maintenance and release activity, adoption, test quality, security history, known vulnerabilities, license, API stability, dependency weight, performance, and operational complexity.
3. Prefer, in order: a standard platform capability, an existing repository utility, an established maintained dependency, a small adapter around that dependency, then custom implementation only when justified.
4. Use dependencies through documented public APIs. Do not copy arbitrary online source code unless its license permits it and vendoring is deliberately justified.
5. Custom code is appropriate when no suitable maintained solution exists, requirements conflict with available solutions, dependency risk is disproportionate, the behavior is simpler than adding a dependency, or security, performance, licensing, or architecture requires ownership.
6. Briefly document substantial dependency choices and verify integrations with focused tests. Do not add overlapping libraries without a documented reason.
7. When a suitable maintained solution exists, integrate or configure it within the current build instead of regenerating equivalent functionality. Minimize newly generated and project-owned code: a smaller custom-code surface is easier to review, test, secure, operate, and maintain.
8. Treat broad real-world adoption and active multi-maintainer use as useful evidence that behavior has been exercised and common defects have been found, but never as proof of safety. Verify provenance, maintenance activity, releases, tests, security advisories, license, compatibility, and the exact version before adoption.

# Central Observability Contract

Use the shared `obs.cmd` CLI for every persistent project repository. Before the first prompt that changes a repository, ensure it contains `observability.project.toml`; if missing, run `obs.cmd project register --init`. A read-only prompt must not create the marker: report its absence and use bounded local diagnostics. Never enroll dependency, cache, generated, vendor, temporary, or throwaway directories.

1. For diagnosis, query `obs.cmd errors`, then `obs.cmd diagnose ERROR_GROUP_ID` and `obs.cmd trace TRACE_ID` before broad log or source searches. Import existing structured JSONL/log output with `obs.cmd runtime ingest --file PATH --match '"event"'` without printing the raw source. Read only the implicated bounded log tail and source files; fall back when correlated data is absent or the hub is unavailable.
2. Installed hooks create project, session, prompt, execution, code-version, attribution, and bounded tool-event identities. Before ending work, enrich the prompt node with a concise Taglish summary (or the user's language), intent, target, constraints, success criteria, and result.
3. Emit structured events for meaningful decisions, transitions, validations, tests, builds, retries, fallbacks, errors, commits, pushes, and runtime outcomes. Registration alone is insufficient: application and deployment error paths must produce bounded, redacted events with component, operation, correlation/trace ID, code version, and useful source locator when available.
4. Diagnose by tracing error → execution → summarized prompt → project context/code version. Record successful, stopped, and failed outcomes; never silently swallow failures.
5. Never send raw prompts, credentials, tokens, cookies, private payloads, unrestricted tool output, DOM, scraped text, or screenshots. Hooks retain only a prompt HMAC until the bounded summary is added.
6. Never create a database table or schema per project. The hub uses normalized shared tables keyed by a stable project UUID.
7. Before the first query, use one bounded hub health check; if unavailable, run the existing `start.ps1` once and flush the spool. If startup still fails, keep using the bounded SQLite WAL spool. Observability must never block requested work.
8. The canonical schema and CLI contract live in the installed observability hub `README.md`; consult it instead of expanding this prompt.
