import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from twin_shell.semantic_summary import (
    CodexSummaryEngine, TaskSummaries, context_for, fingerprint, validated_output,
)
from twin_shell.orchestrator import WorkTwinShell
from test_work_twin_activity import FeedClient, turn


def context(text="修订住房报告中的五个角色诉求"):
    return context_for({"name": "执行文件夹任务"}, [turn(text=text)])


class SummaryTests(unittest.TestCase):
    def test_context_keeps_recent_intent_and_evidence(self):
        turns = [turn(tid=str(i), text=f"具体阶段{i}") for i in range(9)]
        turns[-1]["items"][0]["content"][0]["text"] = "改为模拟语境"
        turns[-1]["items"].append({"type": "commandExecution", "output": "TOOL_SECRET"})
        payload = context_for({"name": "原任务名"}, turns)
        encoded = json.dumps(payload, ensure_ascii=False)
        self.assertIn("改为模拟语境", encoded)
        self.assertIn("具体阶段8", encoded)
        self.assertNotIn("具体阶段2", encoded)
        self.assertNotIn("TOOL_SECRET", encoded)
        self.assertEqual(len(payload["messages"]), 12)

    def test_credential_redaction_applies_to_every_field(self):
        raw = "hello@example.invalid /Users/demo/private.txt token=ONLY_A_FAKE_SECRET"
        data = context_for({"name": raw, "preview": raw}, [turn(text=raw)])
        serialized = json.dumps(data)
        for value in ["hello@example", "/Users/demo", "ONLY_A_FAKE_SECRET"]:
            self.assertNotIn(value, serialized)

    def test_embedded_environment_and_fenced_instructions_are_filtered(self):
        data = context_for({}, [turn(text="<heartbeat>DO_NOT_EXECUTE</heartbeat>```FAKE_TOOL```修订报告")])
        self.assertNotIn("DO_NOT_EXECUTE", json.dumps(data))
        self.assertNotIn("FAKE_TOOL", json.dumps(data))

    def test_versions_ignore_runtime_time_and_status(self):
        a = context_for({"name": "A", "updatedAt": 1}, [turn()])
        b = context_for({"name": "A", "updatedAt": 2}, [turn(status="inProgress")])
        self.assertEqual(fingerprint(a), fingerprint(b))
        self.assertNotEqual(fingerprint(a), fingerprint(context("方向改变")))

    def test_active_progress_does_not_starve_summary(self):
        a = context_for({}, [turn(text="正在检查布局")], active=True)
        b = context_for({}, [turn(text="正在核对按钮")], active=True)
        self.assertEqual(fingerprint(a), fingerprint(b))
        changed = turn(text="新方向")
        changed["items"][0]["content"][0]["text"] = "现在改做视频"
        self.assertNotEqual(fingerprint(a), fingerprint(context_for({}, [changed], active=True)))
        self.assertNotEqual(fingerprint(a), fingerprint(context_for({}, [turn(text="已给出检查结果")], active=False)))
        summaries = TaskSummaries(None)
        def engine(_):
            summaries.observe("running", b)
            return ["检查应用布局和按钮"]
        summaries.engine = engine
        summaries.observe("running", a)
        summaries.process_once()
        self.assertEqual(summaries.view("running")["brief_status"], "ready")

    def test_output_is_mapped_by_index(self):
        output = '{"summaries":[{"index":1,"text":"研究主题方案"},{"index":0,"text":"修订文档"}]}'
        self.assertEqual(validated_output(output, 2), ["修订文档", "研究主题方案"])

    def test_rejects_missing_duplicate_mapping_long_text_and_leaks(self):
        bad = [[], [{"index": 2, "text": "A"}], [{"index": True, "text": "A"}],
               [{"index": 0, "text": "长"*49}], [{"index": 0, "text": "/Users/demo/a.txt"}],
               [{"index": 0, "text": "hello@example.invalid"}], [{"index": 0, "text": "token=FAKE"}],
               [{"index": 0, "text": "<script>"}]]
        for rows in bad:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                validated_output(json.dumps({"summaries": rows}), 1)
        with self.assertRaises(ValueError):
            validated_output('{"summaries":[{"index":0,"text":"A"},{"index":0,"text":"B"}]}', 2)

    def test_same_context_calls_model_once(self):
        engine = mock.Mock(return_value=["修订报告的五类角色诉求"])
        summaries = TaskSummaries(engine)
        summaries.observe("a", context())
        self.assertTrue(summaries.process_once())
        for _ in range(20):
            summaries.observe("a", context())
            self.assertFalse(summaries.process_once())
        self.assertEqual(engine.call_count, 1)
        self.assertEqual(summaries.view("a")["brief_status"], "ready")

    def test_changed_context_throttles_then_regenerates(self):
        clock = [1000]
        engine = mock.Mock(return_value=["修订报告"])
        summaries = TaskSummaries(engine, clock=lambda: clock[0])
        summaries.observe("a", context()); summaries.process_once()
        summaries.observe("a", context("修订宣言"))
        self.assertEqual(summaries.view("a")["brief_status"], "pending")
        self.assertEqual(summaries.view("a")["task_brief"], "修订报告")
        self.assertFalse(summaries.process_once())
        clock[0] += 180
        self.assertTrue(summaries.process_once())
        self.assertEqual(engine.call_count, 2)

    def test_outdated_result_is_discarded(self):
        summaries = TaskSummaries(None)
        def engine(_):
            summaries.observe("a", context("已经换了项目"))
            return ["不应出现的旧摘要"]
        summaries.engine = engine
        summaries.observe("a", context()); summaries.process_once()
        self.assertEqual(summaries.view("a")["task_brief"], "")
        self.assertEqual(summaries.view("a")["brief_status"], "pending")

    def test_failure_backs_off_for_entire_queue(self):
        engine = mock.Mock(side_effect=RuntimeError("secret error must stay private"))
        summaries = TaskSummaries(engine)
        for i in range(8): summaries.observe(str(i), context())
        summaries.process_once()
        self.assertEqual(engine.call_count, 1)
        self.assertEqual(summaries.view("0")["brief_status"], "unavailable")
        self.assertFalse(summaries.process_once())
        self.assertNotIn("secret error", str(summaries.entries))

    def test_title_alone_cannot_be_called_ai(self):
        engine = mock.Mock()
        summaries = TaskSummaries(engine)
        summaries.observe("a", context_for({"name": "第一条标题"}, []))
        self.assertFalse(summaries.process_once())
        self.assertEqual(summaries.view("a")["brief_status"], "insufficient")

    def test_bounded_batches_and_cache(self):
        engine = mock.Mock(side_effect=lambda c: ["摘要"]*len(c))
        summaries = TaskSummaries(engine)
        for i in range(200): summaries.observe(str(i), context())
        self.assertEqual(len(summaries.entries), 180)
        summaries.process_once()
        self.assertEqual(len(engine.call_args.args[0]), 4)

    def test_shell_fixture_cannot_invoke_real_model_or_persist_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shell = WorkTwinShell(state_path=root/"state.json", client=FeedClient(root))
            self.assertIsNone(shell.summaries.engine)
            shell.summaries.engine = mock.Mock(return_value=["THIS_DERIVED_TEXT_STAYS_IN_MEMORY"])
            detail = shell.read_thread("thread-0")
            original_version = detail["card"]["context_version"]
            shell.summaries.process_once()
            updated = shell.read_thread("thread-0")["card"]
            self.assertEqual(updated["context_version"], original_version)
            self.assertFalse(updated["can_send"])
            self.assertNotIn("THIS_DERIVED_TEXT", (root/"state.json").read_text())
            self.assertFalse(any(m in {"thread/start", "thread/resume", "turn/start"} for m, _ in shell.client.calls))

    def test_summary_engine_uses_only_disposable_session(self):
        class Client:
            def __init__(self, **kwargs): self.callback = kwargs["on_message"]; self.calls=[]; self.closed=False
            def start(self): pass
            def close(self): self.closed=True
            def request(self, method, params):
                self.calls.append((method, params))
                if method == "thread/start": return {"result": {"thread": {"id": "temporary", "ephemeral": True}}}
                if method == "turn/start":
                    self.callback({"method":"item/completed", "params":{"item":{"type":"agentMessage","text":'{"summaries":[{"index":0,"text":"修订报告"}]}'}}})
                    self.callback({"method":"turn/completed", "params":{"turn":{"status":"completed"}}})
                    return {"result": {"turn": {"id":"turn"}}}
        with mock.patch("twin_shell.semantic_summary.AppServerClient", side_effect=Client) as factory, mock.patch.object(CodexSummaryEngine, "overrides", return_value=[]):
            self.assertEqual(CodexSummaryEngine()([context()]), ["修订报告"])
            self.assertTrue(factory.called)

    def test_engine_refuses_non_ephemeral_session(self):
        fake = mock.Mock()
        fake.request.return_value = {"result":{"thread":{"id":"unsafe","ephemeral":False}}}
        with mock.patch("twin_shell.semantic_summary.AppServerClient", return_value=fake), mock.patch.object(CodexSummaryEngine, "overrides", return_value=[]):
            with self.assertRaises(ValueError): CodexSummaryEngine()([context()])
        self.assertEqual(fake.request.call_count, 1)
        fake.close.assert_called_once()

    def test_disabled_capabilities_are_process_overrides(self):
        with mock.patch("twin_shell.semantic_summary.Path.is_file", return_value=False):
            values = CodexSummaryEngine.overrides()
        for setting in ["features.shell_tool=false", "features.apps=false", "features.hooks=false",
                        "features.plugins=false", "features.multi_agent=false", 'history.persistence="none"',
                        "memories.generate_memories=false", "project_doc_max_bytes=0"]:
            self.assertIn(setting, values)

    def test_mcp_headers_include_quoted_keys_and_comments(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder)/"config.toml").write_text('[mcp_servers."test.server"] # local\nsecret="FAKE_PRIVATE"\n[mcp_servers.test.env]\ncredential="FAKE_PRIVATE"\n')
            values = CodexSummaryEngine.overrides(Path(folder))
            self.assertIn('mcp_servers."test.server".enabled=false', values)
            self.assertIn('mcp_servers.test.enabled=false', values)
            self.assertNotIn("FAKE_PRIVATE", str(values))


if __name__ == "__main__": unittest.main()
