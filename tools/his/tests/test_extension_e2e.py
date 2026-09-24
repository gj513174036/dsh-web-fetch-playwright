#!/usr/bin/env python3
"""扩展的端到端测试：真装进 Chromium，在"工作台页面"上查一个人，看结果出不出来。

这条用例回答的是**只有真浏览器能回答**的问题：

* 扩展能不能装上、内容脚本能不能注入（`manifest` 的匹配式与权限对不对）；
* 注入到页面环境的三份脚本能不能加载（`web_accessible_resources` 漏一个就是白屏）；
* **同源直查**这条链能不能通：Cookie 有没有被带上、院区头有没有发出去、
  业务状态码有没有被检查、事实有没有折对、`portal-core.js` 的判定有没有出结果；
* 注入到**别人的页面**里时，界面有没有被宿主页面的 id/CSS 影响（作用域查询）。

实现上：起 `mock_his`（假病例系统）→ 用真实端点表的**占位副本**生成扩展 →
`node extension-e2e.mjs` 驱动浏览器 → 断言它报出来的结论。

环境要求（缺一样就跳过，不会假装通过）：`node`、仓库里的 `playwright-core`、一个 Chromium。
容器里还需要 `LD_LIBRARY_PATH` 指向 `/tmp/sysroot`（系统库不全时的引导），有就自动带上。
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(TOOLS))
sys.path.insert(0, TOOLS)

import build_extension  # noqa: E402
import collect  # noqa: E402
import mock_his  # noqa: E402
import portal  # noqa: E402

NODE = shutil.which("node")
DRIVER = os.path.join(HERE, "extension-e2e.mjs")
BACKEND_DRIVER = os.path.join(HERE, "backend-page-e2e.mjs")


def find_chrome() -> str:
    """找一个能用来自动化的 Chromium：环境变量优先，其次 playwright 的缓存目录。"""
    explicit = os.environ.get("CHROME_PATH")
    if explicit and os.path.exists(explicit):
        return explicit
    for pattern in ("~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome",
                    "~/.cache/ms-playwright/chromium-*/chrome-linux/chrome",
                    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"):
        matches = sorted(glob.glob(os.path.expanduser(pattern)))
        if matches:
            return matches[-1]
    return ""


def playwright_available() -> bool:
    return os.path.isdir(os.path.join(REPO, "node_modules", "playwright-core"))


@unittest.skipUnless(NODE and playwright_available(), "没有 node 或 playwright-core，跳过")
class ExtensionEndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.chrome = find_chrome()
        if not cls.chrome:
            raise unittest.SkipTest("找不到 Chromium，跳过")
        cls.server, cls.base = mock_his.make_server()
        cls.tmp = tempfile.TemporaryDirectory(prefix="ext-e2e-")
        cls.extension = os.path.join(cls.tmp.name, "extension")
        # 用仓库里的**占位**端点表生成扩展：真实路径不进仓库，也不需要真内网就能验证链路
        build_extension.build(os.path.join(TOOLS, "endpoints.example.json"), cls.base,
                              cls.extension, hospital_id="b" * 32)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def test_panel_opens_and_returns_a_verdict(self) -> None:
        env = dict(os.environ)
        env["CHROME_PATH"] = self.chrome
        # 容器里系统库不全时，Chromium 需要从 sysroot 找库与字体（本机跑时通常不需要）
        if os.path.isdir("/tmp/sysroot/usr/lib/x86_64-linux-gnu"):
            env["LD_LIBRARY_PATH"] = "/tmp/sysroot/usr/lib/x86_64-linux-gnu:/tmp/sysroot/lib/x86_64-linux-gnu"
            env["FONTCONFIG_PATH"] = "/tmp/sysroot/etc/fonts"
        result = subprocess.run(
            [NODE, DRIVER, self.extension, f"{self.base}/demo", "测试甲", "13800000001"],
            capture_output=True, text=True, timeout=600, env=env, cwd=REPO)
        report = None
        try:
            start = result.stdout.index("{")
            report = json.loads(result.stdout[start:])
        except (ValueError, json.JSONDecodeError):
            self.fail(f"驱动没有输出结论（returncode={result.returncode}）\n"
                      f"stdout: {result.stdout[-1500:]}\nstderr: {result.stderr[-1500:]}")

        detail = json.dumps(report, ensure_ascii=False, indent=1)
        self.assertEqual(report["errors"], [], f"页面/驱动报错：\n{detail}")
        self.assertTrue(report["ok"], detail)

        # 扩展注入 → 面板挂载 → 搜索 → 点选 → 结果
        # 假系统里"测试甲"刻意有**两条**同名记录：直查也必须全部列出来由人点选，
        # 手机号只用来把"就是他"那条排到最前（真机上"周峰"实测有 3 个）。
        self.assertEqual(len(report["candidates"]), 2, detail)
        self.assertIn("测试甲", report["candidates"][0])
        self.assertIn("手机号一致", report["candidates"][0])
        self.assertIn("138****0001", report["candidates"][0])
        self.assertNotIn("手机号一致", report["candidates"][1])
        self.assertIn("测试甲", report["patient"])
        self.assertEqual(len(report["kpis"]), 9, detail)

        # 判定确实来自 portal-core.js：异常卡与徽标要对得上假系统的数据
        by_name = {metric["name"]: metric["badges"] for metric in report["metrics"]}
        self.assertIn("血钾", by_name, detail)
        self.assertIn("危急值", by_name["血钾"], detail)          # 危急值模块 + 检验并成一张卡
        self.assertIn("总胆固醇", by_name, detail)
        self.assertIn("偏高", by_name["总胆固醇"], detail)
        self.assertIn("25-羟基维生素D", by_name, detail)
        self.assertIn("偏低", by_name["25-羟基维生素D"], detail)
        # 有跨时间的数值 → 画出趋势线
        self.assertGreaterEqual(report["charts"], 1, detail)
        # 标签页都渲染了（注入到宿主页面时作用域查询有没有坏）
        self.assertIn("异常指标", report["tabs"][0])
        # 状态栏必须显示"同源直查"这条路径，而不是后端
        self.assertIn("同源直查", report["status"])

    def test_session_loss_is_reported_not_swallowed(self) -> None:
        """假系统缺 Cookie 时回 HTTP 200 + 业务 401 —— 页面必须说出"会话失效"，不能白屏。"""
        if not self.chrome:
            self.skipTest("找不到 Chromium，跳过")
        env = dict(os.environ)
        env["CHROME_PATH"] = self.chrome
        if os.path.isdir("/tmp/sysroot/usr/lib/x86_64-linux-gnu"):
            env["LD_LIBRARY_PATH"] = "/tmp/sysroot/usr/lib/x86_64-linux-gnu:/tmp/sysroot/lib/x86_64-linux-gnu"
            env["FONTCONFIG_PATH"] = "/tmp/sysroot/etc/fonts"
        # 不在浏览器里放 Cookie → 同源请求也不带会话
        env["E2E_NO_COOKIE"] = "1"
        result = subprocess.run(
            [NODE, DRIVER, self.extension, f"{self.base}/demo", "测试甲", ""],
            capture_output=True, text=True, timeout=600, env=env, cwd=REPO)
        self.assertIn("会话失效", result.stdout + result.stderr,
                      "会话失效时应该给出可读的提示，而不是静默失败")
        report = json.loads(result.stdout[result.stdout.index("{"):])
        self.assertIn("会话失效", report.get("errorText", ""),
                      f"界面上的错误文案应该点明会话失效，而不是只说\"失败了\"：{report.get('errorText')!r}")


@unittest.skipUnless(NODE and playwright_available(), "没有 node 或 playwright-core，跳过")
class BackendPageEndToEndTest(unittest.TestCase):
    """后端版页面也跑一遍真浏览器：两种载体共用同一份界面，就得两边都验。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.chrome = find_chrome()
        if not cls.chrome:
            raise unittest.SkipTest("找不到 Chromium，跳过")
        cls.his, cls.base = mock_his.make_server()
        cls.tmp = tempfile.TemporaryDirectory(prefix="backend-e2e-")
        session_path = os.path.join(cls.tmp.name, "session.json")
        with open(session_path, "w", encoding="utf-8") as handle:
            json.dump({"base": cls.base, "headers": {"Cookie": "x-auth-token=test"}, "proxy": ""}, handle)
        session = collect.load_session_json(session_path)
        endpoints = collect.Endpoints.load(os.path.join(TOOLS, "endpoints.example.json"))
        cls.portal = portal.Portal(session, endpoints, cls.tmp.name, "2026-09-24")
        cls.server = portal.create_server(cls.portal, "127.0.0.1", 0)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.his.shutdown()
        cls.his.server_close()
        cls.tmp.cleanup()

    def test_backend_page_renders_and_collects(self) -> None:
        env = dict(os.environ)
        env["CHROME_PATH"] = self.chrome
        if os.path.isdir("/tmp/sysroot/usr/lib/x86_64-linux-gnu"):
            env["LD_LIBRARY_PATH"] = "/tmp/sysroot/usr/lib/x86_64-linux-gnu:/tmp/sysroot/lib/x86_64-linux-gnu"
            env["FONTCONFIG_PATH"] = "/tmp/sysroot/etc/fonts"
        result = subprocess.run(
            [NODE, BACKEND_DRIVER, self.url, "测试甲", "13800000001"],
            capture_output=True, text=True, timeout=600, env=env, cwd=REPO)
        try:
            report = json.loads(result.stdout[result.stdout.index("{"):])
        except (ValueError, json.JSONDecodeError):
            self.fail(f"驱动没有输出结论（returncode={result.returncode}）\n"
                      f"stdout: {result.stdout[-1500:]}\nstderr: {result.stderr[-1500:]}")
        detail = json.dumps(report, ensure_ascii=False, indent=1)
        self.assertEqual(report["errors"], [], detail)
        self.assertTrue(report["ok"], detail)
        self.assertEqual(len(report["candidates"]), 2, detail)   # 同名都列出来
        self.assertEqual(len(report["kpis"]), 9, detail)
        self.assertIn("血钾", report["metrics"], detail)
        self.assertIn("后端", report["status"], detail)
        self.assertGreaterEqual(report["charts"], 1, detail)


if __name__ == "__main__":
    unittest.main()
