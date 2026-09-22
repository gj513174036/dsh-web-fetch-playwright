"""tests/test_emit.py —— 生成的 crawler.py：语法、能力、权限与凭据保留。"""

from __future__ import annotations

import ast
import importlib.util
import json
import os
import py_compile
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from netdump.emit import (  # noqa: E402
    DEFAULT_CRAWL_CONFIG,
    SECURITY_BANNER,
    emit_outputs,
    ensure_private_dir,
    render_crawler,
    write_private_text,
)
from netdump.endpoints import build_endpoints_document  # noqa: E402
from netdump.har import load_entries  # noqa: E402

HAR_FIXTURE = os.path.join(ROOT, "fixtures", "sample.har")
COOKIE_VALUE = "session=abc123; csrf=zz9"
TOKEN_VALUE = "Bearer eyJhbGciOiJIUzI1NiJ9.demo.signature"


def header_lookup(headers, name, default=""):
    """抓包里的头名大小写原样保留，查找必须大小写不敏感。"""
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return default


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()


def build_document(path=HAR_FIXTURE, crawl_defaults=None):
    entries, fmt = load_entries(path)
    return build_endpoints_document(
        entries,
        source={"path": path, "format": fmt, "entries": len(entries)},
        crawl_defaults=crawl_defaults,
    )


def extract_literal(source, name):
    """取出生成脚本里 ``NAME = <字面量>`` / ``NAME: T = <字面量>`` 的值。"""
    tree = ast.parse(source)
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(target, "id", "") == name for target in node.targets):
            return ast.literal_eval(node.value)
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", "") == name:
            return ast.literal_eval(node.value)
    raise AssertionError(f"assignment {name} not found in generated source")


class RenderCrawlerTest(unittest.TestCase):
    def setUp(self):
        self.document = build_document()
        self.source = render_crawler(self.document)

    def test_generated_code_compiles(self):
        compile(self.source, "crawler.py", "exec")

    def test_uses_httpx_async_client_with_http2_and_semaphore(self):
        self.assertIn("httpx_module.AsyncClient(http2=True", self.source)
        self.assertIn("asyncio.Semaphore", self.source)
        self.assertIn("import asyncio", self.source)
        self.assertIn("async with semaphore:", self.source, "Semaphore 必须真正包住发请求那一段")
        semaphore_line = self.source.index("async with semaphore:")
        request_line = self.source.index("response = await client.request")
        self.assertLess(semaphore_line, request_line)

    def test_exponential_backoff_retry(self):
        self.assertIn("def backoff_delay(", self.source)
        self.assertIn("base * (2 ** max(0, attempt - 1))", self.source)
        self.assertIn("random.uniform", self.source)
        self.assertIn("RETRY_STATUS", self.source)
        self.assertIn("retry-after", self.source)

    def test_jsonl_checkpoint_resume(self):
        self.assertIn("def load_done(", self.source)
        self.assertIn("def append_jsonl(", self.source)
        self.assertIn('os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600', self.source)
        self.assertIn("--no-resume", self.source)
        self.assertIn("record.get(\"key\")", self.source)

    def test_cli_flags_present(self):
        for flag in (
            "--proxy",
            "--proxies-file",
            "--concurrency",
            "--timeout",
            "--retries",
            "--dry-run",
            "--no-resume",
            "--out",
            "--endpoints",
            "--limit",
        ):
            self.assertIn(flag, self.source, flag)

    def test_proxy_rotation_implementation(self):
        self.assertIn("class ProxyPool", self.source)
        self.assertIn("itertools" if "itertools" in self.source else "self._index % len(self._proxies)", self.source)
        self.assertIn("stripped.startswith(\"#\")", self.source)
        self.assertIn("proxyMode", self.source)

    def test_security_banner_is_at_the_top_and_mentions_credentials(self):
        lines = self.source.splitlines()
        banner_lines = [index for index, line in enumerate(lines) if "SECURITY WARNING" in line]
        self.assertTrue(banner_lines, "缺少凭据敏感性警告")
        self.assertLess(banner_lines[0], 12, "警告必须出现在文件最前面")
        head = "\n".join(lines[:40])
        for needle in ("Cookie", "Token", "DO NOT COMMIT", "0600"):
            self.assertIn(needle, head, needle)
        self.assertIn(SECURITY_BANNER.strip().splitlines()[0], head)
        self.assertLess(head.find("SECURITY WARNING"), head.find("import argparse") if "import argparse" in head else 10**9)

    def test_credentials_are_hardcoded_verbatim(self):
        self.assertIn(COOKIE_VALUE, self.source)
        self.assertIn(TOKEN_VALUE, self.source)
        self.assertIn("s3cr3t-pass", self.source)

    def test_httpx_is_imported_lazily(self):
        self.assertIn("httpx = None", self.source)
        self.assertIn("def _load_httpx()", self.source)
        self.assertIn('pip install \\"httpx[http2,socks]\\"', self.source)
        header = self.source.split("GENERATED_AT =", 1)[0]
        self.assertNotIn("\nimport httpx", header)

    def test_embedded_endpoints_match_document(self):
        embedded = extract_literal(self.source, "ENDPOINTS")
        self.assertEqual(embedded, self.document["endpoints"])
        config = extract_literal(self.source, "DEFAULT_CONFIG")
        self.assertEqual(config["concurrency"], DEFAULT_CRAWL_CONFIG["concurrency"])
        self.assertEqual(config["timeout"], DEFAULT_CRAWL_CONFIG["timeout"])

    def test_overrides_are_embedded(self):
        source = render_crawler(
            self.document,
            overrides={"concurrency": 32, "timeout": 7.5, "retries": 5, "proxies": ["socks5://127.0.0.1:1080"]},
        )
        config = extract_literal(source, "DEFAULT_CONFIG")
        self.assertEqual(config["concurrency"], 32)
        self.assertEqual(config["timeout"], 7.5)
        self.assertEqual(config["retries"], 5)
        self.assertEqual(config["proxies"], ["socks5://127.0.0.1:1080"])
        compile(source, "crawler.py", "exec")

    def test_crawl_defaults_from_document_are_used(self):
        document = build_document(crawl_defaults={"concurrency": 64, "out": "custom.jsonl"})
        config = extract_literal(render_crawler(document), "DEFAULT_CONFIG")
        self.assertEqual(config["concurrency"], 64)
        self.assertEqual(config["out"], "custom.jsonl")

    def test_document_source_is_summarized_in_header(self):
        self.assertIn("sample.har", self.source)


