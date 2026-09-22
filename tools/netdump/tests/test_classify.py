"""tests/test_classify.py —— 静态资源过滤与业务 API 候选判定。"""

from __future__ import annotations

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from netdump.classify import (  # noqa: E402
    DEFAULT_STATIC_EXTENSIONS,
    DEFAULT_STATIC_RESOURCE_TYPES,
    ClassifyOptions,
    api_signals,
    classify_entries,
    classify_entry,
    is_json_mime,
    is_static_asset,
    url_extension,
)
from netdump.endpoints import build_endpoints_document  # noqa: E402
from netdump.har import Entry, parse_har  # noqa: E402

CONTRACT_EXTENSIONS = (
    ".js",
    ".css",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
)


def entry(**kwargs):
    return Entry(**kwargs)


class StaticFilterTest(unittest.TestCase):
    def test_contract_extensions_are_filtered(self):
        for extension in CONTRACT_EXTENSIONS:
            with self.subTest(extension=extension):
                item = entry(
                    method="GET",
                    url=f"https://cdn.example.com/assets/bundle{extension}",
                    resourceType="other",
                    responseMimeType="text/plain",
                    status=200,
                )
                decision = classify_entry(item)
                self.assertFalse(decision.keep)
                self.assertEqual(decision.reason, f"static-extension:{extension}")

    def test_contract_extensions_are_part_of_defaults(self):
        for extension in CONTRACT_EXTENSIONS:
            self.assertIn(extension, DEFAULT_STATIC_EXTENSIONS)

    def test_contract_resource_types_are_filtered(self):
        for resource_type in ("image", "font", "media", "stylesheet", "script"):
            with self.subTest(resourceType=resource_type):
                item = entry(
                    method="GET",
                    url="https://cdn.example.com/assets/thing",
                    resourceType=resource_type,
                    responseMimeType="application/json",
                )
                decision = classify_entry(item)
                self.assertFalse(decision.keep, "静态资源类型必须过滤")
                self.assertEqual(decision.reason, f"static-resource-type:{resource_type}")

    def test_contract_resource_types_are_part_of_defaults(self):
        self.assertEqual(
            set(DEFAULT_STATIC_RESOURCE_TYPES), {"image", "font", "media", "stylesheet", "script"}
        )

    def test_extension_lookup_ignores_query_and_case(self):
        self.assertEqual(url_extension("https://x/A/B/PIC.PNG?v=2"), ".png")
        self.assertEqual(url_extension("https://x/a/b"), "")
        self.assertEqual(url_extension("https://x/"), "")

    def test_is_static_asset_reasons(self):
        static, reason = is_static_asset(entry(url="https://x/a/app.js", resourceType="other"))
        self.assertTrue(static)
        self.assertEqual(reason, "static-extension:.js")
        static, reason = is_static_asset(entry(url="https://x/a/app", resourceType="script"))
        self.assertTrue(static)
        self.assertEqual(reason, "static-resource-type:script")
        static, reason = is_static_asset(entry(url="https://x/api/orders", resourceType="xhr"))
        self.assertFalse(static)
        self.assertEqual(reason, "")

    def test_static_extension_with_json_response_is_kept(self):
        # 伪装成图片后缀、实际返回 JSON 的接口不能被丢掉
        item = entry(
            method="GET",
            url="https://api.example.com/api/report.png",
            resourceType="other",
            responseMimeType="application/json",
        )
        decision = classify_entry(item)
        self.assertTrue(decision.keep)
        self.assertEqual(decision.reason, "api-over-static-extension")
        self.assertIn("static-extension-overridden", decision.signals)

    def test_include_static_option_keeps_assets(self):
        item = entry(url="https://cdn.example.com/assets/app.js", resourceType="script")
        self.assertFalse(classify_entry(item).keep)
        decision = classify_entry(item, ClassifyOptions(include_static=True))
        self.assertTrue(decision.keep)
        self.assertEqual(decision.kind, "http")


