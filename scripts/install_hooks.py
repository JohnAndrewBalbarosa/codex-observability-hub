from __future__ import annotations

import argparse
import json
from pathlib import Path

EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]
STATUS = "Central Observability"


def install(codex_home: Path, tool_root: Path) -> None:
    config_path = codex_home / "hooks.json"
    value = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    hooks = value.setdefault("hooks", {})
    command = str(tool_root / "hook.cmd")

    for event in EVENTS:
        entries = hooks.setdefault(event, [])
        managed = [
            hook
            for entry in entries
            if isinstance(entry, dict)
            for hook in entry.get("hooks", [])
            if isinstance(hook, dict) and hook.get("statusMessage") == STATUS
        ]
        timeout = 10 if event == "SessionEnd" else 15
        if managed:
            for hook in managed:
                hook.update(command=command, commandWindows=command, timeout=timeout)
        else:
            entries.append({"hooks": [{
                "type": "command",
                "command": command,
                "commandWindows": command,
                "timeout": timeout,
                "statusMessage": STATUS,
            }]})

    codex_home.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


parser = argparse.ArgumentParser(description="Install Codex observability lifecycle hooks.")
parser.add_argument("--codex-home", type=Path, required=True)
parser.add_argument("--tool-root", type=Path, required=True)
args = parser.parse_args()
install(args.codex_home.resolve(), args.tool_root.resolve())
