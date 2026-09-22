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
from netdump.har import Entry  # noqa: E402

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


if __name__ == "__main__":
    unittest.main()