class KeepRulesTest(unittest.TestCase):
    def test_xhr_and_fetch_resource_types_are_kept(self):
        for resource_type in ("xhr", "fetch"):
            with self.subTest(resourceType=resource_type):
                item = entry(url="https://api.example.com/v1/thing", resourceType=resource_type, responseMimeType="text/plain")
                decision = classify_entry(item)
                self.assertTrue(decision.keep)
                self.assertIn(f"resource-type:{resource_type}", decision.signals)

    def test_json_responses_are_kept(self):
        for mime in (
            "application/json",
            "application/json; charset=utf-8",
            "application/vnd.api+json",
            "text/json",
        ):
            with self.subTest(mime=mime):
                item = entry(url="https://api.example.com/v1/thing", resourceType="other", responseMimeType=mime)
                decision = classify_entry(item)
                self.assertTrue(decision.keep)
                self.assertIn("json-response", decision.signals)

    def test_json_body_is_a_fallback_signal(self):
        item = entry(
            url="https://api.example.com/v1/thing",
            resourceType="other",
            responseBody='{"ok":true}',
        )
        self.assertTrue(classify_entry(item).keep)
        self.assertIn("json-response", api_signals(item))

    def test_credentials_headers_are_kept(self):
        auth = entry(
            url="https://api.example.com/v1/me",
            resourceType="other",
            responseMimeType="text/plain",
            requestHeaders={"Authorization": "Bearer token"},
        )
        cookie = entry(
            url="https://api.example.com/v1/me",
            resourceType="other",
            responseMimeType="text/plain",
            requestHeaders={"Cookie": "session=abc"},
        )
        self.assertTrue(classify_entry(auth).keep)
        self.assertIn("authorization-header", api_signals(auth))
        self.assertTrue(classify_entry(cookie).keep)
        self.assertIn("cookie-header", api_signals(cookie))

    def test_write_request_with_body_is_kept(self):
        item = entry(
            method="POST",
            url="https://api.example.com/v1/thing",
            resourceType="other",
            responseMimeType="text/plain",
            postData="a=1",
        )
        decision = classify_entry(item)
        self.assertTrue(decision.keep)
        self.assertIn("write-request-with-body", decision.signals)

    def test_get_with_body_is_not_a_signal(self):
        item = entry(
            method="GET",
            url="https://api.example.com/v1/thing",
            resourceType="other",
            responseMimeType="text/plain",
            postData="a=1",
        )
        self.assertFalse(classify_entry(item).keep)
        self.assertEqual(classify_entry(item).reason, "no-api-signal")

    def test_plain_get_without_signal_is_filtered(self):
        item = entry(url="https://api.example.com/health", resourceType="other", responseMimeType="text/plain")
        decision = classify_entry(item)
        self.assertFalse(decision.keep)
        self.assertEqual(decision.reason, "no-api-signal")
        self.assertEqual(decision.signals, [])

    def test_is_json_mime(self):
        self.assertTrue(is_json_mime("application/json;charset=utf-8"))
        self.assertTrue(is_json_mime("application/hal+json"))
        self.assertFalse(is_json_mime("text/plain"))
        self.assertFalse(is_json_mime(""))


class DocumentsAndWebsocketsTest(unittest.TestCase):
    def test_document_pages_are_filtered_unless_opted_in(self):
        item = entry(
            url="https://www.example.com/",
            resourceType="document",
            responseMimeType="text/html",
            requestHeaders={"Cookie": "session=abc"},
        )
        decision = classify_entry(item)
        self.assertFalse(decision.keep)
        self.assertEqual(decision.reason, "document-page")
        kept = classify_entry(item, ClassifyOptions(include_documents=True))
        self.assertTrue(kept.keep)
        self.assertIn("cookie-header", kept.signals)

    def test_websocket_with_frames_is_kept_as_websocket_kind(self):
        item = entry(
            method="WS",
            url="wss://api.example.com/v1/stream/9",
            resourceType="websocket",
            wsFrames=[{"direction": "sent", "opcode": 1, "payload": "{}", "time": None}],
        )
        decision = classify_entry(item)
        self.assertTrue(decision.keep)
        self.assertEqual(decision.kind, "websocket")

    def test_websocket_without_frames_and_http_url_is_filtered(self):
        item = entry(method="WS", url="https://api.example.com/v1/stream", resourceType="websocket")
        decision = classify_entry(item)
        self.assertFalse(decision.keep)
        self.assertEqual(decision.reason, "websocket-without-frames")

    def test_websockets_can_be_disabled(self):
        item = entry(method="WS", url="wss://api.example.com/v1/stream", resourceType="websocket")
        decision = classify_entry(item, ClassifyOptions(include_websockets=False))
        self.assertFalse(decision.keep)
        self.assertEqual(decision.reason, "websocket-disabled")


