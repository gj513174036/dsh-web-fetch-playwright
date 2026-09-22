"""tests/test_endpoints.py —— URL 模板化、去重合并、payload 形状与评分排序。"""

from __future__ import annotations

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from netdump.classify import ClassifyOptions  # noqa: E402
from netdump.endpoints import (  # noqa: E402
    SCORE_WEIGHTS,
    build_endpoints_document,
    describe_body,
    group_entries,
    parse_cookies,
    parse_query,
    parse_set_cookie,
    score_endpoint,
    templatize_path,
)
from netdump.har import Entry  # noqa: E402

REQUIRED_ENDPOINT_FIELDS = (
    "method",
    "urlTemplate",
    "sampleUrl",
    "requestHeaders",
    "query",
    "bodyShape",
    "callCount",
    "score",
)


class TemplatizeTest(unittest.TestCase):
    def test_numeric_segment_becomes_id(self):
        template, values = templatize_path("/v1/users/12345/profile")
        self.assertEqual(template, "/v1/users/{id}/profile")
        self.assertEqual(values, {"id": ["12345"]})

    def test_uuid_segment_becomes_uuid(self):
        template, values = templatize_path("/v1/objects/3f2504e0-4f89-11d3-9a0c-0305e82c3301")
        self.assertEqual(template, "/v1/objects/{uuid}")
        self.assertEqual(values["uuid"], ["3f2504e0-4f89-11d3-9a0c-0305e82c3301"])

    def test_long_hex_becomes_hash(self):
        template, values = templatize_path("/v1/files/9f8e7d6c5b4a3210ff")
        self.assertEqual(template, "/v1/files/{hash}")
        self.assertEqual(values["hash"], ["9f8e7d6c5b4a3210ff"])

    def test_short_tokens_are_not_templated(self):
        template, values = templatize_path("/v1/build/abc123/2024")
        self.assertEqual(template, "/v1/build/abc123/{id}")
        self.assertEqual(values, {"id": ["2024"]})
        template, _ = templatize_path("/v1/version/v1.2.3/notes")
        self.assertEqual(template, "/v1/version/v1.2.3/notes")
        template, _ = templatize_path("/v1/hex/abcdef")
        self.assertEqual(template, "/v1/hex/abcdef")

    def test_repeated_placeholders_get_suffixes(self):
        template, values = templatize_path("/v1/orgs/12/users/34")
        self.assertEqual(template, "/v1/orgs/{id}/users/{id2}")
        self.assertEqual(values, {"id": ["12"], "id2": ["34"]})

    def test_trailing_slash_and_empty_path(self):
        self.assertEqual(templatize_path("")[0], "/")
        self.assertEqual(templatize_path("/")[0], "/")
        self.assertEqual(templatize_path("/v1/items/")[0], "/v1/items/")


class ParseHelpersTest(unittest.TestCase):
    def test_parse_query(self):
        self.assertEqual(parse_query("https://x/a?page=2&size=20"), {"page": "2", "size": "20"})
        self.assertEqual(parse_query("https://x/a?flag&flag2=1"), {"flag": "", "flag2": "1"})
        self.assertEqual(parse_query("https://x/a"), {})

    def test_parse_cookies(self):
        self.assertEqual(parse_cookies("session=abc; csrf=zz9"), {"session": "abc", "csrf": "zz9"})
        self.assertEqual(parse_cookies(""), {})

    def test_parse_set_cookie_drops_attributes(self):
        self.assertEqual(
            parse_set_cookie("theme=dark; Path=/; HttpOnly\nlang=zh; Path=/; Max-Age=3600"),
            {"theme": "dark", "lang": "zh"},
        )
        self.assertEqual(parse_set_cookie(""), {})

    def test_describe_body_json(self):
        shape = describe_body('{"a":1,"b":"x","c":[{"d":true}],"e":{"f":null}}', "application/json")
        self.assertEqual(shape["kind"], "json")
        self.assertEqual(shape["fields"]["a"], "integer")
        self.assertEqual(shape["fields"]["b"], "string")
        self.assertEqual(shape["fields"]["c"]["kind"], "array")
        self.assertEqual(shape["fields"]["c"]["items"]["d"], "boolean")
        self.assertEqual(shape["fields"]["e"]["f"], "null")

    def test_describe_body_form_and_text(self):
        self.assertEqual(
            describe_body("user=demo&pass=s3cr3t", "application/x-www-form-urlencoded")["kind"], "form"
        )
        self.assertEqual(
            describe_body("user=demo&pass=s3cr3t", "application/x-www-form-urlencoded")["fields"],
            {"user": "string", "pass": "string"},
        )
        text_shape = describe_body("plain payload", "text/plain")
        self.assertEqual(text_shape["kind"], "text")
        self.assertEqual(text_shape["length"], len("plain payload"))
        self.assertEqual(describe_body("", "application/json"), {})


