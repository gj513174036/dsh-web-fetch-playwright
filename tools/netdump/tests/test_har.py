"""tests/test_har.py —— HAR 1.2 与插件 JSONL 事件流解析的统一性/容错性。"""

from __future__ import annotations

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from netdump.har import (  # noqa: E402
    Entry,
    detect_format,
    load_entries,
    load_entries_from_text,
    normalize_headers,
    parse_har,
    parse_jsonl,
)

FIXTURES = os.path.join(ROOT, "fixtures")
HAR_FIXTURE = os.path.join(FIXTURES, "sample.har")
JSONL_FIXTURE = os.path.join(FIXTURES, "sample.jsonl")

#: 契约字段（缺一不可，多出来的辅助字段不影响契约）。
CONTRACT_FIELDS = (
    "method",
    "url",
    "status",
    "requestHeaders",
    "responseHeaders",
    "postData",
    "responseMimeType",
    "resourceType",
    "durationMs",
    "wsFrames",
)


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()


def entry_by_url(entries, predicate):
    for entry in entries:
        if predicate(entry):
            return entry
    raise AssertionError("no matching entry")


class HarFixtureTest(unittest.TestCase):
    def setUp(self):
        self.entries, self.fmt = load_entries(HAR_FIXTURE)

    def test_fixture_is_har_and_keeps_all_entries(self):
        self.assertEqual(self.fmt, "har")
        with open(HAR_FIXTURE, encoding="utf-8") as handle:
            document = json.loads(handle.read())
        self.assertEqual(document["log"]["version"], "1.2")
        self.assertEqual(len(self.entries), len(document["log"]["entries"]))

    def test_every_entry_exposes_contract_fields(self):
        for entry in self.entries:
            for name in CONTRACT_FIELDS:
                self.assertTrue(hasattr(entry, name), f"{entry.url} missing {name}")
            self.assertIsInstance(entry.requestHeaders, dict)
            self.assertIsInstance(entry.responseHeaders, dict)
            self.assertIsInstance(entry.wsFrames, list)
            self.assertIsInstance(entry.durationMs, float)

    def test_har_entry_details(self):
        entry = entry_by_url(self.entries, lambda e: e.url.endswith("/v1/users/12345/profile"))
        self.assertEqual(entry.method, "GET")
        self.assertEqual(entry.status, 200)
        self.assertEqual(entry.resourceType, "xhr")
        self.assertEqual(entry.responseMimeType, "application/json")
        self.assertEqual(entry.durationMs, 31.2)
        self.assertEqual(entry.header("authorization"), "Bearer eyJhbGciOiJIUzI1NiJ9.demo.signature")
        self.assertEqual(entry.header("x-request-id"), "r-0001")
        self.assertIn("session=abc123", entry.header("cookie"))
        self.assertEqual(entry.postData, "")
        self.assertIn("Ada", entry.responseBody)
        self.assertEqual(entry.host, "api.example.com")
        self.assertEqual(entry.path, "/v1/users/12345/profile")
        self.assertEqual(entry.scheme, "https")
        self.assertEqual(entry.startedDateTime, "2024-03-01T10:00:06.000Z")

    def test_post_body_and_mime_from_har_postdata(self):
        entry = entry_by_url(self.entries, lambda e: e.method == "POST" and e.url.endswith("/v1/orders"))
        self.assertEqual(entry.status, 201)
        self.assertEqual(entry.resourceType, "fetch")
        self.assertIn('"sku":"A-1"', entry.postData)
        self.assertEqual(entry.header("content-type"), "application/json")

    def test_header_variants_are_preserved_per_entry(self):
        first = entry_by_url(self.entries, lambda e: e.header("x-request-id") == "r-0001")
        second = entry_by_url(self.entries, lambda e: e.header("x-request-id") == "r-0002")
        self.assertEqual(second.header("x-tenant"), "acme")
        self.assertEqual(first.header("x-tenant"), "")
        self.assertNotEqual(first.requestHeaders, second.requestHeaders)

    def test_websocket_frames(self):
        entry = entry_by_url(self.entries, lambda e: e.resourceType == "websocket")
        self.assertEqual(entry.scheme, "wss")
        self.assertEqual([frame["direction"] for frame in entry.wsFrames], ["sent", "received", "received"])
        self.assertEqual(entry.wsFrames[0]["opcode"], 1)
        self.assertIn("subscribe", entry.wsFrames[0]["payload"])

    def test_entry_to_dict_roundtrip(self):
        payload = self.entries[0].to_dict()
        for name in CONTRACT_FIELDS:
            self.assertIn(name, payload)