class EdgeCasesTest(unittest.TestCase):
    def test_unsupported_scheme_and_empty_url(self):
        data_uri = entry(url="data:image/png;base64,AAAA", resourceType="other")
        self.assertEqual(classify_entry(data_uri).reason, "unsupported-scheme:data")
        blob = entry(url="blob:https://www.example.com/abc", resourceType="other")
        self.assertFalse(classify_entry(blob).keep)
        self.assertEqual(classify_entry(entry(url="")).reason, "empty-url")

    def test_classify_entries_partitions_input(self):
        entries = [
            entry(url="https://api.example.com/v1/a", resourceType="xhr"),
            entry(url="https://cdn.example.com/a.png", resourceType="image"),
            entry(url="https://api.example.com/health", resourceType="other", responseMimeType="text/plain"),
            entry(
                method="POST",
                url="https://api.example.com/v1/write",
                resourceType="other",
                postData='{"a":1}',
            ),
        ]
        kept, dropped = classify_entries(entries)
        self.assertEqual(len(kept), 2)
        self.assertEqual(len(dropped), 2)
        self.assertEqual([d.reason for d in dropped], ["static-resource-type:image", "no-api-signal"])

    def test_decision_to_dict_is_json_friendly(self):
        decision = classify_entry(entry(url="https://api.example.com/v1/a", resourceType="xhr"))
        payload = decision.to_dict()
        self.assertTrue(payload["keep"])
        self.assertEqual(payload["kind"], "http")
        self.assertEqual(payload["signals"], ["resource-type:xhr"])


def har_entry(url, mime, body="{}", rtype=None):
    """构造一条 HAR entry；``rtype`` 为 None 时故意不带 ``_resourceType``。"""
    raw = {
        "startedDateTime": "2024-03-05T09:00:00.000Z",
        "time": 12.0,
        "request": {
            "method": "GET",
            "url": url,
            "headers": [],
            "queryString": [],
            "cookies": [],
            "headersSize": -1,
            "bodySize": 0,
        },
        "response": {
            "status": 200,
            "statusText": "OK",
            "httpVersion": "HTTP/1.1",
            "headers": [{"name": "content-type", "value": mime}],
            "cookies": [],
            "content": {"size": len(body), "mimeType": mime, "text": body},
            "redirectURL": "",
            "headersSize": -1,
            "bodySize": len(body),
        },
        "cache": {},
        "timings": {"send": 0, "wait": 12, "receive": 0},
    }
    if rtype is not None:
        raw["_resourceType"] = rtype
    return parse_har({"log": {"version": "1.2", "entries": [raw]}})[0]