class GroupingTest(unittest.TestCase):
    def test_dedupe_key_is_method_host_template(self):
        entries = [
            Entry(method="GET", url="https://api.example.com/v1/users/1/profile", resourceType="xhr"),
            Entry(method="GET", url="https://api.example.com/v1/users/2/profile", resourceType="xhr"),
            Entry(method="GET", url="https://api.example.com/v1/users/3/profile", resourceType="xhr"),
            Entry(method="DELETE", url="https://api.example.com/v1/users/1/profile", resourceType="xhr"),
            Entry(method="GET", url="https://other.example.com/v1/users/1/profile", resourceType="xhr"),
        ]
        groups = group_entries(entries)
        self.assertEqual(len(groups), 3)
        merged = [g for g in groups if g.path_template == "/v1/users/{id}/profile" and g.method == "GET" and g.host == "api.example.com"][0]
        self.assertEqual(merged.call_count, 3)

    def test_merge_headers_cookies_and_variants(self):
        entries = [
            Entry(
                method="GET",
                url="https://api.example.com/v1/users/1/profile",
                resourceType="xhr",
                requestHeaders={
                    "Authorization": "Bearer t",
                    "Cookie": "session=abc; csrf=zz9",
                    "x-request-id": "r-1",
                    "content-length": "123",
                    ":authority": "api.example.com",
                },
                responseHeaders={"Set-Cookie": "theme=dark; Path=/"},
            ),
            Entry(
                method="GET",
                url="https://api.example.com/v1/users/2/profile",
                resourceType="xhr",
                requestHeaders={
                    "Authorization": "Bearer t",
                    "Cookie": "session=abc; extra=1",
                    "x-request-id": "r-2",
                    "x-tenant": "acme",
                },
                responseHeaders={"Set-Cookie": "lang=zh; Path=/"},
            ),
        ]
        group = group_entries(entries)[0]
        endpoint = None
        document = build_endpoints_document(entries)
        endpoint = document["endpoints"][0]
        self.assertEqual(endpoint["requestHeaders"]["Authorization"], "Bearer t")
        self.assertEqual(endpoint["requestHeaders"]["x-tenant"], "acme")
        self.assertNotIn("content-length", {k.lower() for k in endpoint["requestHeaders"]})
        self.assertNotIn(":authority", endpoint["requestHeaders"])
        self.assertEqual(endpoint["headerVariants"]["x-request-id"], ["r-1", "r-2"])
        self.assertEqual(endpoint["cookies"], {"session": "abc", "csrf": "zz9", "extra": "1"})
        self.assertEqual(endpoint["setCookies"], {"theme": "dark", "lang": "zh"})
        self.assertEqual(endpoint["callCount"], 2)
        self.assertEqual(endpoint["sampleUrls"], entries[0].url and [e.url for e in entries])
        self.assertEqual(group.call_count, 2)

    def test_merge_query_and_body_shape(self):
        entries = [
            Entry(
                method="GET",
                url="https://api.example.com/v1/items?page=1&size=20",
                resourceType="xhr",
                responseMimeType="application/json",
            ),
            Entry(
                method="GET",
                url="https://api.example.com/v1/items?page=2&size=20&sort=desc",
                resourceType="xhr",
                responseMimeType="application/json",
            ),
        ]
        endpoint = build_endpoints_document(entries)["endpoints"][0]
        self.assertEqual(endpoint["urlTemplate"], "https://api.example.com/v1/items")
        self.assertEqual(endpoint["query"], {"page": "1", "size": "20", "sort": "desc"})
        self.assertEqual(endpoint["queryParams"], ["page", "size", "sort"])
        self.assertEqual(endpoint["bodyShape"], {})

        post = build_endpoints_document(
            [
                Entry(
                    method="POST",
                    url="https://api.example.com/v1/orders",
                    resourceType="fetch",
                    requestHeaders={"Content-Type": "application/json"},
                    postData='{"sku":"A-1","qty":2}',
                    responseMimeType="application/json",
                )
            ]
        )["endpoints"][0]
        self.assertEqual(post["sampleBody"], '{"sku":"A-1","qty":2}')
        self.assertEqual(post["bodyShape"]["kind"], "json")
        self.assertEqual(post["bodyShape"]["fields"], {"sku": "string", "qty": "integer"})
        self.assertEqual(post["contentType"], "application/json")

    def test_path_params_are_collected(self):
        entries = [
            Entry(method="GET", url=f"https://api.example.com/v1/users/{value}/profile", resourceType="xhr")
            for value in ("1", "2", "3", "4", "5", "6")
        ]
        endpoint = build_endpoints_document(entries)["endpoints"][0]
        self.assertEqual(endpoint["pathParams"], {"id": ["1", "2", "3", "4", "5"]})
        self.assertEqual(endpoint["callCount"], 6)


