"""Detached, low-chatter process runner for Codex development commands.

The supervisor checks only at deterministic intervals (never busy-polls), emits
bounded observability events when a context is available, and tails logs only
after a non-zero exit.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from sdk.python import ObservabilityClient


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a command with interval-based diagnostics")
    parser.add_argument("--label", required=True)
    parser.add_argument("--interval", type=int, default=30, help="seconds between bounded checks")
    parser.add_argument("--log-dir", default="var/logs")
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--project-id", default="")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not args.command or args.command[0] != "--":
        parser.error("command must follow --")
    args.command = args.command[1:]
    if args.interval < 5:
        parser.error("interval must be at least 5 seconds")
    return args


def tail(path: Path, limit: int = 20) -> str:
    if not path.exists():
        return ""
    return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:])[-4000:]


def main() -> int:
    args = parse_args()
    root = Path(args.cwd).resolve()
    log_dir = (root / args.log_dir).resolve()
    log_dir.mkdir(parents=True, exist_ok=True)
    safe_label = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in args.label)
    out_path, err_path = log_dir / f"{safe_label}.stdout.log", log_dir / f"{safe_label}.stderr.log"
    client = None
    if args.project_id:
        client = ObservabilityClient.start(args.project_id, component="codex.interval_supervisor", execution_kind=2)
        client.emit("process.started", message=f"Started {safe_label}", attributes={"label": safe_label, "intervalSeconds": args.interval})
    with out_path.open("w", encoding="utf-8") as out, err_path.open("w", encoding="utf-8") as err:
        proc = subprocess.Popen(args.command, cwd=root, stdout=out, stderr=err, stdin=subprocess.DEVNULL)
        state = {"label": safe_label, "pid": proc.pid, "intervalSeconds": args.interval, "stdout": str(out_path), "stderr": str(err_path), "startedAt": time.time()}
        (log_dir / f"{safe_label}.state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
        while True:
            code = proc.poll()
            if code is not None:
                if code == 0:
                    if client:
                        client.emit("process.completed", outcome=1, message=f"Completed {safe_label}", attributes={"label": safe_label, "exitCode": code})
                        client.finish(result_summary=f"{safe_label} completed")
                    return 0
                detail = tail(err_path)
                if client:
                    client.emit("process.failed", category=4, severity=3, outcome=3, message=f"Failed {safe_label}; inspect stderr log", attributes={"label": safe_label, "exitCode": code, "stderrTail": detail})
                    client.finish(outcome=3, status=4, result_summary=f"{safe_label} failed")
                return code or 1
            if client:
                client.emit("process.checkpoint", message=f"Still running: {safe_label}", attributes={"label": safe_label, "pid": proc.pid, "intervalSeconds": args.interval})
            time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
