#!/usr/bin/env python3
"""查询端口的测试：视图拼装用构造数据，搜索/采集/趋势用假的病例系统跑真链路。

跑法（与其它 tools 一致，只用标准库）::

    python3 -m unittest discover -s tools/his/tests -t tools/his

端到端那几条会：起假病例系统 → 起真端口服务 → 走 HTTP 搜索 → 采集 → 断言视图。
其中最重要的一条是**同名**：两个"测试甲"必须都列出来由人点选，端口绝不能自己挑一个。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, TOOLS)

import collect  # noqa: E402
import mock_his  # noqa: E402
import portal  # noqa: E402
import rules  # noqa: E402

PATIENT = {"hisUserId": "h-1", "hmsUserId": "m-1", "name": "测试甲", "telephone": "13800000001"}


def _fact(kind: str, source_id: str, items: list[dict], extra: dict | None = None,
          date: str = "2026-09-24", patient: dict | None = None) -> dict:
    return {
        "key": f"k|{kind}|{source_id}", "date": date, "kind": kind,
        "patient": patient or PATIENT,
        "source": {"endpoint": "/x", "sourceId": source_id, "collectedAt": "t"},
        "items": items, "extra": extra or {},
    }


class TimeAndKeyTest(unittest.TestCase):
    def test_check_time_shapes_from_the_real_system(self) -> None:
        """真机上 checkTime 是**毫秒 int**，不是字符串 —— 取前 10 个字符会得到假日期。"""
        self.assertEqual(portal.to_date(1790215175465), "2026-09-24")
        self.assertEqual(portal.to_date("2026-09-24 09:10:00"), "2026-09-24")
        self.assertEqual(portal.to_date("2026-09-24"), "2026-09-24")
        self.assertEqual(portal.to_date(20260924), "2026-09-24")
        self.assertEqual(portal.to_date(1790215175), "2026-09-24")   # 秒
        self.assertEqual(portal.to_date(None), "")
        self.assertEqual(portal.to_date(""), "")
        self.assertEqual(portal.to_date(True), "")

    def test_item_key_folds_the_parenthetical(self) -> None:
        self.assertEqual(portal.item_key("尿酸(UA)"), portal.item_key("尿酸（UA）"))
        self.assertEqual(portal.item_key("尿酸(UA)"), portal.item_key("尿酸"))
        self.assertEqual(portal.item_key(" 总胆固醇 (CHO) "), "总胆固醇")
        self.assertEqual(portal.item_key("HbA1c"), "hba1c")

    def test_masking_keeps_enough_to_disambiguate(self) -> None:
        self.assertEqual(portal.mask_phone("13800000001"), "138****0001")
        self.assertEqual(portal.mask_card("440000199001010000"), "4400**********0000")
        self.assertEqual(portal.mask_phone("123"), "123")


class BuildViewTest(unittest.TestCase):
    def test_same_item_across_reports_becomes_one_trend(self) -> None:
        facts = [
            _fact("lab", "r1", [{"itemName": "尿酸(UA)", "result": "419", "unit": "μmol/L",
                                 "reference": "202--416", "flagText": "H", "checkTime": 1700000000000}]),
            _fact("lab", "r2", [{"itemName": "尿酸", "result": "527", "unit": "μmol/L",
                                 "reference": "202--416", "flagText": "H", "checkTime": 1730000000000}]),
        ]
        view = portal.build_view(PATIENT, facts, {})
        self.assertEqual(len(view["trends"]), 1)
        series = view["trends"][0]
        self.assertEqual(series["name"], "尿酸(UA)")          # 出现最多、其次最长 → 带缩写那个
        self.assertEqual([point["value"] for point in series["numeric"]], [419.0, 527.0])
        self.assertEqual(series["delta"], 108.0)
        self.assertEqual(series["worst"], "abnormal")
        self.assertEqual(series["dates"], 2)
        self.assertFalse(series["unitConflict"])

    def test_worst_severity_wins_but_latest_value_is_shown(self) -> None:
        """历史上有过危急值、最近一次正常 —— 卡片必须两个都说得出来。"""
        facts = [
            _fact("crisis", "M1", [{"itemName": "血钾", "result": "7.10", "crisis": True,
                                    "crisisValue": "3", "flagText": "未处理",
                                    "checkTime": "2026-06-01 08:30:00"}]),
            _fact("lab", "r1", [{"itemName": "血钾", "result": "4.20", "unit": "mmol/L",
                                 "reference": "3.50-5.30", "checkTime": 1790215175465}]),
        ]
        view = portal.build_view(PATIENT, facts, {})
        series = next(entry for entry in view["abnormal"] if entry["name"] == "血钾")
        self.assertEqual(series["worst"], "crisis")
        self.assertEqual(series["latestSeverity"], "info")
        self.assertEqual(series["latest"]["value"], 4.2)

    def test_prescriptions_and_checkup_conclusions_stay_out_of_the_trends(self) -> None:
        facts = [
            _fact("prescription", "v1", [{"itemName": "非布司他片", "result": "单次 40mg，频次 qd，共 7片",
                                          "orderType": "西药", "frequency": "qd", "itemKind": "medicine",
                                          "checkTime": 1790220355468}]),
            _fact("checkup", "med-1", [{"itemName": "超重", "disease": "超重", "level": "2",
                                        "flagText": "中度", "checkTime": 1790215175465}]),
            _fact("lab", "r1", [{"itemName": "尿酸(UA)", "result": "419", "unit": "μmol/L",
                                 "reference": "202--416", "checkTime": 1790215175465}]),
            _fact("lab", "r2", [{"itemName": "尿酸(UA)", "result": "480", "unit": "μmol/L",
                                 "reference": "202--416", "checkTime": 1792000000000}]),
        ]
        view = portal.build_view(PATIENT, facts, {})
        self.assertEqual([entry["name"] for entry in view["trends"]], ["尿酸(UA)"])
        self.assertEqual([entry["name"] for entry in view["abnormal"]], ["尿酸(UA)"])
        self.assertEqual(len(view["prescriptions"]), 1)
        self.assertEqual(len(view["checkups"]), 1)
        self.assertEqual(view["checkups"][0]["diagnoses"][0]["name"], "超重")
        self.assertEqual(view["counts"]["items"], 4)

    def test_unjudgeable_rows_are_kept_as_a_review_bucket(self) -> None:
        facts = [_fact("lab", "r1", [
            {"itemName": "性状", "result": "软便", "reference": None, "checkTime": 1790215175465},
            {"itemName": "颜色", "result": "黄色", "reference": "黄色", "checkTime": 1790215175465},
        ])]
        view = portal.build_view(PATIENT, facts, {})
        self.assertEqual([row["itemName"] for row in view["review"]], ["性状"])
        self.assertEqual(view["counts"]["reviewItems"], 1)

    def test_item_code_is_the_identity_not_the_name(self) -> None:
        """真机实测：叫"白细胞"的是三个不同项目，只按名字归并会画出一条错误的趋势线。"""
        def pair(code: bool) -> list[dict]:
            def item(name, result, unit, reference, item_code):
                row = {"itemName": name, "result": result, "unit": unit, "reference": reference}
                if code:
                    row["itemCode"] = item_code
                return row
            return [
                _fact("lab", "r1", [item("白细胞", "阴性(-)", "Leu/ul", "阴性(-)", "JYL00009"),
                                    item("白细胞(UWBC)", "2.97", "个/ul", "0--12", "JYL00019")]),
                _fact("lab", "r2", [item("白细胞", "阴性(-)", "Leu/ul", "阴性(-)", "JYL00009"),
                                    item("白细胞(UWBC)", "4.95", "个/ul", "0--12", "JYL00019")]),
            ]

        by_code = portal.build_view(PATIENT, pair(True), {})
        series = by_code["trends"][0]
        self.assertEqual(series["name"], "白细胞(UWBC)")
        self.assertEqual([point["value"] for point in series["numeric"]], [2.97, 4.95])
        # 关键：Leu/ul 那个点没有被并进来
        self.assertNotIn("Leu/ul", {point["unit"] for point in series["points"]})

        # 没有编码时只能按名字并 —— 这正是要避免的情形，留一条断言盯住它
        by_name = portal.build_view(PATIENT, pair(False), {})
        self.assertEqual(len(by_name["trends"]), 1)
        self.assertIn("Leu/ul", {point["unit"] for point in by_name["trends"][0]["points"]})

    def test_same_item_code_across_panels_merges(self) -> None:
        """尿酸在"肾功3项"和"尿酸(尿酸酶法)"里编码都是 JYS00021 —— 必须并成一条趋势。"""
        facts = [
            _fact("lab", "r1", [{"itemName": "尿酸(UA)", "itemCode": "JYS00021", "result": "527",
                                 "unit": "umol/L", "reference": "202--416", "checkTime": 1790215175465}],
                  {"groupItemName": "肾功3项"}),
            _fact("lab", "r2", [{"itemName": "尿酸(UA)", "itemCode": "JYS00021", "result": "359",
                                 "unit": "umol/L", "reference": "202--416", "checkTime": 1792000000000}],
                  {"groupItemName": "尿酸(尿酸酶法)"}),
        ]
        view = portal.build_view(PATIENT, facts, {})
        self.assertEqual(len(view["trends"]), 1)
        self.assertEqual([point["value"] for point in view["trends"][0]["numeric"]], [527.0, 359.0])

    def test_visit_keeps_its_prescriptions(self) -> None:
        facts = [
            _fact("visit", "v1", [], {"diagnosisList": [{"diagnosisName": "高尿酸血症"}],
                                      "clinicTime": 1790179200000, "deptName": "全科门诊",
                                      "recordsNo": "R1"}),
            _fact("prescription", "v1", [{"itemName": "非布司他片", "result": "单次 40mg",
                                          "orderType": "西药", "checkTime": 1790220355468}]),
        ]
        view = portal.build_view(PATIENT, facts, {})
        self.assertEqual(view["visits"][0]["date"], "2026-09-24")
        self.assertEqual(view["visits"][0]["diagnoses"], ["高尿酸血症"])
        self.assertEqual(view["visits"][0]["prescriptions"][0]["itemName"], "非布司他片")


class QualitativeMatchRuleTest(unittest.TestCase):
    """规则 v5：定性结果与参考文本一致就是正常。"""

    def test_matching_qualitative_text_is_normal(self) -> None:
        for result, reference in (("未见", "未见"), ("黄色", "黄色"), ("未见异常", "未见异常")):
            row = rules.verdict_of({"result": result, "reference": reference})
            self.assertEqual(row["verdict"], "negative", result)
            self.assertEqual(row["severity"], "info", result)
            # "阴性/阴性" 走定性参考那一支（ruleId=qualitative），其余走新加的逐字比对
            self.assertIn(row["ruleId"], ("qualitative-match", "qualitative"), result)

    def test_differing_qualitative_text_is_not_silently_normal(self) -> None:
        row = rules.verdict_of({"result": "软便", "reference": None})
        self.assertEqual((row["verdict"], row["severity"]), ("unknown", "review"))
        # 参考说阴性、结果说阳性 —— 必须留在异常清单里（先前这里 severity=info 会被过滤掉）
        positive = rules.verdict_of({"result": "阳性(+)", "reference": "阴性(-)"})
        self.assertEqual((positive["verdict"], positive["severity"]), ("positive", "abnormal"))
        # 既非阴性也非阳性 → 交人看，不硬判
        unclear = rules.verdict_of({"result": "未查", "reference": "阴性(-)"})
        self.assertEqual((unclear["verdict"], unclear["severity"]), ("unknown", "review"))

    def test_the_qualitative_reference_branch_keeps_its_own_rule_id(self) -> None:
        """``阴性 / 阴性`` 走的是定性参考那一支，它的 why 会带上参考，信息更多。"""
        row = rules.verdict_of({"result": "阴性", "reference": "阴性"})
        self.assertEqual(row["ruleId"], "qualitative")


class AddressListTest(unittest.TestCase):
    """该打印哪个网址：docker 网桥有十几个，不能把真正有用的地址淹掉。"""

    PAIRS = [("docker0", "172.17.0.1"), ("br-abc", "172.18.0.1"), ("lo", "127.0.0.1"),
             ("enp6s0", "203.0.113.10"), ("tun0", "198.51.100.20")]

    def test_physical_interfaces_are_shown_and_bridges_folded(self) -> None:
        show, folded = portal._address_report(self.PAIRS, preferred="203.0.113.10")
        self.assertEqual(show[0], "203.0.113.10")           # 默认出口排最前
        self.assertEqual(show[1], "198.51.100.20")          # 代理所在的 tun0 也留着
        self.assertEqual(folded, 2)                         # 两个网桥折成"另有 2 个"
        self.assertNotIn("172.17.0.1", show)
        self.assertNotIn("127.0.0.1", show)

    def test_virtual_only_host_still_prints_something_usable(self) -> None:
        show, folded = portal._address_report([("docker0", "172.17.0.1")], preferred="9.9.9.9")
        self.assertEqual(show, ["172.17.0.1"])
        self.assertEqual(folded, 0)

    def test_no_interfaces_is_not_an_error(self) -> None:
        self.assertEqual(portal._address_report([], preferred=""), ([], 0))

    def test_limit_folds_the_rest(self) -> None:
        pairs = [(f"eth{i}", f"10.0.0.{i}") for i in range(1, 7)]
        show, folded = portal._address_report(pairs, limit=4)
        self.assertEqual(len(show), 4)
        self.assertEqual(folded, 2)


class TokenTest(unittest.TestCase):
    """浏览器在另一台机器上时必须监听局域网，那就要有令牌 —— 页面上是患者数据。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.his, cls.base = mock_his.make_server()
        cls.tmp = tempfile.TemporaryDirectory(prefix="portal-token-")
        session = collect.Session(base=cls.base, headers={"Cookie": "x-auth-token=test"}, proxy="")
        endpoints = collect.Endpoints.load(os.path.join(TOOLS, "endpoints.example.json"))
        cls.portal = portal.Portal(session, endpoints, cls.tmp.name, "2026-09-24", token="s3cret")
        cls.server = portal.create_server(cls.portal, "127.0.0.1", 0)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.his.shutdown()
        cls.his.server_close()
        cls.tmp.cleanup()

    def _status(self, path: str) -> int:
        try:
            with urllib.request.urlopen(self.url + path, timeout=10) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code

    def test_without_token_the_page_and_data_are_refused(self) -> None:
        self.assertEqual(self._status("/"), 401)
        self.assertEqual(self._status("/api/search?name=x"), 401)

    def test_health_tells_a_stranger_nothing_but_ok(self) -> None:
        with urllib.request.urlopen(self.url + "/api/health", timeout=10) as response:
            doc = json.loads(response.read().decode("utf-8"))
        self.assertEqual(doc, {"ok": True})          # 内网基地址、落盘路径都不给

    def test_query_token_sets_a_cookie_then_leaves_a_clean_url(self) -> None:
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
        with opener.open(self.url + "/?token=s3cret", timeout=10) as response:
            self.assertEqual(response.status, 200)
            page = response.read().decode("utf-8")
        self.assertIn("病例查询端口", page)
        with opener.open(self.url + "/", timeout=10) as response:      # Cookie 生效，无需再带 token
            self.assertEqual(response.status, 200)
        with opener.open(self.url + "/api/health", timeout=10) as response:
            self.assertIn("session", json.loads(response.read().decode("utf-8")))

    def test_wrong_token_is_refused(self) -> None:
        self.assertEqual(self._status("/?token=nope"), 401)


