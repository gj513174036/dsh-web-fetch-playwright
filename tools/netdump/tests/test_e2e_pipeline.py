"""tests/test_e2e_pipeline.py —— fixture → endpoints.json + crawler.py 的端到端断言。

这是契约里「仓库内提交一个 HAR fixture，端到端测试断言 fixture → endpoints.json +
crawler.py 的生成结果」那条要求的落点：只用仓库里的 fixtures/sample.har 与
fixtures/sample.jsonl，走完整 CLI（build），再对产物做结构与内容断言。
"""

from __future__ import annotations

import ast
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from netdump.cli import main  # noqa: E402

FIXTURES = os.path.join(ROOT, "fixtures")
HAR_FIXTURE = os.path.join(FIXTURES, "sample.har")
JSONL_FIXTURE = os.path.join(FIXTURES, "sample.jsonl")

COOKIE_VALUE = "session=abc123; csrf=zz9"
TOKEN_VALUE = "Bearer eyJhbGciOiJIUzI1NiJ9.demo.signature"

STATIC_URLS = (
    "https://www.example.com/static/app.4f2a1b.js",
    "https://cdn.example.com/img/logo.png",
    "https://www.example.com/assets/site.css",
    "https://www.example.com/fonts/inter.woff2",
    "https://cdn.example.com/media/intro.mp4",
)


def header(headers, name, default=""):
    """endpoints.json 里的请求头保留抓包原始大小写，查找必须大小写不敏感。"""
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return default


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()


