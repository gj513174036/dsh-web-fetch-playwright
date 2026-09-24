#!/usr/bin/env python3
"""把扩展装出来：用**仓库外**的站点信息生成一个可直接"加载已解压的扩展程序"的目录。

为什么需要这一步：仓库是公开的，内网地址与接口路径不能进去。所以仓库里只有
`extension/manifest.example.json`（占位站点）和与站点无关的代码；真实的域名、院区 id、
端点表由这个脚本从本地文件读进来，只在你的机器上生成成品。

用法::

    python3 tools/his/build_extension.py \\
        --endpoints net-dumps/his/endpoints.json \\
        --host https://his.example.org \\
        --out net-dumps/his/extension-build

    # 院区 id 可选：不给就由页面自己从 localStorage 里认（认不出时界面会让你填一次）

产物目录里的东西全是明文 JS，没有任何构建/打包步骤 —— 加载后改动即时生效。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXTENSION = os.path.join(HERE, "extension")

#: 从仓库复制进产物的文件（扩展外壳 + 与站点无关的三份核心）
COPY_FILES = (
    ("extension/content.js", "content.js"),
    ("extension/bootstrap.js", "bootstrap.js"),
    ("portal-core.js", "portal-core.js"),
    ("portal-direct.js", "portal-direct.js"),
    ("portal-app.js", "portal-app.js"),
    ("portal-app.css", "portal-app.css"),
)

#: 浏览器里直查真正要用的端点。多出来的（名单、档案检索）不注入，减少暴露面。
NEEDED = ("identity", "clinicRecords", "visitDetail", "reports", "reportDetail",
          "checkups", "checkupSummary", "crisis", "itemHistory", "dictionaries")


class BuildError(RuntimeError):
    pass


def load_endpoints(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            doc = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise BuildError(f"读不了端点表 {path}: {error}") from error
    missing = [key for key in NEEDED if key not in doc]
    if missing:
        raise BuildError(f"端点表缺少: {', '.join(missing)}")
    table = {key: doc[key] for key in NEEDED}
    # URL 模板里的占位符与参数名要留全，不然 renderEndpoint 找不到键
    for key, spec in table.items():
        if "path" not in spec:
            raise BuildError(f"端点 {key} 没有 path")
        spec.setdefault("params", [])
    return table


def match_pattern(host: str) -> str:
    """`https://his.example.org` → `https://his.example.org/*`（清单里的匹配式）。"""
    host = host.strip().rstrip("/")
    if not host.startswith(("http://", "https://")):
        raise BuildError(f"--host 要以 http:// 或 https:// 开头：{host!r}")
    return f"{host}/*"


def build(endpoints_path: str, host: str, outdir: str, hospital_id: str = "",
          name: str = "病例查询面板", version: str = "0.1.0") -> dict:
    endpoints = load_endpoints(endpoints_path)
    pattern = match_pattern(host)

    if os.path.isdir(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir, mode=0o700)

    for source, target in COPY_FILES:
        source_path = os.path.join(HERE, source)
        if not os.path.exists(source_path):
            raise BuildError(f"缺少源文件 {source_path}")
        shutil.copyfile(source_path, os.path.join(outdir, target))

    manifest = {
        "manifest_version": 3,
        "name": name,
        "version": version,
        "description": "在病例系统页面里直接查一个人：异常指标、历次值与趋势。同源直查，不需要后端。",
        "content_scripts": [{
            "matches": [pattern],
            "js": ["site.js", "content.js"],
            "run_at": "document_idle",
        }],
        "web_accessible_resources": [{
            "resources": ["portal-core.js", "portal-direct.js", "portal-app.js", "portal-app.css", "bootstrap.js"],
            "matches": [pattern],
        }],
        # 真正的**零权限**：不需要 cookies（同源请求自带会话）、不需要 <all_urls>、
        # 不需要 storage（事实缓存在页面自己的 localStorage 里）。
        "permissions": [],
    }
    with open(os.path.join(outdir, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    site = {"host": host.rstrip("/"), "hospitalId": hospital_id, "endpoints": endpoints}
    with open(os.path.join(outdir, "site.js"), "w", encoding="utf-8") as handle:
        handle.write("// 由 build_extension.py 生成：站点相关配置（仓库里没有这些）\n")
        handle.write("globalThis.HIS_SITE = " + json.dumps(site, ensure_ascii=False, indent=2) + ";\n")

    for path in os.listdir(outdir):
        os.chmod(os.path.join(outdir, path), 0o600)
    return {"outdir": os.path.abspath(outdir), "matches": pattern, "files": sorted(os.listdir(outdir)),
            "endpoints": sorted(endpoints), "hospitalId": hospital_id or "(自动识别)"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成可加载的病例查询扩展")
    parser.add_argument("--endpoints", required=True, help="仓库外的端点表 JSON（真实路径）")
    parser.add_argument("--host", required=True, help="病例系统地址，如 https://his.example.org")
    parser.add_argument("--out", default="extension-build", help="产物目录（会被清空重建）")
    parser.add_argument("--hospital-id", default="", help="院区 id（x-current-hospital）；不给则页面自动识别")
    parser.add_argument("--name", default="病例查询面板")
    parser.add_argument("--version", default="0.1.0")
    args = parser.parse_args(argv)
    try:
        summary = build(args.endpoints, args.host, args.out, args.hospital_id, args.name, args.version)
    except BuildError as error:
        print(f"[extension] 生成失败: {error}", file=sys.stderr)
        return 2
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"""
[extension] 装法（Chrome/Edge）：
  1. 打开 chrome://extensions
  2. 右上角打开"开发者模式"
  3. 点"加载已解压的扩展程序"，选这个目录：{summary['outdir']}
  4. 打开病例系统页面，右下角会出现「病例查询」按钮

改动后回到 chrome://extensions 点一次该扩展的"刷新"即可；权限只有零项（不用 cookies、
不用 <all_urls>），因为同源请求本来就带着会话。""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
