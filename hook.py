from __future__ import annotations

import json
import os
import sys
from pathlib import Path

obs = None

def payload() -> dict:
    try:
        value = json.load(sys.stdin)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def has_project_config(start: Path) -> bool:
    current = start.resolve()
    return any((directory / "observability.project.toml").is_file() for directory in (current, *current.parents))


def load_obs():
    global obs
    if obs is None:
        import obs as obs_module
        obs = obs_module
    return obs


def behavior_audit_enabled() -> bool:
    return os.environ.get("CODEX_OBS_BEHAVIOR_AUDIT", "on").strip().lower() not in {
        "0", "false", "off", "no",
    }


def wait_threshold() -> int:
    try:
        return max(0, min(100, int(os.environ.get("CODEX_OBS_WAIT_THRESHOLD", "1"))))
    except ValueError:
        return 1


def tool_observation(value: dict) -> tuple[str, bool, bool]:
    """Classify behavior without retaining tool input or response content."""
    tool = str(value.get("tool_name") or value.get("toolName") or "unknown")[:120]
    normalized = tool.lower().replace("-", "_")
    wait_like = normalized.endswith(".wait") or normalized.endswith(".wait_agent") or normalized.endswith(".write_stdin") or normalized in {
        "wait", "wait_agent", "write_stdin",
    }
    response = value.get("tool_response") or value.get("toolResponse") or ""
    response_text = str(response).lower()
    background_started = (
        "script running with cell id" in response_text
        or ("session_id" in response_text and "exit_code" not in response_text)
    )
    return tool, wait_like, background_started


def exact_result(value: dict) -> str:
    result = value.get("last_assistant_message")
    if result is None:
        result = value.get("lastAssistantMessage")
    if result is None:
        result = value.get("assistant_message")
    if result is None:
        result = value.get("result")
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


def instruction_load_state(instance_key: str, cwd_path: Path) -> dict:
    configured_home = os.environ.get("CODEX_OBS_HOME")
    codex_home = Path(configured_home).resolve() if configured_home else (Path.home() / ".codex").resolve()
    global_prompt = codex_home / "AGENTS.md"
    project_prompt = cwd_path / "AGENTS.md"

    def inspect(path: Path) -> dict:
        try:
            content = path.read_bytes()
            return {"path":str(path),"found":True,"sha256":__import__("hashlib").sha256(content).hexdigest()}
        except OSError:
            return {"path":str(path),"found":False,"sha256":None}

    global_state = inspect(global_prompt)
    project_state = inspect(project_prompt)
    return {
        "instance":instance_key,
        "codexHome":str(codex_home),
        "globalPrompt":global_state,
        "projectPrompt":project_state,
        "loaded":bool(global_state["found"]),
        "acknowledgementRequired":True,
        "verification":"filesystem_and_hook",
    }


