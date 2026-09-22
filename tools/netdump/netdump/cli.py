"""netdump 命令行入口：``build``（生成物）与 ``summary``（只看不写）。"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional, Sequence

from . import __version__
from .classify import ClassifyOptions
from .emit import CRAWLER_NAME, ENDPOINTS_NAME, emit_outputs
from .endpoints import build_endpoints_document
from .har import load_entries

__all__ = ["main"]

_SUBCOMMANDS = ("build", "summary")


def _add_common_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("capture", help="抓包文件：本插件 JSONL 事件流，或标准 HAR 1.2")
    parser.add_argument(
        "--format",
        choices=("auto", "har", "jsonl"),
        default="auto",
        help="强制输入格式（默认自动嗅探）",
    )
    parser.add_argument("--include-static", action="store_true", help="不过滤静态资源（js/css/图片/字体/媒体）")
    parser.add_argument("--include-documents", action="store_true", help="保留 document（HTML 页面）请求")
    parser.add_argument("--no-websockets", action="store_true", help="不保留 WebSocket 通道")
    parser.add_argument("--top", type=int, default=0, help="只保留评分最高的 N 个接口（0=全部）")
    parser.add_argument("--quiet", action="store_true", help="不打印总结")


def _add_build_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("-o", "--output-dir", default="netdump-out", help="输出目录（0700）")
    parser.add_argument("--no-crawler", action="store_true", help="只生成 endpoints.json")
    parser.add_argument("--crawler-name", default=CRAWLER_NAME, help="生成的爬虫文件名")
    parser.add_argument("--endpoints-name", default=ENDPOINTS_NAME, help="生成的接口清单文件名")
    # 以下参数写进生成脚本的默认值（运行时仍可用同名 CLI 覆盖）
    parser.add_argument("--concurrency", type=int, default=None, help="生成脚本默认并发数")
    parser.add_argument("--timeout", type=float, default=None, help="生成脚本默认超时（秒）")
    parser.add_argument("--retries", type=int, default=None, help="生成脚本默认重试次数")
    parser.add_argument("--proxy", action="append", default=[], metavar="URL", help="写进生成脚本的代理，可重复")
    parser.add_argument("--proxies-file", default=None, help="写进生成脚本的代理列表文件")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="netdump",
        description="离线抓包（插件 JSONL / HAR 1.2）→ 业务 API 清单 → httpx 异步爬虫",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"netdump {__version__}")
    subparsers = parser.add_subparsers(dest="command")

    build_parser = subparsers.add_parser("build", help="生成 endpoints.json 与 crawler.py")
    _add_common_options(build_parser)
    _add_build_options(build_parser)

    summary_parser = subparsers.add_parser("summary", help="打印抓包概览（不写文件）")
    _add_common_options(summary_parser)
    return parser


def _normalize_argv(argv: Optional[Sequence[str]]) -> List[str]:
    """允许省略 ``build``（``netdump capture.har`` 等价于 ``netdump build capture.har``）。"""
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        return args
    if args[0] in _SUBCOMMANDS or args[0] in ("-h", "--help", "--version"):
        return args
    return ["build"] + args


def _options_from_args(args: argparse.Namespace) -> ClassifyOptions:
    return ClassifyOptions(
        include_static=bool(args.include_static),
        include_documents=bool(args.include_documents),
        include_websockets=not bool(args.no_websockets),
    )


def _load(args: argparse.Namespace) -> tuple:
    entries, fmt = load_entries(args.capture, fmt=args.format)
    return entries, fmt


def _summarize_document(document: Dict[str, Any]) -> Dict[str, Any]:
    endpoints = document.get("endpoints") or []
    websockets = document.get("websockets") or []
    return {
        "schemaVersion": document.get("schemaVersion"),
        "source": document.get("source"),
        "summary": document.get("summary"),
        "topEndpoints": [
            {
                "method": item.get("method"),
                "urlTemplate": item.get("urlTemplate"),
                "callCount": item.get("callCount"),
                "score": item.get("score"),
                "rankReason": item.get("rankReason"),
            }
            for item in endpoints[:10]
        ],
        "websockets": [
            {"urlTemplate": item.get("urlTemplate"), "frameCount": item.get("frameCount")}
            for item in websockets[:10]
        ],
    }


def _print_human_summary(summary: Dict[str, Any], outdir: Optional[str], crawler_path: str) -> None:
    stats = summary.get("summary") or {}
    source = summary.get("source") or {}
    print(f"[netdump] 输入：{source.get('path', '?')}（{source.get('format', '?')}，{stats.get('totalEntries', 0)} 条记录）")
    print(
        f"[netdump] 过滤静态/噪音 {stats.get('filtered', 0)} 条，"
        f"保留 {stats.get('kept', 0)} 条 → HTTP 接口 {stats.get('endpoints', 0)} 个 / WS 通道 {stats.get('websockets', 0)} 个"
    )
    hosts = stats.get("hosts") or []
    if hosts:
        print(f"[netdump] 涉及域名：{', '.join(hosts)}")
    print("[netdump] 接口排名（method urlTemplate  calls  score）：")
    for item in summary.get("topEndpoints") or []:
        print(
            f"  - {item.get('method', '?'):<6} {item.get('urlTemplate', '?')}  "
            f"calls={item.get('callCount')}  score={item.get('score')}"
        )
    for item in summary.get("websockets") or []:
        print(f"  - WS     {item.get('urlTemplate', '?')}  frames={item.get('frameCount')}")
    if outdir:
        print(f"[netdump] 输出目录：{outdir}")
    if crawler_path:
        print(f"[netdump] 生成爬虫：{crawler_path}（含明文凭据，权限 0600，勿提交）")


def _run_build(args: argparse.Namespace) -> int:
    options = _options_from_args(args)
    entries, fmt = _load(args)
    overrides: Dict[str, Any] = {}
    if args.proxy:
        overrides["proxies"] = list(args.proxy)
    if args.concurrency is not None:
        overrides["concurrency"] = args.concurrency
    if args.timeout is not None:
        overrides["timeout"] = args.timeout
    if args.retries is not None:
        overrides["retries"] = args.retries
    if args.proxies_file is not None:
        overrides["proxiesFile"] = args.proxies_file

    document = build_endpoints_document(
        entries,
        options=options,
        source={
            "path": os.path.abspath(args.capture),
            "format": fmt,
            "entries": len(entries),
            "tool": "netdump",
            "toolVersion": __version__,
        },
        crawl_defaults=overrides,
    )
    if args.top and args.top > 0:
        document["endpoints"] = document["endpoints"][: args.top]
        document["summary"]["endpoints"] = len(document["endpoints"])
        document["summary"]["truncatedTo"] = args.top

    outputs = emit_outputs(
        document,
        args.output_dir,
        netdump_version=__version__,
        overrides=overrides,
        crawler_name=args.crawler_name,
        endpoints_name=args.endpoints_name,
        write_crawler=not args.no_crawler,
    )
    if not args.quiet:
        _print_human_summary(_summarize_document(document), outputs["outdir"], outputs["crawlerPath"])
    return 0


def _run_summary(args: argparse.Namespace) -> int:
    options = _options_from_args(args)
    entries, fmt = _load(args)
    document = build_endpoints_document(
        entries,
        options=options,
        source={"path": os.path.abspath(args.capture), "format": fmt, "entries": len(entries)},
    )
    summary = _summarize_document(document)
    if getattr(args, "quiet", False):
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        _print_human_summary(summary, None, "")
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(_normalize_argv(argv))
    if not getattr(args, "command", None):
        parser.print_help()
        return 2
    try:
        if args.command == "build":
            return _run_build(args)
        if args.command == "summary":
            return _run_summary(args)
    except FileNotFoundError as exc:
        print(f"[netdump] 找不到文件：{exc.filename or exc}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"[netdump] 解析失败：{exc}", file=sys.stderr)
        return 1
    parser.print_help()
    return 2