#: 一个只够跑通生成脚本的假 httpx：记录并发峰值、代理、请求头与重试次数。
FAKE_HTTPX_SOURCE = '''"""测试用假 httpx（不联网）。"""
import asyncio
import json
import os

_REPORT = os.environ.get("FAKE_HTTPX_REPORT", "")
_LATENCY = float(os.environ.get("FAKE_HTTPX_LATENCY", "0.02"))
_503_FIRST = os.environ.get("FAKE_HTTPX_503_FIRST") == "1"
_STATE = {"active": 0, "maxActive": 0}
_COUNTS = {}


class Response:
    def __init__(self, status=200, text="{}", headers=None):
        self.status_code = status
        self.text = text
        self.headers = headers or {"content-type": "application/json"}


class AsyncClient:
    def __init__(self, **kwargs):
        self._kwargs = kwargs
        self._proxy = kwargs.get("proxy")

    async def request(self, method, url, headers=None, content=None):
        _STATE["active"] += 1
        _STATE["maxActive"] = max(_STATE["maxActive"], _STATE["active"])
        try:
            await asyncio.sleep(_LATENCY)
            count = _COUNTS.get(url, 0) + 1
            _COUNTS[url] = count
            status = 503 if (_503_FIRST and count == 1) else 200
            self._record(method, url, headers, content, status)
            return Response(
                status,
                '{"ok":true}',
                {"content-type": "application/json", "retry-after": "0"},
            )
        finally:
            _STATE["active"] -= 1

    async def aclose(self):
        pass

    def _record(self, method, url, headers, content, status):
        if not _REPORT:
            return
        payload = {
            "method": method,
            "url": url,
            "proxy": self._proxy,
            "headers": headers,
            "content": None if content is None else content.decode("utf-8"),
            "status": status,
            "maxActive": _STATE["maxActive"],
            "http2": self._kwargs.get("http2"),
        }
        with open(_REPORT, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\\n")
'''