class ScoringTest(unittest.TestCase):
    def _document(self, entries):
        return build_endpoints_document(entries)

    def test_score_factors_explain_ranking(self):
        entries = [
            Entry(
                method="POST",
                url="https://api.example.com/v1/orders",
                resourceType="fetch",
                responseMimeType="application/json",
                requestHeaders={"Authorization": "Bearer t", "Cookie": "session=abc"},
                postData='{"sku":"A"}',
            ),
            Entry(method="GET", url="https://api.example.com/health", resourceType="other", responseMimeType="text/plain"),
        ]
        document = self._document(entries)
        best = document["endpoints"][0]
        self.assertTrue(best["sampleUrl"].endswith("/v1/orders"))
        for factor, points in (
            ("resource-type:fetch", 30),
            ("json-response", 25),
            ("write-request-with-body", 20),
            ("authorization-header", 15),
            ("cookie-header", 10),
        ):
            self.assertIn({"factor": factor, "points": points}, best["scoreFactors"])
        self.assertEqual(best["score"], sum(item["points"] for item in best["scoreFactors"]))
        self.assertIn("score=", best["rankReason"])
        self.assertIn("json-response", best["rankReason"])
        self.assertEqual(document["scoreModel"]["sortKey"], "score desc, callCount desc, method asc, urlTemplate asc")
        self.assertEqual(document["scoreModel"]["weights"], SCORE_WEIGHTS)

    def test_endpoints_are_sorted_and_repeat_calls_add_points(self):
        entries = [
            Entry(method="GET", url="https://api.example.com/v1/low", resourceType="other", responseMimeType="text/plain", requestHeaders={"Authorization": "Bearer t"}),
            Entry(method="GET", url="https://api.example.com/v1/high/1", resourceType="xhr", responseMimeType="application/json"),
            Entry(method="GET", url="https://api.example.com/v1/high/2", resourceType="xhr", responseMimeType="application/json"),
            Entry(method="GET", url="https://api.example.com/v1/high/3", resourceType="xhr", responseMimeType="application/json"),
        ]
        document = self._document(entries)
        scores = [item["score"] for item in document["endpoints"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        high = document["endpoints"][0]
        self.assertEqual(high["callCount"], 3)
        self.assertIn({"factor": "repeated-calls:x3", "points": 10}, high["scoreFactors"])

    def test_every_endpoint_exposes_required_fields(self):
        document = self._document(
            [Entry(method="GET", url="https://api.example.com/v1/things/7", resourceType="xhr", responseMimeType="application/json")]
        )
        for endpoint in document["endpoints"]:
            for field in REQUIRED_ENDPOINT_FIELDS:
                self.assertIn(field, endpoint, field)
            self.assertIsInstance(endpoint["query"], dict)
            self.assertIsInstance(endpoint["bodyShape"], dict)
            self.assertIsInstance(endpoint["scoreFactors"], list)
            self.assertTrue(endpoint["rankReason"])

    def test_score_endpoint_weights_single_group(self):
        group = group_entries(
            [Entry(method="GET", url="https://api.example.com/v1/a", resourceType="xhr", responseMimeType="application/json")]
        )[0]
        score, factors, reason = score_endpoint(group)
        self.assertEqual(score, 55)
        self.assertEqual(len(factors), 2)
        self.assertIn("resource-type:xhr(+30)", reason)
        self.assertIn("json-response(+25)", reason)


class DocumentTest(unittest.TestCase):
    def test_document_metadata_and_partitions(self):
        entries = [
            Entry(method="GET", url="https://api.example.com/v1/a", resourceType="xhr"),
            Entry(method="GET", url="https://cdn.example.com/a.png", resourceType="image"),
            Entry(method="WS", url="wss://api.example.com/v1/stream/3", resourceType="websocket", wsFrames=[{"direction": "sent", "opcode": 1, "payload": "{}", "time": None}]),
        ]
        document = build_endpoints_document(entries, source={"path": "x.jsonl", "format": "jsonl", "entries": 3})
        self.assertEqual(document["schemaVersion"], "netdump/1")
        self.assertEqual(document["source"], {"path": "x.jsonl", "format": "jsonl", "entries": 3})
        self.assertEqual(document["summary"]["totalEntries"], 3)
        self.assertEqual(document["summary"]["endpoints"], 1)
        self.assertEqual(document["summary"]["websockets"], 1)
        self.assertEqual(document["summary"]["filtered"], 1)
        self.assertEqual(document["summary"]["hosts"], ["api.example.com"])
        self.assertEqual([item["url"] for item in document["filtered"]], ["https://cdn.example.com/a.png"])
        self.assertTrue(document["filtered"][0]["reason"].startswith("static-resource-type"))
        self.assertNotIn("wss://", [item["urlTemplate"] for item in document["endpoints"]])
        self.assertEqual(document["websockets"][0]["pathTemplate"], "/v1/stream/{id}")
        self.assertEqual(document["websockets"][0]["sentFrames"], 1)
        self.assertEqual(document["websockets"][0]["frameCount"], 1)
        self.assertEqual(document["websockets"][0]["sampleFrames"][0]["payload"], "{}")
        json.dumps(document)  # 整份文档必须可 JSON 序列化

    def test_include_static_flag_keeps_assets_and_documents(self):
        entries = [
            Entry(method="GET", url="https://cdn.example.com/a.css", resourceType="stylesheet"),
            Entry(method="GET", url="https://www.example.com/", resourceType="document", responseMimeType="text/html"),
        ]
        document = build_endpoints_document(
            entries, options=ClassifyOptions(include_static=True, include_documents=True)
        )
        templates = {item["urlTemplate"] for item in document["endpoints"]}
        self.assertIn("https://cdn.example.com/a.css", templates)
        self.assertIn("https://www.example.com/", templates)
        self.assertEqual(document["summary"]["filtered"], 0)

    def test_crawl_defaults_are_embedded(self):
        document = build_endpoints_document(
            [Entry(method="GET", url="https://api.example.com/v1/a", resourceType="xhr")],
            crawl_defaults={"concurrency": 16, "proxies": ["socks5://127.0.0.1:1080"]},
        )
        self.assertEqual(document["crawlDefaults"]["concurrency"], 16)


if __name__ == "__main__":
    unittest.main()