class StaticExtensionExceptionRegressionTest(unittest.TestCase):
    """F3 回归：HAR 不带 ``_resourceType`` 时，``api-over-static-extension`` 必须可达。

    正例：``.js`` + ``application/json`` + 无 ``_resourceType``（只能按后缀推断成
    script）→ 保留为业务 API 并标注 ``api-over-static-extension``。
    反例（同一测试内）：真脚本（``application/javascript`` 或抓包明确给出
    ``_resourceType=script``）仍必须被过滤，静态资源过滤不得被放宽。
    """

    def test_positive_js_json_is_kept_and_real_scripts_are_still_filtered(self):
        # ---- 正例：被静态后缀伪装的接口 ----------------------------------
        disguised = har_entry("https://api.example.com/v2/export/report.js", "application/json", '{"rows":[]}')
        # 复现 F3 的前提：har.py 只能按后缀把它推断成 script（弱证据）
        self.assertEqual(disguised.resourceType, "script")
        self.assertTrue(disguised.resourceTypeInferred)
        decision = classify_entry(disguised)
        self.assertTrue(decision.keep, "F3：伪装成 .js 的 JSON 接口被误杀")
        self.assertEqual(decision.reason, "api-over-static-extension")
        self.assertIn("json-response", decision.signals)
        self.assertIn("static-extension-overridden", decision.signals)
        document = build_endpoints_document([disguised])
        self.assertEqual(len(document["endpoints"]), 1)
        self.assertEqual(document["filtered"], [])
        endpoint = document["endpoints"][0]
        self.assertEqual(endpoint["urlTemplate"], "https://api.example.com/v2/export/report.js")
        self.assertIn("json-response", endpoint["rankReason"])
        self.assertNotIn("static-included", endpoint["rankReason"])

        # ---- 反例 1：真脚本，无 _resourceType（按后缀推断） ---------------
        real_script = har_entry("https://cdn.example.com/assets/app.js", "application/javascript", "console.log(1)")
        self.assertTrue(real_script.resourceTypeInferred)
        script_decision = classify_entry(real_script)
        self.assertFalse(script_decision.keep, "真脚本必须被过滤")
        self.assertEqual(script_decision.reason, "static-resource-type:script")

        # ---- 反例 2：抓包明确给出 _resourceType=script（强证据） ----------
        explicit = har_entry("https://cdn.example.com/assets/vendor.js", "application/json", '{"a":1}', rtype="script")
        self.assertFalse(explicit.resourceTypeInferred)
        explicit_decision = classify_entry(explicit)
        self.assertFalse(explicit_decision.keep, "显式 resourceType=script 即使返回 JSON 也必须过滤")
        self.assertEqual(explicit_decision.reason, "static-resource-type:script")

        # ---- 反例 3/4：其他静态资源不受影响 ------------------------------
        for url, mime, expected in (
            ("https://cdn.example.com/assets/theme.css", "text/css", "static-resource-type:stylesheet"),
            ("https://cdn.example.com/assets/logo.png", "image/png", "static-resource-type:image"),
        ):
            with self.subTest(url=url):
                asset = har_entry(url, mime, "x")
                self.assertFalse(classify_entry(asset).keep)
                self.assertEqual(classify_entry(asset).reason, expected)

        # ---- 汇总：只有伪装接口留下来 ------------------------------------
        document = build_endpoints_document([disguised, real_script, explicit])
        self.assertEqual([item["urlTemplate"] for item in document["endpoints"]], [disguised.url])
        self.assertEqual(
            sorted(item["reason"] for item in document["filtered"]),
            ["static-resource-type:script", "static-resource-type:script"],
        )

    def test_explicit_xhr_type_with_static_extension_is_kept(self):
        """明确类型是 xhr/fetch 时，静态后缀本来就走例外（既有行为不变）。"""
        entry = har_entry("https://api.example.com/v1/export.js", "application/json", "{}", rtype="xhr")
        decision = classify_entry(entry)
        self.assertTrue(decision.keep)
        self.assertEqual(decision.reason, "api-over-static-extension")

    def test_jsonl_style_records_without_type_keep_working(self):
        """插件 JSONL 路径：没有资源类型、只有后缀的记录行为不变（后缀即弱证据）。"""
        entry = Entry(
            url="https://api.example.com/v1/export.js",
            resourceType="",
            responseMimeType="application/json",
        )
        decision = classify_entry(entry)
        self.assertTrue(decision.keep)
        self.assertEqual(decision.reason, "api-over-static-extension")
        self.assertFalse(entry.resourceTypeInferred, "JSONL 路径不做后缀推断，provenance 保持默认")


if __name__ == "__main__":
    unittest.main()
