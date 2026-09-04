import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("obs", Path(__file__).parents[1] / "obs.py")
obs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(obs)


class ObservabilityCliTests(unittest.TestCase):
    def test_redacts_secret_fields_recursively(self):
        value = obs.redact({"token": "secret", "nested": {"apiKey": "secret", "safe": "authorization=private Bearer hidden"}})
        self.assertEqual(value["token"], "[REDACTED]")
        self.assertEqual(value["nested"]["apiKey"], "[REDACTED]")
        self.assertEqual(value["nested"]["safe"], "authorization=[REDACTED] Bearer [REDACTED]")

    def test_lossless_fields_bypass_transform_only_for_direct_records(self):
        prompt = obs.operation("prompt.begin", {"rawPrompt":"token=exact-value","safe":"token=hidden"})
        self.assertEqual(prompt["data"]["rawPrompt"], "token=exact-value")
        self.assertEqual(prompt["data"]["safe"], "token=[REDACTED]")
        event = obs.operation("event.emit", {"rawPayload":{"token":"exact-value"}})
        self.assertEqual(event["data"]["rawPayload"], {"token":"exact-value"})

    def test_uuid7_is_uuid(self):
        import uuid
        self.assertEqual(uuid.UUID(obs.uuid7()).version, 7)

    def test_extracts_structured_event_without_returning_log_prefix(self):
        event = obs.structured_event_from_line(
            '09-03 18:02:01 I/flutter: {"event":"flutter.platform.error","severity":"error"} trailing'
        )
        self.assertEqual(event["event"], "flutter.platform.error")
        self.assertEqual(event["severity"], "error")

    def test_extracts_only_a_bounded_source_locator(self):
        event = {
            "diagnostics": "widget details\nRow:file:///workspace/lib/main.dart:52:3\nmore details",
            "stack": "private stack content",
        }
        self.assertEqual(obs.source_locator(event), "Row:file:///workspace/lib/main.dart:52:3")

    def test_maps_runtime_severity_and_outcome(self):
        self.assertEqual(obs.severity_number("error"), 4)
        self.assertEqual(obs.outcome_number("failed"), 3)
        self.assertIsNone(obs.outcome_number("unknown"))

    def test_normalizes_offset_timestamp_to_utc(self):
        self.assertEqual(obs.observed_time("2026-09-03T00:00:00+08:00"), "2026-09-02T16:00:00Z")

    def test_uses_redacted_nested_runtime_message_and_bounded_details(self):
        event = {
            "event": "phone.deployment.completed",
            "details": {
                "message": "authorization=private-value build failed",
                "serial": "device-1",
                "nested": {"unbounded": "payload"},
            },
        }
        self.assertEqual(obs.runtime_summary(event), "authorization=[REDACTED] build failed")
        self.assertEqual(
            obs.bounded_runtime_details(event),
            {"message": "authorization=[REDACTED] build failed", "serial": "device-1"},
        )

    def test_hmac_differs_from_plain_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            old_var, old_key = obs.VAR, obs.KEY
            obs.VAR, obs.KEY = Path(directory), Path(directory) / "hmac.key"
            try:
                self.assertNotEqual(obs.digest("prompt", keyed=True), obs.digest("prompt"))
                self.assertEqual(len(obs.digest("prompt", keyed=True)), 64)
            finally:
                obs.VAR, obs.KEY = old_var, old_key

    def test_context_is_scoped_to_the_current_project(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, second = root / "first", root / "second"
            first.mkdir(); second.mkdir()
            first.joinpath("observability.project.toml").write_text('[project]\nid="00000000-0000-7000-8000-000000000001"\nname="First"\nslug="first"\nschema_version=1\n', encoding="utf-8")
            second.joinpath("observability.project.toml").write_text('[project]\nid="00000000-0000-7000-8000-000000000002"\nname="Second"\nslug="second"\nschema_version=1\n', encoding="utf-8")
            old_var, old_queue = obs.VAR, obs.QUEUE
            obs.VAR, obs.QUEUE = root / "var", root / "var" / "spool.sqlite3"
            try:
                conn = obs.db()
                with conn:
                    conn.execute("INSERT INTO context(native_session,project_id,session_id,prompt_id,execution_id,cwd,updated_at) VALUES(?,?,?,?,?,?,?)",("one","00000000-0000-7000-8000-000000000001","s1","p1","e1",str(first),"2026-01-01T00:00:00Z"))
                    conn.execute("INSERT INTO context(native_session,project_id,session_id,cwd,updated_at) VALUES(?,?,?,?,?)",("one-ended","00000000-0000-7000-8000-000000000001","s-ended",str(first),"2026-01-03T00:00:00Z"))
                    conn.execute("INSERT INTO context(native_session,project_id,session_id,cwd,updated_at) VALUES(?,?,?,?,?)",("two","00000000-0000-7000-8000-000000000002","s2",str(second),"2026-01-02T00:00:00Z"))
                conn.close()
                self.assertEqual(obs.context_for(str(first / "nested"))["native_session"], "one")
            finally:
                obs.VAR, obs.QUEUE = old_var, old_queue

    def test_outage_spools_and_replays_operations(self):
        with tempfile.TemporaryDirectory() as directory:
            old_var, old_queue = obs.VAR, obs.QUEUE
            obs.VAR, obs.QUEUE = Path(directory), Path(directory) / "spool.sqlite3"
            operation = obs.operation("test.fixture", {"bounded":"value"})
            try:
                with patch.object(obs, "post", side_effect=OSError("offline")):
                    obs.enqueue([operation])
                conn = obs.db()
                try:
                    queued = conn.execute("SELECT attempts,last_error FROM queue WHERE operation_id=?", (operation["operationId"],)).fetchone()
                    self.assertEqual(queued["attempts"], 1)
                    self.assertIn("offline", queued["last_error"])
                finally:
                    conn.close()
                delivered = []
                with patch.object(obs, "post", side_effect=lambda operations: delivered.extend(operations)):
                    self.assertEqual(obs.flush(), 1)
                self.assertEqual(delivered[0]["operationId"], operation["operationId"])
                conn = obs.db()
                try:
                    self.assertEqual(conn.execute("SELECT count(*) FROM queue").fetchone()[0], 0)
                finally:
                    conn.close()
            finally:
                obs.VAR, obs.QUEUE = old_var, old_queue

    def test_permanent_bad_operation_isolated_without_blocking_later_events(self):
        with tempfile.TemporaryDirectory() as directory:
            old_var, old_queue = obs.VAR, obs.QUEUE
            obs.VAR, obs.QUEUE = Path(directory), Path(directory) / "spool.sqlite3"
            bad = obs.operation("bad.fixture", {"bounded":"bad"})
            good = obs.operation("good.fixture", {"bounded":"good"})

            def deliver(operations):
                if any(item["kind"] == "bad.fixture" for item in operations):
                    raise obs.HubDeliveryError(400, "permanent fixture failure")

            try:
                conn = obs.db()
                with conn:
                    for operation in (bad, good):
                        conn.execute(
                            "INSERT INTO queue(operation_id,payload,created_at) VALUES(?,?,?)",
                            (operation["operationId"], __import__("json").dumps(operation), obs.now()),
                        )
                conn.close()
                with patch.object(obs, "post", side_effect=deliver):
                    self.assertEqual(obs.flush(), 1)
                conn = obs.db()
                try:
                    self.assertEqual(conn.execute("SELECT count(*) FROM queue").fetchone()[0], 0)
                    dead = conn.execute("SELECT last_error FROM dead_letter WHERE operation_id=?", (bad["operationId"],)).fetchone()
                    self.assertIn("permanent fixture failure", dead["last_error"])
                finally:
                    conn.close()
            finally:
                obs.VAR, obs.QUEUE = old_var, old_queue


if __name__ == "__main__":
    unittest.main()
