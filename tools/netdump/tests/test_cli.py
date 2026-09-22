"""tests/test_cli.py —— netdump 命令行：build / summary、截断、错误码与输出卫生。"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from netdump import __version__  # noqa: E402
from netdump.cli import main  # noqa: E402

FIXTURES = os.path.join(ROOT, "fixtures")
HAR_FIXTURE = os.path.join(FIXTURES, "sample.har")
JSONL_FIXTURE = os.path.join(FIXTURES, "sample.jsonl")
SECRETS = ("session=abc123", "Bearer eyJhbGciOiJIUzI1NiJ9", "s3cr3t-pass")


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.outdir = os.path.join(self.tmp.name, "out")

    def run_cli(self, argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_build_generates_both_artifacts(self):
        code, out, err = self.run_cli(["build", HAR_FIXTURE, "-o", self.outdir])
        self.assertEqual(code, 0, err)
        endpoints_path = os.path.join(self.outdir, "endpoints.json")
        crawler_path = os.path.join(self.outdir, "crawler.py")
        self.assertTrue(os.path.isfile(endpoints_path))
        self.assertTrue(os.path.isfile(crawler_path))
        document = json.loads(read_text(endpoints_path))
        self.assertEqual(document["schemaVersion"], "netdump/1")
        self.assertEqual(document["source"]["format"], "har")
        self.assertIn("HTTP 接口", out)
        self.assertIn("api.example.com", out)
        self.assertIn(crawler_path, out)

    def test_stdout_never_leaks_credentials(self):
        code, out, _ = self.run_cli(["build", HAR_FIXTURE, "-o", self.outdir])
        self.assertEqual(code, 0)
        for secret in SECRETS:
            self.assertNotIn(secret, out, "CLI 摘要不得打印抓包凭据")
        code, out, _ = self.run_cli(["summary", HAR_FIXTURE])
        self.assertEqual(code, 0)
        for secret in SECRETS:
            self.assertNotIn(secret, out, "summary 不得打印抓包凭据")

    def test_top_truncates_endpoints(self):
        code, _, _ = self.run_cli(["build", HAR_FIXTURE, "-o", self.outdir, "--top", "2", "--quiet"])
        self.assertEqual(code, 0)
        document = json.loads(read_text(os.path.join(self.outdir, "endpoints.json")))
        self.assertEqual(len(document["endpoints"]), 2)
        self.assertEqual(document["summary"]["endpoints"], 2)
        self.assertEqual(document["summary"]["truncatedTo"], 2)
        scores = [item["score"] for item in document["endpoints"]]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_no_crawler_flag_and_custom_names(self):
        code, _, _ = self.run_cli(
            [
                "build",
                HAR_FIXTURE,
                "-o",
                self.outdir,
                "--no-crawler",
                "--endpoints-name",
                "api.json",
                "--quiet",
            ]
        )
        self.assertEqual(code, 0)
        self.assertTrue(os.path.isfile(os.path.join(self.outdir, "api.json")))
        self.assertFalse(os.path.exists(os.path.join(self.outdir, "crawler.py")))

        code, _, _ = self.run_cli(
            ["build", HAR_FIXTURE, "-o", self.outdir, "--crawler-name", "spider.py", "--quiet"]
        )
        self.assertEqual(code, 0)
        self.assertTrue(os.path.isfile(os.path.join(self.outdir, "spider.py")))

    def test_include_static_keeps_more_endpoints(self):
        default_dir = os.path.join(self.tmp.name, "default")
        wide_dir = os.path.join(self.tmp.name, "wide")
        self.run_cli(["build", HAR_FIXTURE, "-o", default_dir, "--quiet"])
        self.run_cli(["build", HAR_FIXTURE, "-o", wide_dir, "--quiet", "--include-static", "--include-documents"])
        narrow = json.loads(read_text(os.path.join(default_dir, "endpoints.json")))
        wide = json.loads(read_text(os.path.join(wide_dir, "endpoints.json")))
        self.assertGreater(len(wide["endpoints"]), len(narrow["endpoints"]))
        self.assertEqual(wide["summary"]["filtered"], 0)

    def test_crawl_defaults_flow_into_generated_script(self):
        code, _, _ = self.run_cli(
            [
                "build",
                JSONL_FIXTURE,
                "-o",
                self.outdir,
                "--concurrency",
                "32",
                "--timeout",
                "12.5",
                "--retries",
                "7",
                "--proxy",
                "socks5://127.0.0.1:1080",
                "--quiet",
            ]
        )
        self.assertEqual(code, 0)
        document = json.loads(read_text(os.path.join(self.outdir, "endpoints.json")))
        self.assertEqual(document["crawlDefaults"]["concurrency"], 32)
        self.assertEqual(document["crawlDefaults"]["proxies"], ["socks5://127.0.0.1:1080"])
        crawler = read_text(os.path.join(self.outdir, "crawler.py"))
        self.assertIn('"concurrency": 32', crawler)
        self.assertIn('"timeout": 12.5', crawler)
        self.assertIn('"retries": 7', crawler)
        self.assertIn("socks5://127.0.0.1:1080", crawler)

    def test_summary_subcommand_json(self):
        code, out, _ = self.run_cli(["summary", JSONL_FIXTURE, "--quiet"])
        self.assertEqual(code, 0)
        summary = json.loads(out)
        self.assertEqual(summary["summary"]["totalEntries"], 6)
        self.assertEqual(summary["summary"]["endpoints"], 4)
        self.assertTrue(summary["topEndpoints"])
        self.assertEqual(summary["topEndpoints"][0]["method"], "POST")

    def test_positional_defaults_to_build(self):
        code, _, _ = self.run_cli([HAR_FIXTURE, "-o", self.outdir, "--quiet"])
        self.assertEqual(code, 0)
        self.assertTrue(os.path.isfile(os.path.join(self.outdir, "endpoints.json")))

    def test_missing_input_file_returns_1(self):
        code, _, err = self.run_cli(["build", os.path.join(self.tmp.name, "nope.jsonl"), "-o", self.outdir])
        self.assertEqual(code, 1)
        self.assertIn("找不到文件", err)

    def test_unparsable_input_returns_1(self):
        bad = os.path.join(self.tmp.name, "bad.bin")
        with open(bad, "w", encoding="utf-8") as handle:
            handle.write("42")
        code, _, err = self.run_cli(["build", bad, "-o", self.outdir])
        self.assertEqual(code, 1)
        self.assertIn("解析失败", err)

    def run_cli_expect_exit(self, argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as ctx:
                main(argv)
        return ctx.exception.code, stdout.getvalue(), stderr.getvalue()

    def test_version_flag_exits_zero(self):
        code, out, _ = self.run_cli_expect_exit(["--version"])
        self.assertEqual(code, 0)
        self.assertIn(__version__, out)

    def test_no_arguments_prints_help_and_returns_2(self):
        code, out, _ = self.run_cli([])
        self.assertEqual(code, 2)
        self.assertIn("usage: netdump", out)

    def test_argparse_errors_exit_2(self):
        code, _, err = self.run_cli_expect_exit(["build"])
        self.assertEqual(code, 2)
        self.assertIn("capture", err)
        code, _, err = self.run_cli_expect_exit(["--definitely-not-a-flag", HAR_FIXTURE])
        self.assertEqual(code, 2)
        self.assertIn("unrecognized arguments", err)


if __name__ == "__main__":
    unittest.main()