class LaunchPolicyTest(unittest.TestCase):
    """启动策略：非回环地址必须给令牌，且 --no-token 不能绕过。"""

    def _run(self, *argv: str) -> subprocess.CompletedProcess[str]:
        command = [sys.executable, os.path.join(TOOLS, "portal.py"),
                   "--session", "/nonexistent/session.json", *argv]
        return subprocess.run(command, capture_output=True, text=True, timeout=60)

    def test_remote_without_token_is_refused(self) -> None:
        result = self._run("--endpoints", os.path.join(TOOLS, "endpoints.example.json"),
                           "--host", "0.0.0.0", "--allow-remote", "--no-token")
        self.assertEqual(result.returncode, 2)
        self.assertIn("令牌", result.stderr)

    def test_remote_without_allow_remote_is_refused(self) -> None:
        result = self._run("--endpoints", os.path.join(TOOLS, "endpoints.example.json"),
                           "--host", "0.0.0.0")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--allow-remote", result.stderr)


class PortalEndToEndTest(unittest.TestCase):
    """真端口 + 假病例系统：搜索 → 点选 → 采集 → 视图，全走 HTTP。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.his, cls.base = mock_his.make_server()
        cls.tmp = tempfile.TemporaryDirectory(prefix="portal-test-")
        session = collect.Session(base=cls.base, headers={"Cookie": "x-auth-token=test"}, proxy="")
        endpoints = collect.Endpoints.load(os.path.join(TOOLS, "endpoints.example.json"))
        cls.portal = portal.Portal(session, endpoints, cls.tmp.name, "2026-09-24")
        cls.server = portal.create_server(cls.portal, "127.0.0.1", 0)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.his.shutdown()
        cls.his.server_close()
        cls.tmp.cleanup()

    def _get(self, path: str) -> dict:
        with urllib.request.urlopen(self.url + path, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))

    def _post(self, path: str, body: dict) -> dict:
        request = urllib.request.Request(
            self.url + path, data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))

    def _collect(self, candidate: dict, refresh: bool = False, timeout: float = 60.0) -> dict:
        job_id = self._post("/api/collect", {**candidate, "refresh": refresh})["jobId"]
        deadline = time.time() + timeout
        while time.time() < deadline:
            job = self._get(f"/api/job?id={job_id}")
            if job["state"] in ("done", "failed"):
                self.assertEqual(job["state"], "done", job.get("error"))
                return job
            time.sleep(0.05)
        self.fail("采集任务超时")

    def test_page_and_health_are_served(self) -> None:
        with urllib.request.urlopen(self.url + "/", timeout=10) as response:
            page = response.read().decode("utf-8")
        self.assertIn("病例查询端口", page)
        health = self._get("/api/health")
        self.assertTrue(health["ok"])
        self.assertEqual(health["day"], "2026-09-24")
        self.assertIn("usage", health["dictionaries"])

    def test_every_asset_the_page_references_is_served(self) -> None:
        """页面是薄壳，所有东西都在它引用的文件里 —— 少发一个就是白屏（这类故障最难查）。"""
        with urllib.request.urlopen(self.url + "/", timeout=10) as response:
            page = response.read().decode("utf-8")
        referenced = {name for name in re.findall(r'(?:src|href)="([^"]+)"', page)
                      if not name.startswith(("http://", "https://", "//"))}
        self.assertTrue(referenced, "页面没有引用任何文件，薄壳是不是退回内联了？")
        for name in sorted(referenced):
            with urllib.request.urlopen(self.url + "/" + name.lstrip("/"), timeout=10) as response:
                body = response.read()
                self.assertEqual(response.status, 200, name)
                self.assertGreater(len(body), 200, f"{name} 内容太短，可能没发全")
        # 白名单之外不许读（这个服务手里有患者数据，别开目录穿越的口子）
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self._get("/portal.py")
        self.assertEqual(caught.exception.code, 404)

    def test_same_name_returns_every_candidate(self) -> None:
        """核心要求：重名的人全部列出来，由人点选；手机号只用来标注"就是他"。"""
        doc = self._get("/api/search?name=%E6%B5%8B%E8%AF%95%E7%94%B2")
        candidates = doc["candidates"]
        self.assertEqual(len(candidates), 2)
        self.assertTrue(all(row["name"] == "测试甲" for row in candidates))
        self.assertEqual(candidates[0]["telephoneMasked"], "138****0001")
        self.assertFalse(any(row["phoneMatch"] for row in candidates))
        # 页面只该拿到打码值：完整手机号/身份证不出服务端
        self.assertNotIn("telephone", candidates[0])
        self.assertNotIn("identityCard", candidates[0])

        matched = self._get("/api/search?name=%E6%B5%8B%E8%AF%95%E7%94%B2&telephone=13900000009")["candidates"]
        self.assertTrue(matched[0]["phoneMatch"])          # 一致的排最前
        self.assertEqual(matched[0]["telephoneMasked"], "139****0009")

    def test_empty_name_is_refused(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self._get("/api/search?name=")
        self.assertEqual(caught.exception.code, 400)
        self.assertIn("姓名", json.loads(caught.exception.read().decode("utf-8"))["error"])

    def test_collect_returns_a_full_view(self) -> None:
        candidates = self._get("/api/search?name=%E6%B5%8B%E8%AF%95%E7%94%B2&telephone=13800000001")["candidates"]
        target = candidates[0]
        job = self._collect(target)
        view = job["result"]
        self.assertFalse(job["cached"])
        self.assertEqual(view["patient"]["name"], "测试甲")
        self.assertEqual(view["patient"]["hisUserId"], mock_his.HIS_A)
        self.assertEqual(view["patient"]["hmsUserId"], mock_his.HMS_A)
        self.assertEqual(view["counts"]["visits"], 1)
        self.assertEqual(view["counts"]["prescriptions"], 2)
        self.assertEqual(view["counts"]["labs"], 1)
        self.assertEqual(view["counts"]["checkups"], 1)
        self.assertEqual(view["meta"]["errors"], [])
        self.assertTrue(view["labs"][0]["items"])

        # 指标身份优先用 itemCode：假系统里 血钾=K、总胆固醇=CHO、25-羟基维生素D=VITD
        names = {entry["name"]: entry for entry in view["abnormal"]}
        self.assertEqual(names["血钾"]["worst"], "crisis")          # 危急值模块与检验明细合并成一张卡
        self.assertEqual(names["总胆固醇"]["latest"]["verdict"], "high")
        self.assertEqual(names["25-羟基维生素D"]["latest"]["verdict"], "low")
        self.assertIn("血钾", [row["itemName"] for row in view["crises"]])

        # 处方留在就诊里，不进趋势
        self.assertIn("非布司他片", [row["itemName"] for row in view["prescriptions"]])
        self.assertNotIn("非布司他片", [entry["name"] for entry in view["trends"]])
        # 体检结论是"记录"，不进异常
        self.assertNotIn("高尿酸血症", [entry["name"] for entry in view["abnormal"]])

    def test_second_query_is_served_from_cache(self) -> None:
        candidates = self._get("/api/search?name=%E6%B5%8B%E8%AF%95%E7%94%B2&telephone=13800000001")["candidates"]
        self.assertTrue(self._collect(candidates[0])["cached"])
        self.assertFalse(self._collect(candidates[0], refresh=True)["cached"])

    def test_item_history_extends_the_series(self) -> None:
        candidates = self._get("/api/search?name=%E6%B5%8B%E8%AF%95%E7%94%B2&telephone=13800000001")["candidates"]
        target = candidates[0]
        self._collect(target)
        doc = self._get("/api/item-history?itemName=%E6%80%BB%E8%83%86%E5%9B%BA%E9%86%87"
                        f"&hmsUserId={target['hmsUserId']}&hisUserId={target['hisUserId']}")
        series = doc["series"]
        dates = {point["date"] for point in series["points"]}
        self.assertIn("2026-03-01", dates)          # 假系统里那条更早的历史点
        self.assertIn("2026-09-24", dates)
        self.assertGreaterEqual(len(series["numeric"]), 2)

    def test_missing_patient_id_is_refused(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self._post("/api/collect", {"name": "测试甲"})
        self.assertEqual(caught.exception.code, 502)

    def test_facts_land_on_disk_and_are_reused(self) -> None:
        candidates = self._get("/api/search?name=%E6%B5%8B%E8%AF%95%E4%B9%99")["candidates"]
        self._collect(candidates[0])
        path = os.path.join(self.tmp.name, "facts-2026-09-24.jsonl")
        self.assertTrue(os.path.exists(path))
        facts = [json.loads(line) for line in open(path, encoding="utf-8")]
        self.assertTrue(any(fact["patient"].get("hisUserId") == mock_his.HIS_B for fact in facts))
        # 同一个文件里两个人各是各的：视图只拿自己那些事实
        view = self._collect(candidates[0])["result"]
        self.assertEqual(view["patient"]["hisUserId"], mock_his.HIS_B)
        self.assertTrue(all(entry["key"] for entry in view["trends"]))


if __name__ == "__main__":
    unittest.main()