def fake_httpx_module():
    return {"name": "httpx", "source": FAKE_HTTPX_SOURCE}


class PrivateOutputTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.outdir = os.path.join(self.tmp.name, "netdump-out")

    def test_emit_outputs_permissions_and_contents(self):
        document = build_document()
        outputs = emit_outputs(document, self.outdir, overrides={"concurrency": 4})
        self.assertTrue(os.path.isfile(outputs["crawlerPath"]))
        self.assertTrue(os.path.isfile(outputs["endpointsPath"]))
        self.assertEqual(stat.S_IMODE(os.stat(self.outdir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(outputs["crawlerPath"]).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(outputs["endpointsPath"]).st_mode), 0o600)
        self.assertEqual(json.loads(read_text(outputs["endpointsPath"]))["endpoints"], document["endpoints"])
        self.assertIn(COOKIE_VALUE, read_text(outputs["endpointsPath"]))
        py_compile.compile(outputs["crawlerPath"], cfile=os.path.join(self.tmp.name, "c.pyc"), doraise=True)

    def test_emit_outputs_can_skip_crawler(self):
        outputs = emit_outputs(build_document(), self.outdir, write_crawler=False)
        self.assertEqual(outputs["crawlerPath"], "")
        self.assertFalse(os.path.exists(os.path.join(self.outdir, "crawler.py")))

    def test_write_private_text_tightens_existing_permissions(self):
        path = os.path.join(self.tmp.name, "secret.txt")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("old")
        os.chmod(path, 0o644)
        write_private_text(path, "new-secret")
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(read_text(path), "new-secret")

    def test_ensure_private_dir_tightens_existing_directory(self):
        path = os.path.join(self.tmp.name, "wide")
        os.makedirs(path, mode=0o755)
        os.chmod(path, 0o755)
        ensure_private_dir(path)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o700)


