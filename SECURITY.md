# Security and privacy

This project is local-first, but it can retain exact Codex prompts, assistant
results, tool payloads, paths, and application events. Treat its PostgreSQL
database, SQLite spool, HMAC key, and log directory as sensitive local data.

The repository intentionally excludes `.env`, `var/`, databases, logs, generated
keys, dependency folders, and machine-specific Codex configuration. Never commit
exports from a running installation.

The HTTP service binds to `127.0.0.1` by default. Do not expose port 4319 or the
PostgreSQL port to another host without adding authentication, transport security,
access controls, and a separate privacy review.

Report vulnerabilities privately through GitHub's security advisory feature.
