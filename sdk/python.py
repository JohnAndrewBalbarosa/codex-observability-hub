from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.request
import uuid
from datetime import datetime, timezone

REDACT = re.compile(r"password|passwd|secret|token|api[_-]?key|cookie|authorization|private[_-]?key", re.I)


def _clean(value):
    if isinstance(value, dict):
        return {str(key): "[REDACTED]" if REDACT.search(str(key)) else _clean(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_clean(item) for item in value[:100]]
    return value[:1200] if isinstance(value, str) else value


class ObservabilityClient:
    def __init__(self, project_id: str, execution_id: str, trace_id: str, component: str = "application", strict: bool = False):
        self.project_id, self.execution_id, self.trace_id, self.component, self.strict = project_id, execution_id, trace_id, component, strict
        self.sequence = 0

    @classmethod
    def start(cls, project_id: str, *, component: str = "application", commit_sha: str | None = None, branch_name: str | None = None, dirty_fingerprint: str | None = None, build_version: str | None = None, execution_kind: int = 2, strict: bool = False):
        make_id = lambda: str(uuid.uuid7() if hasattr(uuid,"uuid7") else uuid.uuid4())
        version_key = f"{project_id}|{commit_sha or ''}|{dirty_fingerprint or ''}"
        occurred_at, code_version_id, execution_id, trace_id = datetime.now(timezone.utc).isoformat().replace("+00:00","Z"), str(uuid.uuid5(uuid.NAMESPACE_URL,version_key)), make_id(), os.urandom(16).hex()
        operations = [
            {"operationId":make_id(),"kind":"code-version.register","occurredAt":occurred_at,"data":{"codeVersionId":code_version_id,"projectId":project_id,"commitSha":commit_sha,"branchName":branch_name,"dirtyFingerprint":dirty_fingerprint,"buildVersion":build_version}},
            {"operationId":make_id(),"kind":"execution.start","occurredAt":occurred_at,"data":{"executionId":execution_id,"projectId":project_id,"codeVersionId":code_version_id,"executionKind":execution_kind,"attemptNo":1,"traceId":trace_id}},
        ]
        client = cls(project_id,execution_id,trace_id,component,strict)
        client._send(operations)
        return client

    def _send(self, operations):
        try:
            request = urllib.request.Request(f"{os.environ.get('OBS_ENDPOINT','http://127.0.0.1:4319')}/v1/operations",data=json.dumps({"operations":_clean(operations)}).encode(),headers={"content-type":"application/json"},method="POST")
            with urllib.request.urlopen(request,timeout=2.5) as response:
                if response.status >= 300: raise RuntimeError(f"Observability ingestion failed with HTTP {response.status}")
            return True
        except Exception:
            if self.strict: raise
            return False

    def emit(self, code: str, *, category: int = 1, severity: int = 1, outcome: int | None = None, message: str = "", attributes: dict | None = None):
        self.sequence += 1
        occurred_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        make_id = lambda: str(uuid.uuid7() if hasattr(uuid,"uuid7") else uuid.uuid4())
        operation = {"operationId":make_id(),"kind":"event.emit","occurredAt":occurred_at,"data":{"eventId":make_id(),"executionId":self.execution_id,"projectId":self.project_id,"traceId":self.trace_id,"sequenceNo":self.sequence,"code":code,"category":category,"severity":severity,"outcome":outcome,"component":self.component,"messageSummary":message,"attributes":attributes or {}}}
        return self._send([operation])

    def finish(self, *, outcome: int = 1, status: int = 2, result_summary: str = ""):
        make_id = lambda: str(uuid.uuid7() if hasattr(uuid,"uuid7") else uuid.uuid4())
        return self._send([{"operationId":make_id(),"kind":"execution.finish","occurredAt":datetime.now(timezone.utc).isoformat().replace("+00:00","Z"),"data":{"executionId":self.execution_id,"outcome":outcome,"status":status,"resultSummary":result_summary}}])

    @staticmethod
    def fingerprint(*parts: str) -> str:
        return hashlib.sha256("|".join(parts).encode()).hexdigest()