class HarVariantsTest(unittest.TestCase):
    def test_accepts_log_entries_list_and_single_entry(self):
        entry = {
            "startedDateTime": "2024-03-01T10:00:00.000Z",
            "time": 12.5,
            "request": {"method": "GET", "url": "https://api.example.com/v1/a", "headers": [{"name": "X", "value": "1"}]},
            "response": {"status": 200, "headers": [], "content": {"mimeType": "application/json", "text": "{}"}},
            "_resourceType": "xhr",
        }
        self.assertEqual(len(parse_har({"log": {"version": "1.2", "entries": [entry]}})), 1)
        self.assertEqual(len(parse_har({"entries": [entry]})), 1)
        self.assertEqual(len(parse_har([entry])), 1)
        self.assertEqual(len(parse_har(entry)), 1)
        self.assertEqual(len(parse_har(json.dumps({"log": {"entries": [entry]}}))), 1)

    def test_har_postdata_params_are_serialized(self):
        document = {
            "log": {
                "entries": [
                    {
                        "request": {
                            "method": "POST",
                            "url": "https://api.example.com/login",
                            "headers": [],
                            "postData": {
                                "mimeType": "application/x-www-form-urlencoded",
                                "params": [
                                    {"name": "user", "value": "demo"},
                                    {"name": "pass", "value": "s3cr3t"},
                                ],
                            },
                        },
                        "response": {"status": 200, "headers": [], "content": {"mimeType": "application/json"}},
                    }
                ]
            }
        }
        entry = parse_har(document)[0]
        self.assertEqual(entry.postData, "user=demo&pass=s3cr3t")

    def test_infer_resource_type_fallbacks(self):
        document = {
            "log": {
                "entries": [
                    {
                        "request": {"method": "GET", "url": "https://cdn.example.com/img/a.png", "headers": []},
                        "response": {"status": 200, "headers": [], "content": {"mimeType": "image/png"}},
                    },
                    {
                        "request": {"method": "GET", "url": "https://api.example.com/v2/graphql", "headers": []},
                        "response": {"status": 200, "headers": [], "content": {"mimeType": "application/json; charset=utf-8"}},
                    },
                ]
            }
        }
        entries = parse_har(document)
        self.assertEqual(entries[0].resourceType, "image")
        self.assertEqual(entries[1].resourceType, "xhr")


class HeaderNormalizationTest(unittest.TestCase):
    def test_dict_list_pairs_and_string(self):
        self.assertEqual(normalize_headers({"A": "1"}), {"A": "1"})
        self.assertEqual(normalize_headers([{"name": "A", "value": "1"}]), {"A": "1"})
        self.assertEqual(normalize_headers([["A", "1"]]), {"A": "1"})
        self.assertEqual(normalize_headers([("A", "1")]), {"A": "1"})
        self.assertEqual(normalize_headers("A: 1\r\nB: 2"), {"A": "1", "B": "2"})
        self.assertEqual(normalize_headers(None), {})

    def test_duplicates_are_joined_and_case_insensitive_lookup(self):
        headers = normalize_headers(
            [{"name": "Accept", "value": "text/html"}, {"name": "accept", "value": "application/json"}]
        )
        self.assertEqual(headers, {"Accept": "text/html, application/json"})
        entry = Entry(requestHeaders=headers)
        self.assertEqual(entry.header("ACCEPT"), "text/html, application/json")

    def test_set_cookie_uses_newline_separator(self):
        headers = normalize_headers(
            [
                {"name": "Set-Cookie", "value": "a=1; Path=/"},
                {"name": "Set-Cookie", "value": "b=2; Path=/"},
            ]
        )
        self.assertEqual(headers["Set-Cookie"], "a=1; Path=/\nb=2; Path=/")