class PipelineHarTest(unittest.TestCase):
    """HAR fixture 的端到端产物断言。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.outdir = os.path.join(self.tmp.name, "netdump-out")
        code = main(["build", HAR_FIXTURE, "-o", self.outdir, "--quiet"])
        self.assertEqual(code, 0)
        self.document = json.loads(read_text(os.path.join(self.outdir, "endpoints.json")))
        self.crawler_path = os.path.join(self.outdir, "crawler.py")
        self.crawler_source = read_text(self.crawler_path)

    def endpoint(self, predicate):
        for item in self.document["endpoints"]:
            if predicate(item):
                return item
        raise AssertionError(f"endpoint not found: {predicate}")

    def test_source_metadata(self):
        self.assertEqual(self.document["schemaVersion"], "netdump/1")
        self.assertEqual(self.document["source"]["format"], "har")
        self.assertEqual(self.document["source"]["entries"], 22)
        self.assertEqual(self.document["summary"]["totalEntries"], 22)
        self.assertEqual(self.document["summary"]["endpoints"], 11)
        self.assertEqual(self.document["summary"]["websockets"], 1)
        self.assertEqual(self.document["summary"]["hosts"], ["api.example.com"])

    def test_static_assets_are_filtered_with_reasons(self):
        filtered = {item["url"]: item["reason"] for item in self.document["filtered"]}
        for url in STATIC_URLS:
            self.assertIn(url, filtered, url)
            self.assertTrue(filtered[url].startswith("static-"), filtered[url])
        self.assertEqual(filtered["https://www.example.com/"], "document-page")
        self.assertTrue(
            any(reason == "no-api-signal" for reason in filtered.values()),
            "无业务信号的 GET（/health、/legacy/report.csv）必须被过滤",
        )

    def test_merged_endpoint_keeps_headers_cookies_and_params(self):
        endpoint = self.endpoint(lambda item: item["urlTemplate"].endswith("/v1/users/{id}/profile"))
        self.assertEqual(endpoint["method"], "GET")
        self.assertEqual(endpoint["sampleUrl"], "https://api.example.com/v1/users/12345/profile")
        self.assertEqual(endpoint["callCount"], 2)
        self.assertEqual(endpoint["pathParams"], {"id": ["12345", "67890"]})
        self.assertEqual(header(endpoint["requestHeaders"], "authorization"), TOKEN_VALUE)
        self.assertEqual(header(endpoint["requestHeaders"], "cookie"), COOKIE_VALUE)
        self.assertEqual(header(endpoint["headerVariants"], "x-request-id"), ["r-0001", "r-0002"])
        self.assertEqual(endpoint["cookies"], {"session": "abc123", "csrf": "zz9"})
        self.assertEqual(endpoint["statuses"], {"200": 2})
        self.assertGreater(endpoint["durationMsAvg"], 0)
        self.assertIn("repeated-calls:x2", endpoint["rankReason"])

    def test_post_endpoint_payload_shape_and_count(self):
        endpoint = self.endpoint(lambda item: item["method"] == "POST" and item["pathTemplate"] == "/v1/orders")
        self.assertIn('"sku":"A-1"', endpoint["sampleBody"])
        self.assertEqual(endpoint["bodyShape"]["kind"], "json")
        self.assertEqual(endpoint["bodyShape"]["fields"]["sku"], "string")
        self.assertEqual(endpoint["bodyShape"]["fields"]["qty"], "integer")
        self.assertEqual(endpoint["bodyShape"]["fields"]["note"], "null")
        self.assertEqual(endpoint["bodyShape"]["fields"]["tags"]["kind"], "array")
        self.assertEqual(endpoint["bodyShape"]["fields"]["meta"]["source"], "string")
        self.assertEqual(endpoint["callCount"], 1)
        self.assertEqual(endpoint["contentType"], "application/json")

    def test_form_login_endpoint_keeps_plaintext_payload(self):
        endpoint = self.endpoint(lambda item: item["pathTemplate"] == "/v1/sessions")
        self.assertIn("password=s3cr3t-pass", endpoint["sampleBody"])
        self.assertEqual(endpoint["bodyShape"]["kind"], "form")
        self.assertEqual(endpoint["bodyShape"]["fields"], {"username": "string", "password": "string"})

    def test_query_and_templated_paths(self):
        items = self.endpoint(lambda item: item["pathTemplate"] == "/v1/items")
        self.assertEqual(items["query"], {"page": "2", "size": "20", "sort": "desc"})
        self.assertEqual(items["queryParams"], ["page", "size", "sort"])
        self.assertTrue(items["urlTemplate"].endswith("/v1/items"))
        self.assertIn(
            "/v1/files/{hash}",
            [item["pathTemplate"] for item in self.document["endpoints"]],
        )
        self.assertIn(
            "/v1/objects/{uuid}",
            [item["pathTemplate"] for item in self.document["endpoints"]],
        )

    def test_scoring_and_ordering(self):
        scores = [item["score"] for item in self.document["endpoints"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        for item in self.document["endpoints"]:
            self.assertEqual(item["score"], sum(factor["points"] for factor in item["scoreFactors"]))
            self.assertTrue(item["rankReason"].startswith(f"score={item['score']}"))
            self.assertTrue(item["scoreFactors"])
        top = self.document["endpoints"][0]
        self.assertEqual(top["method"], "POST")
        self.assertEqual(top["pathTemplate"], "/v1/orders")
        self.assertEqual(top["score"], 100)

    def test_websockets_are_not_in_http_endpoints(self):
        self.assertEqual(len(self.document["websockets"]), 1)
        channel = self.document["websockets"][0]
        self.assertEqual(channel["urlTemplate"], "wss://api.example.com/v1/stream/{id}")
        self.assertEqual(channel["sentFrames"], 1)
        self.assertEqual(channel["receivedFrames"], 2)
        self.assertEqual(channel["sampleFrames"][0]["direction"], "sent")
        self.assertNotIn("wss://", [item["urlTemplate"] for item in self.document["endpoints"]])

    def test_crawler_artifact_permissions_and_credentials(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.outdir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.crawler_path).st_mode), 0o600)
        self.assertEqual(
            stat.S_IMODE(os.stat(os.path.join(self.outdir, "endpoints.json")).st_mode), 0o600
        )
        self.assertIn(COOKIE_VALUE, self.crawler_source)
        self.assertIn(TOKEN_VALUE, self.crawler_source)
        head = "\n".join(self.crawler_source.splitlines()[:40])
        self.assertIn("SECURITY WARNING", head)
        self.assertIn("Cookie", head)

    def test_crawler_artifact_compiles_and_embeds_endpoints(self):
        result = subprocess.run(
            [sys.executable, "-m", "py_compile", self.crawler_path],
            capture_output=True,
            text=True,
            cwd=self.outdir,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        tree = ast.parse(self.crawler_source)
        embedded = None
        for node in tree.body:
            if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", "") == "ENDPOINTS":
                embedded = ast.literal_eval(node.value)
        self.assertEqual(embedded, self.document["endpoints"])

    def test_generated_crawler_dry_run_plan(self):
        result = subprocess.run(
            [sys.executable, self.crawler_path, "--dry-run", "-o", os.path.join(self.tmp.name, "r.jsonl")],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["endpoints"], 11)
        self.assertEqual(plan["targets"], 12)
        self.assertEqual(plan["proxyMode"], "direct")
        self.assertIn("GET https://api.example.com/v1/users/67890/profile", plan["targetsPreview"])
        self.assertIn("POST https://api.example.com/v1/sessions", plan["targetsPreview"])


class PipelineJsonlTest(unittest.TestCase):
    """插件 JSONL 事件流 fixture 的端到端产物断言。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.outdir = os.path.join(self.tmp.name, "out")
        code = main(["build", JSONL_FIXTURE, "-o", self.outdir, "--quiet"])
        self.assertEqual(code, 0)
        self.document = json.loads(read_text(os.path.join(self.outdir, "endpoints.json")))
        self.crawler_path = os.path.join(self.outdir, "crawler.py")

    def test_cdp_events_survive_to_endpoints_json(self):
        self.assertEqual(self.document["source"]["format"], "jsonl")
        self.assertEqual(self.document["source"]["entries"], 6)
        templates = {(item["method"], item["pathTemplate"]): item for item in self.document["endpoints"]}
        self.assertIn(("POST", "/v1/orders"), templates)
        orders = templates[("POST", "/v1/orders")]
        self.assertEqual(orders["statuses"], {"201": 1})
        self.assertEqual(orders["resourceType"], "fetch")
        self.assertIn('"sku":"B-9"', orders["sampleBody"])
        self.assertIn("session=abc123", header(orders["requestHeaders"], "cookie"))
        self.assertEqual(header(orders["requestHeaders"], "authorization"), "Bearer eyJhbGciOiJIUzI1NiJ9.cdp.signature")
        self.assertIn(("GET", "/v1/reports/{id}/summary"), templates)
        self.assertEqual(templates[("GET", "/v1/ping")]["statuses"], {"204": 1})

    def test_websocket_channel_from_jsonl(self):
        self.assertEqual(self.document["summary"]["websockets"], 1)
        channel = self.document["websockets"][0]
        self.assertEqual(channel["urlTemplate"], "wss://api.example.com/v1/stream/{id}")
        self.assertEqual(channel["frameCount"], 2)
        self.assertIn("session=abc123", header(channel["requestHeaders"], "cookie"))

    def test_jsonl_crawler_artifact_is_compilable_and_credentialed(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.crawler_path).st_mode), 0o600)
        result = subprocess.run(
            [sys.executable, "-m", "py_compile", self.crawler_path],
            capture_output=True,
            text=True,
            cwd=self.outdir,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        source = read_text(self.crawler_path)
        self.assertIn("Bearer eyJhbGciOiJIUzI1NiJ9.cdp.signature", source)
        # WebSocket 通道不是 httpx 可重放目标：只进 endpoints.json，不进生成脚本
        endpoints_json = read_text(os.path.join(self.outdir, "endpoints.json"))
        self.assertIn("subscribe", endpoints_json)
        self.assertIn("trades", endpoints_json)

    def test_summary_counts(self):
        self.assertEqual(self.document["summary"]["totalEntries"], 6)
        self.assertEqual(self.document["summary"]["endpoints"], 4)
        self.assertEqual(self.document["summary"]["filtered"], 1)
        self.assertEqual(self.document["filtered"][0]["reason"], "static-resource-type:image")


if __name__ == "__main__":
    unittest.main()