class GeneratedCrawlerRuntimeTest(unittest.TestCase):
    """真的把生成的脚本当程序跑（不联网）：语法、CLI、断点续跑、缺依赖提示。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.outdir = os.path.join(self.tmp.name, "out")
        self.document = build_document()
        outputs = emit_outputs(self.document, self.outdir, overrides={"concurrency": 4})
        self.crawler_path = outputs["crawlerPath"]
        self.endpoints_path = outputs["endpointsPath"]
        self.results_path = os.path.join(self.tmp.name, "results.jsonl")
        self.blocked_dir = os.path.join(self.tmp.name, "blocked")
        os.makedirs(self.blocked_dir)
        write_private_text(
            os.path.join(self.blocked_dir, "httpx.py"),
            'raise ImportError("httpx blocked by test")\n',
        )

    def _run(self, *args, block_httpx=False, env_extra=None):
        env = dict(os.environ)
        if block_httpx:
            env["PYTHONPATH"] = self.blocked_dir
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            [sys.executable, self.crawler_path, *args],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )

    def test_py_compile_via_cli(self):
        result = subprocess.run(
            [sys.executable, "-m", "py_compile", self.crawler_path],
            capture_output=True,
            text=True,
            cwd=self.outdir,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_help_lists_documented_flags(self):
        result = self._run("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        for flag in ("--proxy", "--proxies-file", "--concurrency", "--timeout", "--dry-run", "--no-resume"):
            self.assertIn(flag, result.stdout, flag)

    def test_dry_run_works_without_httpx(self):
        result = self._run("--dry-run", "-o", self.results_path, block_httpx=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["endpoints"], len(self.document["endpoints"]))
        self.assertEqual(plan["targets"], len(self.document["endpoints"]) + 1)  # users/{id} 有两个 sampleUrl
        self.assertEqual(plan["pending"], plan["targets"])
        self.assertEqual(plan["alreadyDone"], 0)
        self.assertEqual(plan["proxyMode"], "direct")
        self.assertFalse(os.path.exists(self.results_path), "--dry-run 不应写结果文件")
        preview = plan["targetsPreview"]
        self.assertIn("POST https://api.example.com/v1/orders", preview)
        self.assertIn("GET https://api.example.com/v1/users/12345/profile", preview)

    def test_missing_httpx_gives_install_hint_and_exit_2(self):
        result = self._run("-o", self.results_path, block_httpx=True)
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("httpx", result.stderr)
        self.assertIn("pip install", result.stderr)
        if importlib.util.find_spec("httpx") is not None:  # 仅当环境里确实没有 httpx 时才算强证据
            self.skipTest("本机已安装 httpx，缺依赖分支由 PYTHONPATH 屏蔽验证")

    def test_proxy_rotation_and_proxies_file(self):
        proxies_file = os.path.join(self.tmp.name, "proxies.txt")
        write_private_text(
            proxies_file,
            "# 代理池\nsocks5://user:pass@127.0.0.1:1080\n\nhttp://127.0.0.1:8080\n",
        )
        result = self._run("--dry-run", "-o", self.results_path, "--proxies-file", proxies_file, block_httpx=True)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["proxies"], 2)
        self.assertEqual(plan["proxyMode"], "rotate")
        self.assertEqual(plan["concurrency"], 4)
        self.assertEqual(plan["timeout"], 30.0)

        single = self._run("--dry-run", "-o", self.results_path, "--proxy", "http://127.0.0.1:1", block_httpx=True)
        self.assertEqual(json.loads(single.stdout)["proxyMode"], "single")

    def test_jsonl_resume_skips_completed_and_repairs_partial_line(self):
        first_key = "POST https://api.example.com/v1/orders"
        with open(self.results_path, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"key": first_key, "status": 200}) + "\n")
            handle.write('{"key": "GET https://api.example.com/v1/items?pa')  # 模拟中断留下的半行
        result = self._run("--dry-run", "-o", self.results_path, block_httpx=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["alreadyDone"], 1)
        self.assertEqual(plan["pending"], plan["targets"] - 1)
        self.assertNotIn(first_key, plan["targetsPreview"])
        self.assertIn("已修复", result.stderr)
        repaired = read_text(self.results_path)
        self.assertEqual(len(repaired.strip().splitlines()), 1)
        self.assertIn(first_key, repaired)

    def test_no_resume_ignores_checkpoint(self):
        with open(self.results_path, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"key": "POST https://api.example.com/v1/orders"}) + "\n")
        result = self._run("--dry-run", "--no-resume", "-o", self.results_path, block_httpx=True)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["alreadyDone"], 0)
        self.assertFalse(plan["resume"])

    def test_external_endpoints_file_is_honored(self):
        result = self._run("--dry-run", "--endpoints", self.endpoints_path, "-o", self.results_path, block_httpx=True)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["endpoints"], len(self.document["endpoints"]))

    def test_expand_templates_uses_path_params(self):
        result = self._run(
            "--dry-run", "--expand-templates", "--limit", "50", "-o", self.results_path, block_httpx=True
        )
        plan = json.loads(result.stdout)
        self.assertIn("GET https://api.example.com/v1/users/12345/profile", plan["targetsPreview"])

    def test_limit_caps_targets(self):
        result = self._run("--dry-run", "--limit", "2", "-o", self.results_path, block_httpx=True)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["targets"], 2)
        self.assertEqual(plan["pending"], 2)


class GeneratedCrawlerBehaviorTest(unittest.TestCase):
    """用假 httpx 真跑生成脚本：并发闸门、代理轮换、重试、结果落盘与续跑。"""

    LATENCY = "0.05"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.outdir = os.path.join(self.tmp.name, "out")
        self.fake_dir = os.path.join(self.tmp.name, "fake")
        os.makedirs(self.fake_dir)
        write_private_text(os.path.join(self.fake_dir, "httpx.py"), FAKE_HTTPX_SOURCE)
        outputs = emit_outputs(build_document(), self.outdir)
        self.crawler_path = outputs["crawlerPath"]
        self.results_path = os.path.join(self.tmp.name, "results.jsonl")
        self.report_path = os.path.join(self.tmp.name, "requests.jsonl")

    def _run(self, *args, **env_extra):
        env = dict(os.environ)
        env["PYTHONPATH"] = self.fake_dir
        env["FAKE_HTTPX_REPORT"] = self.report_path
        env["FAKE_HTTPX_LATENCY"] = self.LATENCY
        env.update(env_extra)
        return subprocess.run(
            [sys.executable, self.crawler_path, "-o", self.results_path, *args],
            capture_output=True,
            text=True,
            env=env,
            timeout=120,
        )

    def _report(self):
        return [json.loads(line) for line in read_text(self.report_path).splitlines() if line.strip()]

    def _results(self):
        return [json.loads(line) for line in read_text(self.results_path).splitlines() if line.strip()]

    def test_concurrency_is_capped_and_results_are_written(self):
        result = self._run("--concurrency", "3", "--timeout", "5")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = self._report()
        self.assertEqual(len(report), 12, "12 个目标都应被请求")
        max_active = max(item["maxActive"] for item in report)
        self.assertLessEqual(max_active, 3, f"并发闸门失效：峰值 {max_active}")
        self.assertGreaterEqual(max_active, 2, "并发过低，闸门可能把请求串行化了")
        self.assertTrue(all(item["http2"] is True for item in report), "AsyncClient 必须开启 http2")

        records = self._results()
        self.assertEqual(records[0].get("$header", {}).get("schema"), "netdump/1")
        finished = [item for item in records if "key" in item]
        self.assertEqual(len(finished), 12)
        self.assertTrue(all(item["status"] == 200 for item in finished))
        self.assertEqual(stat.S_IMODE(os.stat(self.results_path).st_mode), 0o600)

    def test_request_headers_and_body_are_replayed_verbatim(self):
        result = self._run("--concurrency", "4")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = self._report()
        orders = [
            item
            for item in report
            if item["url"] == "https://api.example.com/v1/orders" and item["method"] == "POST"
        ][0]
        self.assertEqual(header_lookup(orders["headers"], "cookie"), COOKIE_VALUE)
        self.assertEqual(header_lookup(orders["headers"], "authorization"), TOKEN_VALUE)
        self.assertIn('"sku":"A-1"', orders["content"])
        profile = [item for item in report if item["url"].endswith("/v1/users/12345/profile")][0]
        self.assertEqual(header_lookup(profile["headers"], "authorization"), TOKEN_VALUE)
        self.assertNotIn("content-length", {key.lower() for key in orders["headers"]})
        self.assertNotIn("host", {key.lower() for key in orders["headers"]})

    def test_proxy_pool_rotates_across_targets(self):
        result = self._run(
            "--concurrency", "2",
            "--proxy", "socks5://user:pass@127.0.0.1:1080",
            "--proxy", "http://127.0.0.1:8080",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = self._report()
        proxies = {item["proxy"] for item in report}
        self.assertEqual(proxies, {"socks5://user:pass@127.0.0.1:1080", "http://127.0.0.1:8080"})
        records = [item for item in self._results() if "key" in item]
        self.assertTrue(all(item["proxy"] for item in records))

    def test_retry_with_backoff_then_success(self):
        result = self._run("--concurrency", "4", "--retries", "1", FAKE_HTTPX_503_FIRST="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        records = [item for item in self._results() if "key" in item]
        self.assertEqual(len(records), 12)
        for item in records:
            self.assertEqual(item["status"], 200)
            self.assertEqual(item["attempts"], 2, "第一次 503 后应重试一次")
        self.assertIn("retry 1/1", result.stderr)

    def test_missing_proxies_file_is_a_friendly_error(self):
        result = self._run("--proxies-file", os.path.join(self.tmp.name, "nope.txt"))
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("配置或输入错误", result.stderr)

    def test_second_run_resumes_from_jsonl(self):
        first = self._run("--concurrency", "4")
        self.assertEqual(first.returncode, 0, first.stderr)
        before = len(self._report())
        second = self._run("--concurrency", "4")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(len(self._report()), before, "续跑不应重复请求")
        self.assertIn("没有待抓目标", second.stdout)


if __name__ == "__main__":
    unittest.main()