class JsonlFixtureTest(unittest.TestCase):
    def setUp(self):
        self.entries, self.fmt = load_entries(JSONL_FIXTURE)

    def test_fixture_is_jsonl(self):
        self.assertEqual(self.fmt, "jsonl")

    def test_cdp_events_are_paired_into_one_entry(self):
        matching = [e for e in self.entries if e.url.endswith("/v1/orders")]
        self.assertEqual(len(matching), 1, "requestWillBeSent/responseReceived/loadingFinished 必须配对成一条")
        entry = matching[0]
        self.assertEqual(entry.method, "POST")
        self.assertEqual(entry.status, 201)
        self.assertEqual(entry.resourceType, "fetch")
        self.assertEqual(entry.durationMs, 64.0)
        self.assertEqual(entry.responseMimeType, "application/json")
        self.assertIn('"sku":"B-9"', entry.postData)
        # requestWillBeSentExtraInfo 的 Cookie 也要合并进来
        self.assertIn("session=abc123", entry.header("cookie"))
        self.assertEqual(entry.header("accept"), "application/json")
        self.assertEqual(entry.header(":authority"), "", "HTTP/2 伪头不应进入抓包结果")
        self.assertIn("trace-1", entry.response_header("x-trace"))
        self.assertIn("Set-Cookie", entry.responseHeaders)
        # getResponseBody 发生在 loadingFinished 之后，必须写回同一条 entry
        self.assertIn("ord_88", entry.responseBody)
        self.assertEqual(entry.startedDateTime, "2024-03-09T16:00:00+00:00")

    def test_simplified_events(self):
        entry = entry_by_url(self.entries, lambda e: e.url.endswith("/v1/users/12345/profile"))
        self.assertEqual(entry.status, 200)
        self.assertEqual(entry.durationMs, 33.5)
        self.assertEqual(entry.resourceType, "xhr")
        self.assertEqual(entry.header("authorization"), "Bearer eyJhbGciOiJIUzI1NiJ9.cdp.signature")

    def test_flat_single_line_record(self):
        entry = entry_by_url(self.entries, lambda e: e.url.endswith("/v1/ping"))
        self.assertEqual(entry.method, "GET")
        self.assertEqual(entry.status, 204)
        self.assertEqual(entry.durationMs, 3.1)
        self.assertEqual(entry.resourceType, "xhr")
        self.assertIn("session=abc123", entry.header("cookie"))

    def test_websocket_channel_and_frames(self):
        entry = entry_by_url(self.entries, lambda e: e.url.startswith("wss://"))
        self.assertEqual(entry.method, "WS")
        self.assertEqual(entry.resourceType, "websocket")
        self.assertEqual(entry.status, 101)
        directions = [frame["direction"] for frame in entry.wsFrames]
        self.assertEqual(directions, ["sent", "received", "closed"])
        self.assertIn("subscribe", entry.wsFrames[0]["payload"])
        self.assertEqual(entry.header("cookie"), "session=abc123")

    def test_static_asset_event_is_still_parsed(self):
        entry = entry_by_url(self.entries, lambda e: "hero.png" in e.url)
        self.assertEqual(entry.resourceType, "image")
        self.assertEqual(entry.durationMs, 20.0)

    def test_mixed_har_entry_line_and_truncated_tail(self):
        entry = entry_by_url(self.entries, lambda e: "/v1/reports/" in e.url)
        self.assertEqual(entry.status, 200)
        self.assertEqual(entry.durationMs, 51.0)
        self.assertEqual(entry.header("authorization"), "Bearer eyJhbGciOiJIUzI1NiJ9.cdp.signature")
        # 末尾那行被截断的 JSON 不能抛异常，也不能产生幽灵记录
        self.assertFalse([e for e in self.entries if not e.url])

    def test_no_ghost_entries(self):
        self.assertEqual(len(self.entries), 6)
        for entry in self.entries:
            self.assertTrue(entry.url.startswith(("http", "ws")), entry.url)


class FormatDetectionTest(unittest.TestCase):
    def test_detects_har_and_jsonl_from_files(self):
        har_text = read_text(HAR_FIXTURE)
        jsonl_text = read_text(JSONL_FIXTURE)
        self.assertEqual(detect_format(har_text), "har")
        self.assertEqual(detect_format(jsonl_text), "jsonl")
        self.assertEqual(detect_format('\ufeff{"entries": []}'), "har")

    def test_invalid_inputs_raise(self):
        with self.assertRaises(ValueError):
            detect_format("")
        with self.assertRaises(ValueError):
            detect_format("42")
        with self.assertRaises(ValueError):
            load_entries_from_text("{}", fmt="nope")

    def test_forced_format(self):
        har_text = read_text(HAR_FIXTURE)
        entries, fmt = load_entries_from_text(har_text, fmt="har")
        self.assertEqual(fmt, "har")
        self.assertEqual(len(entries), 22)

    def test_jsonl_single_document_is_accepted(self):
        events = [{"kind": "request", "requestId": "a", "method": "GET", "url": "https://api.example.com/x"}]
        self.assertEqual(len(parse_jsonl(json.dumps(events))), 1)
        self.assertEqual(len(parse_jsonl(json.dumps(events[0]))), 1)
        self.assertEqual(parse_jsonl("   \n"), [])


if __name__ == "__main__":
    unittest.main()