def main() -> int:
    value = payload()
    event = str(value.get("hook_event_name") or value.get("hookEventName") or "")
    native_session = str(value.get("session_id") or value.get("sessionId") or "unknown")[:240]
    cwd_path = Path(value.get("cwd") or os.getcwd()).resolve()
    cwd = str(cwd_path)
    if not has_project_config(cwd_path):
        if event == "Stop":
            print('{"continue":true}')
        return 0

    # Import the heavier SQLite/HTTP client only for an instrumented project.
    # Most hooks can now acknowledge immediately without paying cold-start cost.
    obs_client = load_obs()

    found = obs_client.project_config(Path(cwd))
    if not found:
        return 0
    project = obs.register_project(*found)
    instance_key = os.environ.get("CODEX_OBS_INSTANCE", "personal")
    agent_id = str(obs.uuid.uuid5(obs.uuid.NAMESPACE_URL, f"codex-observability:{instance_key}"))
    conn = obs.db()
    row = conn.execute("SELECT * FROM context WHERE native_session=?",(native_session,)).fetchone()
    operations = [obs.operation("agent.register", {"agentInstanceId":agent_id,"instanceKey":instance_key,"sourceKind":1,"displayName":f"Codex {instance_key}"})]
    if not row:
        session_id = obs.uuid7()
        operations.append(obs.operation("session.start", {"sessionId":session_id,"projectId":project["id"],"agentInstanceId":agent_id,"sessionKind":1,"sessionFingerprint":obs.digest(f"{instance_key}|{native_session}",keyed=True)}))
        with conn:
            conn.execute("INSERT OR REPLACE INTO context(native_session,project_id,session_id,cwd,updated_at) VALUES(?,?,?,?,?)",(native_session,project["id"],session_id,cwd,obs.now()))
        row = conn.execute("SELECT * FROM context WHERE native_session=?",(native_session,)).fetchone()
    elif event == "SessionStart":
        operations.append(obs.operation("session.start", {"sessionId":row["session_id"],"projectId":project["id"],"agentInstanceId":agent_id,"sessionKind":1,"sessionFingerprint":obs.digest(f"{instance_key}|{native_session}",keyed=True)}))
        with conn:
            conn.execute("UPDATE context SET cwd=?,updated_at=? WHERE native_session=?",(cwd,obs.now(),native_session))
    if event == "UserPromptSubmit":
        native_turn = str(value.get("turn_id") or value.get("turnId") or "")[:240]
        if native_turn and row["native_turn"] == native_turn and row["execution_id"]:
            obs.enqueue(operations)
            conn.close()
            return 0
        ordinal = int(row["prompt_ordinal"]) + 1
        prompt_id, execution_id = obs.uuid7(), obs.uuid7()
        trace_id = os.urandom(16).hex()
        audit_enabled = behavior_audit_enabled()
        threshold = wait_threshold()
        instruction_state = instruction_load_state(instance_key, cwd_path)
        raw = str(value.get("prompt") or value.get("user_prompt") or value.get("userPrompt") or "")
        if row["execution_id"] and row["prompt_id"]:
            operations.extend([
                obs.operation("event.emit", {"eventId":obs.uuid7(),"executionId":row["execution_id"],"projectId":project["id"],"traceId":row["trace_id"],"sequenceNo":int(row["sequence_no"])+1,"code":"agent.prompt.stop_missing","category":1,"severity":2,"outcome":3,"component":"codex","messageSummary":"Previous prompt was superseded without a Stop hook.","attributes":{}}),
                obs.operation("execution.finish", {"executionId":row["execution_id"],"status":4,"outcome":3,"resultSummary":"Superseded by the next prompt; Stop hook was not observed."}),
                obs.operation("prompt.finish", {"promptId":row["prompt_id"],"status":4,"resultSummary":"Superseded by the next prompt; Stop hook was not observed."}),
            ])
        operations.extend([
            obs.operation("prompt.begin", {"promptId":prompt_id,"sessionId":row["session_id"],"parentPromptId":row["last_prompt_id"],"ordinal":ordinal,"promptHmac":obs.digest(raw,keyed=True),"rawPrompt":raw,"languageCode":"tl-en"}),
            obs.operation("execution.start", {"executionId":execution_id,"projectId":project["id"],"sessionId":row["session_id"],"promptId":prompt_id,"executionKind":1,"attemptNo":1,"traceId":trace_id}),
            obs.operation("event.emit", {"eventId":obs.uuid7(),"executionId":execution_id,"projectId":project["id"],"traceId":trace_id,"sequenceNo":1,"code":"agent.behavior.audit_state","category":1,"severity":1,"outcome":1,"component":"codex","messageSummary":f"Behavior audit {'enabled' if audit_enabled else 'disabled'}.","attributes":{"enabled":audit_enabled,"waitThreshold":threshold,"backgroundDetectionEnabled":audit_enabled}}),
            obs.operation("event.emit", {"eventId":obs.uuid7(),"executionId":execution_id,"projectId":project["id"],"traceId":trace_id,"sequenceNo":2,"code":"agent.instructions.load_state","category":1,"severity":1 if instruction_state["loaded"] else 4,"outcome":1 if instruction_state["loaded"] else 3,"component":"codex","messageSummary":f"Global instruction source {'loaded' if instruction_state['loaded'] else 'missing'} for {instance_key}.","attributes":instruction_state,"rawPayload":instruction_state}),
        ])
        with conn:
            conn.execute("UPDATE context SET prompt_id=?,execution_id=?,trace_id=?,last_prompt_id=?,native_turn=?,prompt_ordinal=?,sequence_no=2,wait_count=0,background_count=0,behavior_audit_enabled=?,cwd=?,updated_at=? WHERE native_session=?",(prompt_id,execution_id,trace_id,prompt_id,native_turn or None,ordinal,int(audit_enabled),cwd,obs.now(),native_session))
    elif event == "PostToolUse" and row["execution_id"]:
        seq = int(row["sequence_no"]) + 1
        tool, wait_like, background_started = tool_observation(value)
        operations.append(obs.operation("event.emit", {"eventId":obs.uuid7(),"executionId":row["execution_id"],"projectId":project["id"],"traceId":row["trace_id"],"sequenceNo":seq,"code":"agent.tool.completed","category":3,"severity":1,"outcome":1,"component":"codex","messageSummary":f"Tool completed: {tool}","attributes":{"tool":tool},"rawPayload":{"toolInput":value.get("tool_input") or value.get("toolInput"),"toolResponse":value.get("tool_response") or value.get("toolResponse")}}))
        wait_count = int(row["wait_count"])
        background_count = int(row["background_count"])
        audit_enabled = bool(row["behavior_audit_enabled"])
        if audit_enabled and background_started:
            background_count += 1
            seq += 1
            operations.append(obs.operation("event.emit", {"eventId":obs.uuid7(),"executionId":row["execution_id"],"projectId":project["id"],"traceId":row["trace_id"],"sequenceNo":seq,"code":"agent.behavior.background_started","category":3,"severity":1,"outcome":1,"component":"codex","messageSummary":"A tool transitioned to background execution.","attributes":{"tool":tool,"backgroundCount":background_count,"auditEnabled":True}}))
        if audit_enabled and wait_like:
            wait_count += 1
            threshold = wait_threshold()
            exceeded = wait_count > threshold
            seq += 1
            observed_at = obs.now()
            event_id = obs.uuid7()
            code = "agent.behavior.polling_threshold_exceeded" if exceeded else "agent.behavior.wait_observed"
            summary = "Repeated wait calls exceeded the configured per-prompt threshold." if exceeded else "A bounded wait call was observed."
            operations.append(obs.operation("event.emit", {"eventId":event_id,"executionId":row["execution_id"],"projectId":project["id"],"traceId":row["trace_id"],"sequenceNo":seq,"code":code,"category":3,"severity":3 if exceeded else 1,"outcome":3 if exceeded else 1,"component":"codex","messageSummary":summary,"attributes":{"tool":tool,"waitCount":wait_count,"waitThreshold":threshold,"auditEnabled":True}}, observed_at))
            if exceeded:
                fingerprint = obs.digest(f"{project['id']}|agent.behavior.polling_threshold_exceeded")
                operations.append(obs.operation("error.record", {"errorGroupId":str(obs.uuid.uuid5(obs.uuid.NAMESPACE_URL, fingerprint)),"projectId":project["id"],"fingerprint":fingerprint,"exceptionClass":"BehaviorPolicyViolation","normalizedSummary":"Repeated wait calls exceeded the configured per-prompt threshold.","eventId":event_id,"eventOccurredAt":observed_at,"handled":False,"retryable":False,"topFrame":"hook.py:PostToolUse"}, observed_at))
        with conn:
            conn.execute("UPDATE context SET sequence_no=?,wait_count=?,background_count=?,updated_at=? WHERE native_session=?",(seq,wait_count,background_count,obs.now(),native_session))
    elif event == "Stop" and row["execution_id"]:
        root = found[0].parent
        commit = obs.git_value(root,"rev-parse","HEAD")
        branch = obs.git_value(root,"branch","--show-current")
        dirty_hash = obs.worktree_fingerprint(root)
        version_key = f"{project['id']}|{commit}|{dirty_hash or ''}"
        code_version_id = str(obs.uuid.uuid5(obs.uuid.NAMESPACE_URL,version_key))
        version_label = commit or "unversioned"
        if dirty_hash:
            version_label = f"{version_label}+dirty:{dirty_hash[:12]}"
        operations.extend([
            obs.operation("code-version.register", {"codeVersionId":code_version_id,"projectId":project["id"],"commitSha":commit or None,"branchName":branch or None,"dirtyFingerprint":dirty_hash}),
            obs.operation("execution.code-version", {"executionId":row["execution_id"],"codeVersionId":code_version_id}),
            obs.operation("attribution.record", {"attributionId":obs.uuid7(),"executionId":row["execution_id"],"codeVersionId":code_version_id,"artifactKind":2,"locatorHash":obs.digest(version_label),"locatorLabel":version_label,"contentHash":dirty_hash,"metadata":{"branch":branch,"dirty":bool(dirty_hash)}}),
            obs.operation("execution.finish", {"executionId":row["execution_id"],"status":2,"outcome":1,"resultSummary":"Agent turn completed."}),
            obs.operation("prompt.finish", {"promptId":row["prompt_id"],"status":2,"resultSummary":"Agent turn completed.","rawResult":exact_result(value)}),
        ])
        with conn:
            conn.execute("UPDATE context SET prompt_id=NULL,execution_id=NULL,trace_id=NULL,native_turn=NULL,sequence_no=0,updated_at=? WHERE native_session=?",(obs.now(),native_session))
    elif event == "SessionEnd":
        operations.append(obs.operation("session.end", {"sessionId":row["session_id"]}))
    obs.enqueue(operations)
    conn.close()
    if event == "Stop": print('{"continue":true}')
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        # Observability must never block Codex. Failure details stay in the bounded spool path.
        print('{"continue":true}')
        raise SystemExit(0)
