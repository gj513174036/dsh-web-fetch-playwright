"""tests/test_stdlib_only.py —— 契约硬约束：netdump 只用 Python 3.11 标准库。

生成器绝不能 import httpx / pytest（httpx 只允许出现于「生成出来的脚本」的
运行时，且必须延迟导入）。这里用 AST 静态检查，避免只 grep 字符串漏判。
"""

from __future__ import annotations

import ast
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

PACKAGE_DIR = os.path.join(ROOT, "netdump")
TESTS_DIR = os.path.join(ROOT, "tests")

#: 明确禁止的第三方依赖（运行时也不许出现在生成器里）。
FORBIDDEN = {"httpx", "pytest", "requests", "aiohttp", "urllib3", "yaml", "numpy", "pandas"}

STDLIB = set(sys.stdlib_module_names)


def iter_python_files(directory):
    for dirpath, _dirnames, filenames in os.walk(directory):
        if "__pycache__" in dirpath:
            continue
        for filename in sorted(filenames):
            if filename.endswith(".py"):
                yield os.path.join(dirpath, filename)


def imported_roots(path):
    with open(path, encoding="utf-8") as handle:
        tree = ast.parse(handle.read(), filename=path)
    roots = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                roots.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                roots.add(node.module.split(".")[0])
    return roots


class StdlibOnlyTest(unittest.TestCase):
    def test_package_modules_import_only_stdlib(self):
        files = list(iter_python_files(PACKAGE_DIR))
        self.assertGreaterEqual(len(files), 6, "netdump 包模块数量异常")
        for path in files:
            roots = imported_roots(path)
            relative = os.path.relpath(path, ROOT)
            with self.subTest(module=relative):
                self.assertFalse(roots & FORBIDDEN, f"{relative} 引入了被禁止的依赖：{roots & FORBIDDEN}")
                unexpected = {root for root in roots if root not in STDLIB and root != "netdump"}
                self.assertFalse(unexpected, f"{relative} 引入了非标准库模块：{unexpected}")

    def test_pytest_is_never_used_and_httpx_import_lives_only_in_the_template(self):
        """pytest 完全不出现；``import httpx`` 只允许出现在 emit.py 的脚本模板里。"""
        for path in iter_python_files(PACKAGE_DIR):
            relative = os.path.relpath(path, ROOT)
            with open(path, encoding="utf-8") as handle:
                source = handle.read()
            with self.subTest(module=relative):
                self.assertNotIn("pytest", source, f"{relative} 不该引用 pytest")
                if os.path.basename(path) != "emit.py":
                    self.assertNotIn("import httpx", source, f"{relative} 不该出现 import httpx")

    def test_tests_import_only_stdlib_and_netdump(self):
        for path in iter_python_files(TESTS_DIR):
            roots = imported_roots(path)
            relative = os.path.relpath(path, ROOT)
            with self.subTest(module=relative):
                self.assertFalse(roots & FORBIDDEN, f"{relative} 引入了被禁止的依赖：{roots & FORBIDDEN}")
                unexpected = {root for root in roots if root not in STDLIB and root not in ("netdump",)}
                self.assertFalse(unexpected, f"{relative} 引入了非标准库模块：{unexpected}")

    def test_fixtures_are_committed(self):
        fixtures = sorted(os.listdir(os.path.join(ROOT, "fixtures")))
        self.assertIn("sample.har", fixtures)
        self.assertIn("sample.jsonl", fixtures)


if __name__ == "__main__":
    unittest.main()
