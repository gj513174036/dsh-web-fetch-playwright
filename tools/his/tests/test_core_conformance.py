#!/usr/bin/env python3
"""Python↔JS 一致性对照：同一个事实喂给两边，结论必须逐条相同。

为什么需要这个测试：判定规则现在有**两份实现**（`rules.py` 给命令行/定时/审计，
`portal-core.js` 给浏览器里同源直查）。临床判定出现两个真相源是危险的，所以这里
把"行为定义"钉死在 Python 那份上：JS 的 verdict / severity / ruleId / 参考区间 /
判定依据文案只要与 Python 不同，这条测试就红。

三组用例：

* `BranchCoverage` —— 构造数据，把 `rules.py` 的每一条分支都覆盖到（危急值、报告标志、
  分段区间、定性一致/阳性、haveCrisis 线索、判不了…），不依赖任何真实数据；
* `ViewConformance` —— 同样构造数据，比对 `portal.build_view` 与 `core.buildView`
  的整份视图（趋势合并、严重度取最重、就诊带上处方…）；
* `RealDataConformance` —— 如果本机有真机事实文件（`net-dumps/`，不入库），
  拿它整份对照一遍（实测 500+ 条判定）。没有就跳过。

跑法（与其它 tools 一致）::

    python3 -m unittest discover -s tools/his/tests -t tools/his

需要 `node`（本仓库本来就有）。没有 node 时这三组会明确跳过，而不是假装通过。
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)                 # tools/his
REPO = os.path.dirname(os.path.dirname(TOOLS))  # 仓库根（net-dumps 在它下面）
RUNNER = os.path.join(HERE, "run-core.mjs")
sys.path.insert(0, TOOLS)

import portal  # noqa: E402
import rules  # noqa: E402

NODE = shutil.which("node")
PATIENT = {"hisUserId": "his-1", "hmsUserId": "hms-1", "name": "测试甲",
           "telephone": "13800000001", "sex": "男", "age": 41}


def run_js(payload: dict) -> object:
    result = subprocess.run([NODE, RUNNER], input=json.dumps(payload, ensure_ascii=False),
                            capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise AssertionError(f"node 跑失败({result.returncode}): {result.stderr[:400]}")
    return json.loads(result.stdout)


def fact(kind: str, source_id: str, items: list[dict], extra: dict | None = None,
         date: str = "2026-09-24", patient: dict | None = None) -> dict:
    return {
        "key": f"k|{kind}|{source_id}", "date": date, "kind": kind,
        "patient": patient or PATIENT,
        "source": {"endpoint": "/x", "sourceId": source_id, "collectedAt": "2026-09-24T10:00:00"},
        "items": items, "extra": extra or {},
    }


def branch_fixture() -> list[dict]:
    """把 rules.py 的分支逐条摆出来。每条都带一句"它想验证什么"。"""
    return [
        # 处方/医嘱：开过什么药，不进异常清单
        fact("prescription", "v1", [
            {"itemCode": "XY1", "itemName": "非布司他片", "result": "单次 40mg，频次 qd，共 7片",
             "unit": "mg", "reference": "40mg*16T", "flagText": "已执行", "orderType": "西药",
             "usage": "口服", "frequency": "qd", "packUnit": "片", "price": 6.16,
             "itemKind": "medicine", "checkTime": 1790220355468},
            {"itemCode": "JY1", "itemName": "血脂四项", "result": "", "itemType": "5",
             "flagText": "待执行", "orderType": "检验", "itemKind": "service"},
        ]),
        # 体检结论条目：带分级，只有名字指向危急才升级
        fact("checkup", "med-1", [
            {"itemCode": "d-1", "itemName": "高尿酸血症", "disease": "高尿酸血症", "level": "2",
             "flagText": "中度", "checkTime": 1790215175465},
            {"itemCode": "d-2", "itemName": "低血糖", "disease": "低血糖", "level": "5",
             "flagText": "危急", "checkTime": 1790215175465},
            {"itemCode": "d-3", "itemName": "脂肪肝", "disease": "脂肪肝", "level": "0",
             "checkTime": 1790215175465},
        ]),
        # 危急值模块 + 报告标志的每个取值 + 区间比对 + 定性 + 判不了
        fact("lab", "rep-1", [
            {"itemCode": "K", "itemName": "血钾", "result": "7.10", "unit": "mmol/L",
             "reference": "3.50-5.30", "flagText": "", "crisis": True, "crisisValue": "3",
             "haveCrisis": "1", "checkTime": 1790215175465},
            {"itemCode": "ALT", "itemName": "谷丙转氨酶", "result": "31", "unit": "U/L",
             "reference": "9-50", "flagText": "M", "checkTime": 1790215175465},
            {"itemCode": "CHO", "itemName": "总胆固醇", "result": "9.80", "unit": "mmol/L",
             "reference": "3.50-9.50", "flagText": "", "checkTime": 1790215175465},
            {"itemCode": "TG", "itemName": "甘油三酯", "result": "2.10", "unit": "mmol/L",
             "reference": "0.40-1.70", "flagText": "H", "arrow": "↑", "checkTime": 1790215175465},
            {"itemCode": "HDL", "itemName": "高密度脂蛋白", "result": "1.10", "unit": "mmol/L",
             "reference": "1.16-1.42", "flagText": "L", "checkTime": 1790215175465},
            {"itemCode": "HBS", "itemName": "乙肝表面抗原", "result": "阴性", "unit": None,
             "reference": "阴性", "flagText": "", "checkTime": 1790215175465},
            {"itemCode": "OB", "itemName": "潜血", "result": "阳性(+)", "unit": None,
             "reference": "阴性(-)", "flagText": "", "checkTime": 1790215175465},
            {"itemCode": "VITD", "itemName": "25-羟基维生素D", "result": "24.5", "unit": "ng/mL",
             "reference": "缺乏:0--19.9|不充足:20--29.9|充足:30--100|过量:>100",
             "flagText": "", "checkTime": 1790215175465},
            {"itemCode": "SAA", "itemName": "淀粉样蛋白A", "result": "21.8", "unit": "mg/L",
             "reference": "<10", "flagText": "", "checkTime": 1790215175465},
            {"itemCode": "URBC", "itemName": "红细胞", "result": "0.00", "unit": "个/ul",
             "reference": "0--6", "flagText": "", "checkTime": 1790215175465},
            {"itemCode": "COLOR", "itemName": "颜色", "result": "黄色", "unit": None,
             "reference": "黄色", "flagText": "", "checkTime": 1790215175465},
            {"itemCode": "FXZ", "itemName": "性状", "result": "软便", "unit": None,
             "reference": None, "flagText": "", "checkTime": 1790215175465},
            {"itemCode": "MUCUS", "itemName": "粘液", "result": "未见", "unit": None,
             "reference": "未见", "flagText": "", "checkTime": 1790215175465},
            # 结果是定性阴性、但没有可比参考 → 走 qualitative-result（与 step5 那条区分开）
            {"itemCode": "QUAL", "itemName": "定性阴性无参考", "result": "阴性", "unit": None,
             "reference": None, "flagText": "", "checkTime": 1790215175465},
            {"itemCode": "HINT", "itemName": "不确定项", "result": "见描述", "unit": None,
             "reference": None, "flagText": "", "crisisHint": "1", "checkTime": 1790215175465},
            {"itemCode": "EMPTY", "itemName": "没有结果", "result": None, "unit": None,
             "reference": None, "flagText": "", "checkTime": 1790215175465},
            {"itemCode": "PCODE", "itemName": "无法归类标志", "result": "1.0", "unit": None,
             "reference": "0-2", "flagText": "Z", "checkTime": 1790215175465},
            {"itemCode": "YANG", "itemName": "阳性标志", "result": "1", "unit": None,
             "reference": "0-2", "flagText": "", "isYang": "1", "checkTime": 1790215175465},
            {"itemCode": "MINMAX", "itemName": "只有上下限", "result": "488", "unit": "μmol/L",
             "reference": "", "minValue": 208, "maxValue": 428, "flagText": "",
             "checkTime": 1790215175465},
        ]),
        # 检查报告：描述型，结论在 extra
        fact("exam", "exam-1", [], {"groupItemName": "腹部超声", "checkResult": "肝回声增强",
                                    "checkTime": "2026-09-24 09:20:00", "checkDoctorName": "测试医生"}),
        # 就诊：处方挂在就诊上
        fact("visit", "v1", [], {"diagnosisList": [{"diagnosisName": "高尿酸血症"}],
                                 "clinicTime": 1790179200000, "deptName": "全科门诊",
                                 "recordsNo": "R0001", "mainSuit": "体检复查"}),
        # 单项历史：时序点只给 minValue/maxValue
        fact("trend", "尿酸", [
            {"itemCode": "JYS00021", "itemName": "尿酸(UA)", "result": "419", "referenceRange": "202--416",
             "tipsContent": "偏高", "checkTime": "2025-10-17 08:00:00"},
            {"itemCode": "JYS00021", "itemName": "尿酸(UA)", "result": "359", "referenceRange": "",
             "minValue": "202", "maxValue": "416", "checkTime": "2026-01-06 08:00:00"},
        ], {"groupItemName": "尿酸(尿酸酶法)"}),
        # 危急值模块：与检验同名 → 并进同一条序列；没有对应检验的 → 独立一张卡
        fact("crisis", "M0000001", [
            {"itemCode": "1", "itemName": "血钾", "result": "7.10", "crisis": True,
             "crisisValue": 3, "flagText": "未处理", "checkTime": None},
            {"itemCode": "1", "itemName": "肺结节", "result": None, "crisis": True,
             "crisisValue": 1, "flagText": "1", "checkTime": None},
        ]),
    ]


class NodeAvailable(unittest.TestCase):
    def test_node_is_available(self) -> None:
        if not NODE:
            self.skipTest("没有 node，跳过一致性对照")
        self.assertTrue(os.path.exists(RUNNER))
        self.assertTrue(os.path.exists(os.path.join(TOOLS, "portal-core.js")))


def as_json(value: object) -> object:
    """转成 Python 对象再比 —— 这样 `0` 与 `0.0` 视为相等（只是序列化写法不同）。

    JS 的 `Math.round(x*1e6)/1e6` 得到的是整数 `0`，Python 的 `round(..., 6)` 得到 `0.0`；
    两边数值相同，字面不同。用 Python 的 `==` 比较正好把这种差异抹平，
    而真正的语义差异（比如 verdict 不同）仍然会红。
    """
    return json.loads(json.dumps(value, ensure_ascii=False))


@unittest.skipUnless(NODE, "没有 node")
class BranchCoverageTest(unittest.TestCase):
    """逐条分支对照：Python 的每个 verdict/ruleId 都要在 JS 里一模一样。"""

    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.facts = branch_fixture()
        cls.py_rows = [rules.evaluate_fact(f) for f in cls.facts]
        cls.js_rows = run_js({"mode": "verdicts", "facts": cls.facts})

    def test_every_branch_matches(self) -> None:
        self.assertEqual(len(self.py_rows), len(self.js_rows))
        mismatches = []
        for fact_index, (py_fact, js_fact) in enumerate(zip(self.py_rows, self.js_rows)):
            self.assertEqual(len(py_fact), len(js_fact), f"第 {fact_index} 条事实的明细数不同")
            for py_row, js_row in zip(py_fact, js_fact):
                for field in js_row:
                    if py_row.get(field) != js_row[field]:
                        mismatches.append(
                            f"fact#{fact_index} {py_row.get('itemName')} 字段 {field}: "
                            f"py={py_row.get(field)!r} js={js_row[field]!r}")
        self.assertEqual(mismatches, [], "\n".join(mismatches))

    def test_all_expected_branches_are_present(self) -> None:
        """防止"构造数据漏了某条分支"，让上面的对照变成假绿。"""
        rule_ids = {row["ruleId"] for rows in self.py_rows for row in rows}
        verdicts = {row["verdict"] for rows in self.py_rows for row in rows}
        for expected in ("prescription", "diagnosis", "diagnosis-crisis", "crisis", "report-flag",
                         "report-normal", "report-positive", "ref-range", "ref-segment",
                         "qualitative", "qualitative-match", "qualitative-result",
                         "crisis-hint", "unparsed", "no-result"):
            self.assertIn(expected, rule_ids, f"构造数据缺分支: {expected}")
        for expected in ("recorded", "crisis", "abnormal", "high", "low", "normal",
                         "negative", "positive", "unknown"):
            self.assertIn(expected, verdicts, f"构造数据缺结论: {expected}")


@unittest.skipUnless(NODE, "没有 node")
class ViewConformanceTest(unittest.TestCase):
    maxDiff = None
    """整份视图对照：趋势合并、严重度取最重、就诊带处方、KPI 计数都要一致。"""

    def test_view_matches_python(self) -> None:
        facts = branch_fixture()
        meta = {"collectedAt": "2026-09-24T10:00:00", "day": "2026-09-24"}
        expected = portal.build_view(PATIENT, facts, meta)
        actual = run_js({"mode": "view", "patient": PATIENT, "facts": facts, "meta": meta})
        self.assertEqual(as_json(actual), as_json(expected))

    def test_series_identity_and_crisis_merge_survive_the_port(self) -> None:
        facts = branch_fixture()
        view = run_js({"mode": "view", "patient": PATIENT, "facts": facts, "meta": {}})
        by_name = {entry["name"]: entry for entry in view["abnormal"]}
        # 危急值模块的"血钾"并进了检验的"血钾"（同名序列唯一），worst=crisis
        self.assertEqual(by_name["血钾"]["worst"], "crisis")
        self.assertEqual(len(by_name["血钾"]["points"]), 2)
        # "肺结节"没有对应检验序列 → 自成一张卡
        self.assertIn("肺结节", by_name)
        # 尿酸按 itemCode 合并成一条趋势，delta 算得出来
        uric = next(entry for entry in view["trends"] if "尿酸" in entry["name"])
        self.assertEqual([point["value"] for point in uric["numeric"]], [419.0, 359.0])
        self.assertEqual(uric["delta"], -60.0)
        # 同一次就诊的处方挂在了就诊上，且不进趋势
        self.assertEqual(len(view["visits"][0]["prescriptions"]), 2)
        self.assertNotIn("非布司他片", [entry["name"] for entry in view["trends"]])


@unittest.skipUnless(NODE, "没有 node")
class RealDataConformanceTest(unittest.TestCase):
    maxDiff = None
    """有真机事实文件就拿它整份对照 —— 这是这套移植最硬的一道证据。"""

    GLOBS = ("out-person/facts-*.jsonl", "out-portal/facts-*.jsonl",
             "out-live/facts-*.jsonl", "out/facts-*.jsonl")

    @classmethod
    def setUpClass(cls) -> None:
        cls.paths: list[str] = []
        for pattern in cls.GLOBS:
            cls.paths.extend(sorted(glob.glob(os.path.join(REPO, "net-dumps", "his", pattern))))
        cls.facts: list[dict] = []
        for path in cls.paths:
            with open(path, encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if line:
                        cls.facts.append(json.loads(line))

    def test_real_facts_match_row_by_row(self) -> None:
        if not self.facts:
            self.skipTest("本机没有真机事实文件（net-dumps/），跳过")
        py_rows = [rules.evaluate_fact(f) for f in self.facts]
        js_rows = run_js({"mode": "verdicts", "facts": self.facts})
        total = sum(len(rows) for rows in py_rows)
        self.assertGreater(total, 100, "真机数据太少，对照没有意义")
        mismatches = []
        for fact_index, (py_fact, js_fact) in enumerate(zip(py_rows, js_rows)):
            for py_row, js_row in zip(py_fact, js_fact):
                for field in js_row:
                    if py_row.get(field) != js_row[field]:
                        mismatches.append(f"{self.facts[fact_index]['kind']} "
                                          f"{py_row.get('itemName')} {field}: "
                                          f"py={py_row.get(field)!r} js={js_row[field]!r}")
        self.assertEqual(mismatches[:10], [], f"共 {len(mismatches)} 处不一致\n" + "\n".join(mismatches[:10]))

    def test_real_view_matches(self) -> None:
        if not self.facts:
            self.skipTest("本机没有真机事实文件（net-dumps/），跳过")
        patient = self.facts[0]["patient"]
        facts = [f for f in self.facts
                 if str((f.get("patient") or {}).get("hisUserId")) == str(patient.get("hisUserId"))]
        meta = {"collectedAt": "2026-09-24T10:00:00", "day": "2026-09-24"}
        expected = portal.build_view(patient, facts, meta)
        actual = run_js({"mode": "view", "patient": patient, "facts": facts, "meta": meta})
        self.assertEqual(actual["counts"], expected["counts"])
        self.assertEqual([entry["name"] for entry in actual["abnormal"]],
                         [entry["name"] for entry in expected["abnormal"]])
        self.assertEqual(as_json(actual), as_json(expected))


@unittest.skipUnless(NODE, "没有 node")
class TimestampConformanceTest(unittest.TestCase):
    """时间戳形状：真机 checkTime 是**毫秒 int**，取前 10 个字符会得到假日期。"""

    def test_to_date_matches_python(self) -> None:
        values = [1790215175465, 1790215175, 20260924, "2026-09-24 09:10:00", "2026-09-24",
                  "", None, "见描述", 0, 12345]
        self.assertEqual(run_js({"mode": "date", "values": values}),
                         [portal.to_date(value) for value in values])


if __name__ == "__main__":
    unittest.main()
