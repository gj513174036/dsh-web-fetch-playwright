#!/usr/bin/env python3
"""采集 + 规则的测试：单元判定用构造数据，端到端用假的病例系统（`mock_his.py`）。

跑法（与 `tools/netdump` 一致，只用标准库）::

    python3 -m unittest discover -s tools/his/tests -t tools/his

端到端那条会：起 mock → 写一份带 Cookie 的 session.json → 跑 `collect.py --mode daily`
→ 跑 `rules.py` → 断言"危急值/报告标志/区间比对/定性/判不了"五类判定都各就各位。
另有三条协议级断言：缺 Cookie 必须失败（HTTP 仍是 200）、名单 0 条必须以退出码 3 失败、
重跑必须续跑而不是重复采集。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

def _lines(path: str) -> int:
    """行数（显式关闭句柄，免得 ResourceWarning 淹没真正的失败）。"""
    with open(path, encoding="utf-8") as handle:
        return len(handle.readlines())


HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, TOOLS)

import mock_his  # noqa: E402  (路径由上面的 sys.path 提供)
import rules  # noqa: E402


class ReferenceParsingTest(unittest.TestCase):
    def test_numbers_survive_arrows_and_units(self) -> None:
        self.assertEqual(rules.parse_number("5.20"), 5.2)
        self.assertEqual(rules.parse_number("9.8↑"), 9.8)
        self.assertEqual(rules.parse_number("↑ 12.3 mmol/L"), 12.3)
        self.assertIsNone(rules.parse_number("阴性"))
        self.assertIsNone(rules.parse_number(None))

    def test_ranges_in_every_shape_the_system_uses(self) -> None:
        self.assertEqual(rules.parse_reference("3.50-9.50"), (3.5, 9.5, "numeric"))
        self.assertEqual(rules.parse_reference("0.4~1.7"), (0.4, 1.7, "numeric"))
        self.assertEqual(rules.parse_reference("9—50"), (9.0, 50.0, "numeric"))
        self.assertEqual(rules.parse_reference("<5.0"), (None, 5.0, "numeric"))
        self.assertEqual(rules.parse_reference("≤ 10"), (None, 10.0, "numeric"))
        self.assertEqual(rules.parse_reference(">1.0"), (1.0, None, "numeric"))
        self.assertEqual(rules.parse_reference("阴性"), (None, None, "qualitative"))
        self.assertEqual(rules.parse_reference("(-)"), (None, None, "qualitative"))
        self.assertEqual(rules.parse_reference("3.5-9.5 mmol/L"), (None, None, "unknown"))
        self.assertEqual(rules.parse_reference(""), (None, None, "unknown"))

    def test_reversed_range_is_normalized(self) -> None:
        self.assertEqual(rules.parse_reference("9.5-3.5"), (3.5, 9.5, "numeric"))


class VerdictPriorityTest(unittest.TestCase):
    """优先级：危急值 > 报告标志 > 区间比对 > 判不了。每一步都能说出凭什么。"""

    def test_crisis_wins_over_everything(self) -> None:
        row = rules.verdict_of({"result": "7.1", "reference": "3.5-5.3", "crisis": True, "crisisValue": "危急"})
        self.assertEqual((row["verdict"], row["severity"], row["ruleId"]), ("crisis", "crisis", "crisis"))

    def test_have_crisis_alone_is_only_a_review_hint(self) -> None:
        """实测：这个系统的 haveCrisis 在 97% 的明细上都是 1，绝不能当危急值。"""
        # 有可比区间时区间说了算；只有"判不了 + 有 hint"才降级为请人看一眼
        in_range = rules.verdict_of({"result": "24.5", "reference": "0--100", "crisisHint": True})
        self.assertEqual(in_range["ruleId"], "ref-range")
        unjudgeable = rules.verdict_of({"result": "见描述", "crisisHint": True})
        self.assertEqual((unjudgeable["verdict"], unjudgeable["severity"], unjudgeable["ruleId"]),
                         ("unknown", "review", "crisis-hint"))

    def test_segmented_reference_uses_the_segment_name(self) -> None:
        reference = "缺乏:0--19.9|不充足:20--29.9|充足:30--100|过量:>100"
        self.assertEqual(rules.verdict_of({"result": "12", "reference": reference})["verdict"], "low")
        self.assertEqual(rules.verdict_of({"result": "45", "reference": reference})["verdict"], "normal")
        self.assertEqual(rules.verdict_of({"result": "180", "reference": reference})["verdict"], "high")
        segmented = rules.verdict_of({"result": "24.5", "reference": reference})
        self.assertEqual((segmented["ruleId"], segmented["refKind"]), ("ref-segment", "segmented"))
        self.assertIn("不充足", segmented["why"])

    def test_result_remark_arrow_counts_as_a_report_flag(self) -> None:
        row = rules.verdict_of({"result": "24.5", "reference": "0--100", "arrow": "↓"})
        self.assertEqual((row["verdict"], row["ruleId"]), ("low", "report-flag"))

    def test_checkup_conclusion_levels(self) -> None:
        # 体检结论列的是既往诊断，每条都带严重度分级：整体算异常会刷出数百条噪声
        prescription = rules.verdict_of({"itemName": "非布司他片", "orderType": "西药",
                                         "frequency": "qd", "result": "单次 40mg，频次 qd，共 7mg，7 天，口服"})
        self.assertEqual((prescription["verdict"], prescription["ruleId"]), ("recorded", "prescription"))
        graded = rules.verdict_of({"itemName": "高尿酸血症", "disease": "高尿酸血症", "level": "2", "flagText": "中度"})
        self.assertEqual((graded["verdict"], graded["ruleId"]), ("recorded", "diagnosis"))
        crisisish = rules.verdict_of({"itemName": "低血糖", "disease": "低血糖", "level": "5", "flagText": "危急"})
        self.assertEqual((crisisish["verdict"], crisisish["ruleId"]), ("abnormal", "diagnosis-crisis"))

    def test_normal_flag_codes_are_not_abnormal(self) -> None:
        """实测 abnormalTips 的取值：M=正常(1096 条)、N=正常、H/L=高低、P=阳性。"""
        for code in ("M", "N", "m", "n", ""):
            row = rules.verdict_of({"result": "5.0", "reference": "3.5-9.5", "flagText": code})
            self.assertEqual(row["verdict"], "normal", code)
            self.assertIn(row["ruleId"], ("report-normal", "ref-range"))
        self.assertEqual(rules.verdict_of({"result": "1", "reference": "0-2", "flagText": "P"})["verdict"], "positive")
        self.assertEqual(rules.verdict_of({"result": "1", "reference": "0-2", "flagText": "H"})["verdict"], "high")

    def test_report_flag_beats_range_and_keeps_its_direction(self) -> None:
        row = rules.verdict_of({"result": "9.9", "reference": "3.5-9.5", "flagText": "↑"})
        self.assertEqual((row["verdict"], row["ruleId"]), ("high", "report-flag"))
        low = rules.verdict_of({"result": "0.1", "reference": "3.5-9.5", "flagText": "偏低"})
        self.assertEqual((low["verdict"], low["ruleId"]), ("low", "report-flag"))
        vague = rules.verdict_of({"result": "1", "reference": "0-2", "flagText": "异常"})
        self.assertEqual((vague["verdict"], vague["ruleId"]), ("abnormal", "report-flag"))

    def test_range_only_when_nothing_else_speaks(self) -> None:
        self.assertEqual(rules.verdict_of({"result": "9.8", "reference": "3.5-9.5"})["verdict"], "high")
        self.assertEqual(rules.verdict_of({"result": "3.0", "reference": "3.5-9.5"})["verdict"], "low")
        self.assertEqual(rules.verdict_of({"result": "5.0", "reference": "3.5-9.5"})["verdict"], "normal")
        # minValue/maxValue 是参考区间的另一种给法
        self.assertEqual(rules.verdict_of({"result": "488", "reference": ""}, {"minValue": 208, "maxValue": 428})["verdict"], "high")

    def test_qualitative_and_unparseable_are_named_not_dropped(self) -> None:
        negative = rules.verdict_of({"result": "阴性", "reference": "阴性"})
        self.assertEqual((negative["verdict"], negative["ruleId"]), ("negative", "qualitative"))
        weird = rules.verdict_of({"result": "见描述", "reference": "—"})
        self.assertEqual((weird["verdict"], weird["severity"]), ("unknown", "review"))
        empty = rules.verdict_of({})
        self.assertEqual(empty["ruleId"], "no-result")

    def test_positive_flag_is_abnormal(self) -> None:
        row = rules.verdict_of({"result": "阳性", "reference": "阴性", "isYang": "1"})
        self.assertEqual((row["verdict"], row["ruleId"]), ("positive", "report-positive"))


class PipelineEndToEndTest(unittest.TestCase):
    """起假系统，跑真正的 collect.py 与 rules.py（子进程）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.server, cls.base = mock_his.make_server()
        cls.tmp = tempfile.TemporaryDirectory(prefix="his-test-")
        cls.session_path = os.path.join(cls.tmp.name, "session.json")
        with open(cls.session_path, "w", encoding="utf-8") as handle:
            json.dump({"base": cls.base, "headers": {"Cookie": "x-auth-token=test"}, "proxy": ""}, handle)
        cls.outdir = os.path.join(cls.tmp.name, "out")

    def _fresh(self, name: str) -> str:
        """每个用例一个独立输出目录 —— 否则"续跑"会读到上一个用例的成果。"""
        return os.path.join(self.tmp.name, name)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def _collect(self, *extra: str, session: str | None = None) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable, os.path.join(TOOLS, "collect.py"),
            "--session", session or self.session_path,
            "--endpoints", os.path.join(TOOLS, "endpoints.example.json"),
            "--date", "2026-09-24", "--doctor", "测试医生",
            *extra,
        ]
        if "--out" not in extra:
            command += ["--out", self.outdir]
        return subprocess.run(command, capture_output=True, text=True, timeout=120)

    def test_daily_then_rules_classifies_every_kind(self) -> None:
        result = self._collect("--with-trends")
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout[result.stdout.index("{"):result.stdout.rindex("}") + 1])
        self.assertEqual(summary["rosterTotal"], 2)
        self.assertEqual(summary["errors"], [])
        facts_path = os.path.join(self.outdir, "facts-2026-09-24.jsonl")
        facts = [json.loads(line) for line in open(facts_path, encoding="utf-8")]
        kinds = {fact["kind"] for fact in facts}
        self.assertLessEqual({"visit", "lab", "exam", "checkup", "crisis", "trend"}, kinds)
        # 桥：体检侧要的是 hmsUserId，且必须与 HIS 行里的一致
        patient = next(fact["patient"] for fact in facts if fact["patient"].get("hmsUserId"))
        self.assertEqual(patient["hmsUserId"], mock_his.HMS_A)

        rules_result = subprocess.run(
            [sys.executable, os.path.join(TOOLS, "rules.py"), "--facts", facts_path,
             "--out", self.outdir, "--tag", "2026-09-24"],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(rules_result.returncode, 0, rules_result.stderr)
        evaluated = [json.loads(line) for line in
                     open(os.path.join(self.outdir, "evaluated-2026-09-24.jsonl"), encoding="utf-8")]
        by_item = {(row["itemName"], row["sourceId"]): row for row in evaluated}

        crisis = by_item[("血钾", "M0000001")]
        self.assertEqual((crisis["verdict"], crisis["ruleId"]), ("crisis", "crisis"))   # 危急值模块那一路
        self.assertEqual(crisis["result"], "7.10")                                       # 字段映射对了才有值
        flagged = by_item[("甘油三酯", "rep-lab-1")]
        self.assertEqual((flagged["verdict"], flagged["ruleId"]), ("high", "report-flag"))
        ranged = by_item[("总胆固醇", "rep-lab-1")]
        self.assertEqual((ranged["verdict"], ranged["ruleId"]), ("high", "ref-range"))
        self.assertEqual(ranged["refHigh"], 9.5)
        self.assertEqual(by_item[("空腹血糖", "rep-lab-1")]["verdict"], "normal")
        self.assertEqual(by_item[("乙肝表面抗原", "rep-lab-1")]["verdict"], "negative")
        self.assertEqual((by_item[("谷丙转氨酶", "rep-lab-1")]["verdict"],
                          by_item[("谷丙转氨酶", "rep-lab-1")]["ruleId"]), ("normal", "report-normal"))
        self.assertEqual(by_item[("高尿酸血症", "med-data-1")]["verdict"], "recorded")   # 既往诊断，不是异常值
        self.assertEqual(by_item[("脂肪肝", "med-data-1")]["verdict"], "recorded")
        self.assertEqual(by_item[("25-羟基维生素D", "rep-lab-1")]["ruleId"], "report-flag")  # abnormalTips=L
        # 血钾明细：区间比对先说话（7.10 > 5.30），haveCrisis 只是线索，不能把它抬成危急值
        hinted = by_item[("血钾", "rep-lab-1")]
        self.assertEqual((hinted["verdict"], hinted["ruleId"]), ("high", "ref-range"))
        self.assertNotEqual(hinted["ruleId"], "crisis")

        abnormal = [json.loads(line) for line in
                    open(os.path.join(self.outdir, "abnormal-2026-09-24.jsonl"), encoding="utf-8")]
        self.assertTrue(all(row["verdict"] != "normal" for row in abnormal))
        self.assertTrue(any(row["ruleId"] == "crisis" for row in abnormal))
        # 每条都能回答"凭什么"
        for row in abnormal:
            self.assertTrue(row["ruleId"] and row["ruleVersion"] and row["why"])
            self.assertTrue(row["sourceEndpoint"] and row["sourceId"])

    def test_via_curl_transport_reaches_the_same_result(self) -> None:
        outdir = os.path.join(self.tmp.name, "out-curl")
        result = subprocess.run(
            [sys.executable, os.path.join(TOOLS, "collect.py"), "--session", self.session_path,
             "--out", outdir, "--endpoints", os.path.join(TOOLS, "endpoints.example.json"),
             "--date", "2026-09-25", "--doctor", "测试医生", "--via-curl"],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        facts = os.path.join(outdir, "facts-2026-09-25.jsonl")
        self.assertTrue(os.path.exists(facts))
        self.assertGreater(_lines(facts), 0)

    def test_rerun_resumes_instead_of_duplicating(self) -> None:
        outdir = self._fresh("out-resume")
        first = self._collect("--out", outdir)
        self.assertEqual(first.returncode, 0, first.stderr)
        facts_path = os.path.join(outdir, "facts-2026-09-24.jsonl")
        before = _lines(facts_path)
        second = self._collect("--out", outdir)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("续跑已完成", second.stdout)
        self.assertEqual(_lines(facts_path), before)
        self.assertGreater(before, 0)

    def test_missing_cookie_fails_on_the_business_status(self) -> None:
        session = os.path.join(self.tmp.name, "no-cookie.json")
        with open(session, "w", encoding="utf-8") as handle:
            json.dump({"base": self.base, "headers": {}}, handle)
        result = self._collect(session=session)
        self.assertEqual(result.returncode, 1)
        self.assertIn("登录超时", result.stderr)  # HTTP 是 200，失败只能从 body 里读出来

    def test_zero_roster_is_a_failure_not_a_quiet_day(self) -> None:
        outdir = os.path.join(self.tmp.name, "out-zero")
        result = subprocess.run(
            [sys.executable, os.path.join(TOOLS, "collect.py"), "--session", self.session_path,
             "--out", outdir, "--endpoints", os.path.join(TOOLS, "endpoints.example.json"),
             "--date", "2026-09-24", "--doctor", "NOBODY"],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 3)
        self.assertIn("名单为 0", result.stderr)

    def test_person_mode_pulls_visits_prescriptions_and_checkups(self) -> None:
        outdir = os.path.join(self.tmp.name, "out-person")
        result = subprocess.run(
            [sys.executable, os.path.join(TOOLS, "collect.py"), "--mode", "person",
             "--session", self.session_path, "--out", outdir,
             "--endpoints", os.path.join(TOOLS, "endpoints.example.json"),
             "--name", "测试甲", "--telephone", "13800000001"],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        tag = __import__("datetime").date.today().isoformat()
        facts = [json.loads(line) for line in
                 open(os.path.join(outdir, f"facts-{tag}.jsonl"), encoding="utf-8")]
        kinds = {fact["kind"] for fact in facts}
        self.assertLessEqual({"visit", "prescription", "lab", "exam", "checkup", "crisis"}, kinds)
        patient = facts[0]["patient"]
        # 姓名(+电话) → 两套 id：identity 端点一行同时给出
        self.assertEqual((patient["hisUserId"], patient["hmsUserId"]), (mock_his.HIS_A, mock_his.HMS_A))
        prescription = next(fact for fact in facts if fact["kind"] == "prescription")
        drugs = {item["itemName"]: item for item in prescription["items"]}
        self.assertIn("非布司他片", drugs)
        # 码值翻成人话，而不是留在编码里
        self.assertEqual(drugs["非布司他片"]["usage"], "口服")
        self.assertEqual(drugs["非布司他片"]["unit"], "mg")
        self.assertEqual(drugs["非布司他片"]["orderType"], "西药")
        self.assertEqual(drugs["非布司他片"]["flagText"], "已执行")
        self.assertIn("qd", drugs["非布司他片"]["result"])
        self.assertEqual(prescription["source"]["endpoint"], "/api/example/visit/visit-a1")
        # 同名的第二个人不会被混进来
        self.assertTrue(all(fact["patient"]["hisUserId"] == mock_his.HIS_A for fact in facts))

    def test_person_mode_refuses_ambiguous_identity(self) -> None:
        outdir = self._fresh("out-ambiguous")
        result = subprocess.run(
            [sys.executable, os.path.join(TOOLS, "collect.py"), "--mode", "person",
             "--session", self.session_path, "--out", outdir,
             "--endpoints", os.path.join(TOOLS, "endpoints.example.json"), "--name", "测试甲"],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("身份定位不唯一", result.stderr)


if __name__ == "__main__":
    unittest.main()
