#!/usr/bin/env python3
"""扩展外壳与产物生成的测试：能不能装、装出来的东西对不对、有没有把内网信息带出去。

三件事在这里钉死：

1. **产物可用**：`build_extension.py` 从仓库外的端点表生成一个目录，manifest 里要有
   正确的站点匹配式、零权限、`site.js` 要带齐浏览器直查要用的端点；
2. **语法可用**：四份 JS 过 `node --check`（浏览器里出语法错会静默不工作，最难查）；
3. **公开仓库干净**：`tools/his/` 下不许出现内网域名/路径/租户名 —— 这个仓库是公开的。
   测试里的这些词是从片段拼出来的，免得测试自己命中自己。
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)                  # tools/his
REPO = os.path.dirname(os.path.dirname(TOOLS))  # 仓库根
sys.path.insert(0, TOOLS)

import build_extension  # noqa: E402

NODE = shutil.which("node")
EXAMPLE_ENDPOINTS = os.path.join(TOOLS, "endpoints.example.json")

#: 拼出来的敏感词（不 직접 写全，避免测试自己命中自己）
FORBIDDEN = (
    "cv" + "te",
    "hm" + ".gz",
    "192" + ".168",
    "_h" + "is/",
    "his-" + "clinic",
    "user_" + "view_list",
    "archive_" + "user",
    "medical_report" + "_list",
    "/ap" + "is/",
    "yibi" + "com",
)


class ExtensionBuildTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="ext-test-")
        self.out = os.path.join(self.tmp.name, "build")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_build_produces_a_loadable_extension(self) -> None:
        summary = build_extension.build(EXAMPLE_ENDPOINTS, "https://his.example.org",
                                        self.out, hospital_id="x" * 32)
        self.assertEqual(summary["matches"], "https://his.example.org/*")
        for name in ("manifest.json", "site.js", "content.js", "bootstrap.js", "portal-core.js",
                     "portal-direct.js", "portal-app.js", "portal-app.css"):
            self.assertTrue(os.path.exists(os.path.join(self.out, name)), f"缺文件 {name}")

        manifest = json.load(open(os.path.join(self.out, "manifest.json"), encoding="utf-8"))
        self.assertEqual(manifest["manifest_version"], 3)
        self.assertEqual(manifest["permissions"], [])          # 真正的零权限
        self.assertEqual(manifest["content_scripts"][0]["js"], ["site.js", "content.js"])
        self.assertEqual(manifest["content_scripts"][0]["matches"], ["https://his.example.org/*"])
        # 页面要能加载这几份（否则注入会 404）
        exposed = manifest["web_accessible_resources"][0]["resources"]
        for name in ("portal-core.js", "portal-direct.js", "portal-app.js", "portal-app.css",
                     "bootstrap.js"):
            self.assertIn(name, exposed)
        self.assertNotIn("cookies", json.dumps(manifest))
        self.assertNotIn("<all_urls>", json.dumps(manifest))

    def test_site_js_carries_exactly_what_inline_mode_needs(self) -> None:
        build_extension.build(EXAMPLE_ENDPOINTS, "https://his.example.org", self.out,
                              hospital_id="a" * 32)
        text = open(os.path.join(self.out, "site.js"), encoding="utf-8").read()
        self.assertIn("globalThis.HIS_SITE", text)
        site = json.loads(text[text.index("=") + 1:].strip().rstrip(";"))
        for key in build_extension.NEEDED:
            self.assertIn(key, site["endpoints"], f"site.js 缺端点 {key}")
        # 名单与档案检索不注入：浏览器直查用不到，少一份暴露
        for extra in ("roster", "personSearch", "personByName"):
            self.assertNotIn(extra, site["endpoints"])
        self.assertEqual(site["hospitalId"], "a" * 32)
        self.assertNotIn("dictionaryTypeCode", json.dumps(site["endpoints"]["identity"]))

    def test_dictionary_codes_survive_the_build(self) -> None:
        """字典码表要一起带过去，否则浏览器里翻不出"口服/已执行"这些人话。"""
        build_extension.build(EXAMPLE_ENDPOINTS, "https://his.example.org", self.out)
        site = json.loads(open(os.path.join(self.out, "site.js"), encoding="utf-8")
                          .read().split("=", 1)[1].strip().rstrip(";"))
        codes = site["endpoints"]["dictionaries"]["codes"]
        self.assertIn("usage", codes)
        self.assertIn("doseUnit", codes)

    def test_missing_endpoint_is_refused(self) -> None:
        path = os.path.join(self.tmp.name, "broken.json")
        json.dump({"identity": {"path": "/x", "params": ["name"]}}, open(path, "w"))
        with self.assertRaises(build_extension.BuildError) as caught:
            build_extension.build(path, "https://his.example.org", self.out)
        self.assertIn("缺少", str(caught.exception))

    def test_host_must_be_an_origin(self) -> None:
        with self.assertRaises(build_extension.BuildError):
            build_extension.build(EXAMPLE_ENDPOINTS, "his.example.org", self.out)

    def test_rebuild_replaces_the_previous_output(self) -> None:
        build_extension.build(EXAMPLE_ENDPOINTS, "https://his.example.org", self.out)
        stale = os.path.join(self.out, "stale.js")
        open(stale, "w").close()
        build_extension.build(EXAMPLE_ENDPOINTS, "https://his.example.org", self.out)
        self.assertFalse(os.path.exists(stale), "旧产物没清掉，加载时会带上过期文件")

    def test_cli_reports_the_load_steps(self) -> None:
        result = subprocess.run(
            [sys.executable, os.path.join(TOOLS, "build_extension.py"),
             "--endpoints", EXAMPLE_ENDPOINTS, "--host", "https://his.example.org",
             "--out", os.path.join(self.tmp.name, "cli")],
            capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("chrome://extensions", result.stdout)
        self.assertIn("开发者模式", result.stdout)


@unittest.skipUnless(NODE, "没有 node")
class JavaScriptSyntaxTest(unittest.TestCase):
    """浏览器里出语法错会静默不工作，是最难查的一类故障 —— 这里先用 node 卡住。"""

    def test_every_shipped_script_parses(self) -> None:
        for name in ("portal-core.js", "portal-app.js", "portal-direct.js",
                     "portal-transport-http.js", "extension/content.js", "extension/bootstrap.js"):
            path = os.path.join(TOOLS, name)
            self.assertTrue(os.path.exists(path), f"缺文件 {name}")
            result = subprocess.run([NODE, "--check", path], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, f"{name} 语法错误:\n{result.stderr[:400]}")

    def test_core_and_app_export_the_expected_globals(self) -> None:
        """两份脚本都要把 API 挂到全局：浏览器里靠 <script> 直接引用。"""
        import pathlib
        core_url = pathlib.Path(os.path.join(TOOLS, "portal-core.js")).as_uri()
        app_url = pathlib.Path(os.path.join(TOOLS, "portal-app.js")).as_uri()
        script = (f"await import({core_url!r});"
                  f"await import({app_url!r});"
                  "console.log(typeof globalThis.HisCore, typeof globalThis.HisCore.buildView,"
                  " typeof globalThis.HisPortalApp.mount);")
        result = subprocess.run([NODE, "--input-type=module", "-e", script],
                                capture_output=True, text=True, timeout=60, cwd=REPO)
        self.assertEqual(result.returncode, 0, result.stderr[:400])
        self.assertIn("object function function", result.stdout)

    def test_shrink_alarm_flags_reports_that_lost_items(self) -> None:
        """真机上实测过一次"事实条数一样、某条明细少了 9 项、零报错" —— 这类变化要被看见。

        这条用 node 直接调那个纯函数，不依赖浏览器。
        """
        import pathlib
        module_url = pathlib.Path(os.path.join(TOOLS, "portal-direct.js")).as_uri()
        previous = [
            {"key": "k1", "kind": "lab", "source": {"sourceId": "rep-1"}, "items": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]},
            {"key": "k2", "kind": "checkup", "source": {"sourceId": "med-1"}, "items": [1, 2]},
        ]
        fresh = [
            {"key": "k1", "kind": "lab", "source": {"sourceId": "rep-1"}, "items": [1, 2, 3]},          # 少了 9 项
            {"key": "k2", "kind": "checkup", "source": {"sourceId": "med-1"}, "items": [1, 2, 3]},      # 变多了，不报
            {"key": "k3", "kind": "lab", "source": {"sourceId": "rep-2"}, "items": [1]},                # 新增，不报
        ]
        script = (f"await import({module_url!r});"
                  "const warnings = globalThis.HisDirectTransport.shrinkWarnings("
                  f"{json.dumps(previous, ensure_ascii=False)}, {json.dumps(fresh, ensure_ascii=False)});"
                  "console.log(JSON.stringify(warnings));")
        result = subprocess.run([NODE, "--input-type=module", "-e", script],
                                capture_output=True, text=True, timeout=60, cwd=REPO)
        self.assertEqual(result.returncode, 0, result.stderr[:400])
        warnings = json.loads(result.stdout.strip())
        self.assertEqual(len(warnings), 1, warnings)
        self.assertIn("rep-1", warnings[0])
        self.assertIn("12 项降到 3 项", warnings[0])

    def test_portal_html_only_references_shipped_files(self) -> None:
        """薄壳页引用的每一份文件都必须在仓库里，否则后端版会白屏。"""
        html = open(os.path.join(TOOLS, "portal.html"), encoding="utf-8").read()
        for name in ("portal-app.css", "portal-core.js", "portal-app.js", "portal-transport-http.js"):
            self.assertIn(name, html)
            self.assertTrue(os.path.exists(os.path.join(TOOLS, name)), f"页面引用了不存在的 {name}")
        # 薄壳里不该再有内联的判定/渲染逻辑
        self.assertNotIn("sparkline", html)
        self.assertNotIn("<style>", html)


class PublicRepoHygieneTest(unittest.TestCase):
    """这个仓库是公开的：内网域名、接口路径、院区 id 一律不许进来。"""

    PATTERNS = ("tools/his/*.js", "tools/his/*.py", "tools/his/*.json", "tools/his/*.md",
                "tools/his/*.html", "tools/his/*.css", "tools/his/extension/*",
                "tools/his/tests/*")

    def _files(self) -> list[str]:
        found: list[str] = []
        for pattern in self.PATTERNS:
            found.extend(glob.glob(os.path.join(REPO, pattern)))
        return sorted(set(found))

    def test_no_internal_identifiers(self) -> None:
        self.assertTrue(self._files(), "没扫到任何文件，测试本身有问题")
        hits: list[str] = []
        for path in self._files():
            if os.path.isdir(path) or path.endswith((".pyc",)):
                continue
            try:
                text = open(path, encoding="utf-8").read()
            except (OSError, UnicodeDecodeError):
                continue
            lowered = text.lower()
            for token in FORBIDDEN:
                if token.lower() in lowered:
                    hits.append(f"{os.path.relpath(path, REPO)}: {token}")
        self.assertEqual(hits, [], "公开仓库里出现了内网信息：\n" + "\n".join(hits))

    def test_manifest_template_uses_a_placeholder_site(self) -> None:
        text = open(os.path.join(TOOLS, "extension", "manifest.example.json"), encoding="utf-8").read()
        manifest = json.loads(text)
        self.assertEqual(manifest["content_scripts"][0]["matches"], ["https://his.example.org/*"])
        with open(EXAMPLE_ENDPOINTS, encoding="utf-8") as handle:
            site = json.load(handle)
        for spec in site.values():
            if isinstance(spec, dict) and "path" in spec:
                self.assertTrue(str(spec["path"]).startswith("/api/example/"),
                                "示例端点表必须全是编的路径")

    def test_real_site_config_is_gitignored(self) -> None:
        """真实站点配置与产物必须落在 net-dumps/（已 gitignore）里。"""
        ignore = open(os.path.join(REPO, ".gitignore"), encoding="utf-8").read()
        self.assertIn("net-dumps/", ignore)
        result = subprocess.run(
            ["git", "check-ignore", "-q", "net-dumps/his/extension-build/manifest.json"],
            cwd=REPO, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, "生成目录没被 gitignore 覆盖")


if __name__ == "__main__":
    unittest.main()
