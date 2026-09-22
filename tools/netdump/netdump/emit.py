"""netdump.emit —— 生成可直接在服务器上裸跑的 httpx 异步爬虫（零第三方依赖）。

生成物 ``crawler.py`` 的特点（与任务契约一致）：

* ``httpx.AsyncClient(http2=True)`` + ``asyncio.Semaphore`` 控制并发；
* 指数退避重试（429/5xx/网络错误，尊重 ``Retry-After``）；
* JSONL 结果落盘 + 断点续跑（默认跳过已成功的目标，容忍并修复半行）；
* ``--proxy``（可重复）/ ``--proxies-file`` 代理轮换，``--concurrency`` /
  ``--timeout`` / ``--retries`` / ``--dry-run`` 等参数；
* 抓到的请求头（含明文 ``Cookie`` / ``Authorization``）原样硬编码，脚本顶部
  有凭据敏感性警告；生成目录 0700、文件 0600。

生成器本身只依赖标准库：``crawler.py`` 运行时才 ``import httpx``，缺失时给出
``pip install "httpx[http2,socks]"`` 提示（``--dry-run`` 无需 httpx）。
"""

from __future__ import annotations

import json
import os
import stat
from typing import Any, Dict, List, Optional

__all__ = [
    "CRAWLER_NAME",
    "ENDPOINTS_NAME",
    "SECURITY_BANNER",
    "chmod_private_dir",
    "chmod_private_file",
    "emit_outputs",
    "ensure_private_dir",
    "render_crawler",
    "write_private_text",
]

CRAWLER_NAME = "crawler.py"
ENDPOINTS_NAME = "endpoints.json"

#: 生成脚本顶部的凭据敏感性警告（会出现在 crawler.py 最前面）。
SECURITY_BANNER = r'''# =============================================================================
#  !!! SECURITY WARNING — 凭据敏感性警告 / DO NOT COMMIT / DO NOT SHARE !!!
# -----------------------------------------------------------------------------
#  本文件由 netdump 从真实抓包生成，硬编码了抓取时的请求头，其中可能包含
#  明文 Cookie、Bearer Token、API Key、CSRF Token 等会话凭据。
#  这些凭据等同于账号权限：请只在受控机器上保存（目录 0700 / 文件 0600），
#  不要提交进任何 Git 仓库、不要贴进工单/聊天/截图、不要上传到公共制品库。
#  凭据往往会过期或与来源 IP/UA 绑定；泄露后请立刻轮换（重新登录/重置 Token）。
#
#  This file contains PLAINTEXT session credentials captured from a real browser
#  session. Treat it as a secret. Keep permissions at 0600, never commit it.
# =============================================================================
'''

_CRAWLER_TEMPLATE = r'''#!/usr/bin/env python3
# -*- coding: utf-8 -*-
@@SECURITY_BANNER@@
"""
crawler.py —— 由 netdump @@NETDUMP_VERSION_TEXT@@ 从真实抓包生成（schema @@SCHEMA_TEXT@@）。

用途：脱离浏览器与 AI，直接复用浏览器里抓到的真实请求（URL / 方法 / Headers /
Cookie / Payload）并发重放或改参数抓取。脚本把接口清单与请求头内嵌在文件里，
因此**不需要**再带 ``endpoints.json``，拷到服务器上就能跑。

依赖（仅运行本脚本需要）::

    pip install "httpx[http2,socks]"

典型用法::

    # 1) 先空跑，看看目标与代理配置
    python3 crawler.py --dry-run
    # 2) 直连小并发试跑
    python3 crawler.py --concurrency 4 --timeout 30
    # 3) 挂代理池并发跑（每行一个代理，# 开头是注释）
    python3 crawler.py --concurrency 32 --proxies-file proxies.txt
    # 4) 中断后再跑会自动跳过已成功的目标（JSONL 断点续跑）
    python3 crawler.py --concurrency 32 --proxies-file proxies.txt

生成的请求头里带有会话凭据，请只在本机/受控环境保存与运行。

源抓包信息::
@@SOURCE_JSON@@
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
import sys
import time
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Optional

httpx = None  # 延迟导入：--dry-run 不需要 httpx

GENERATED_AT = @@GENERATED_AT@@
SCHEMA_VERSION = @@SCHEMA@@
NETDUMP_VERSION = @@NETDUMP_VERSION@@

# ---------------------------------------------------------------------------
# 抓包结果（硬编码；含明文 Cookie / Authorization）
# ---------------------------------------------------------------------------
ENDPOINTS: List[Dict[str, Any]] = @@ENDPOINTS_JSON@@

DEFAULT_CONFIG: Dict[str, Any] = @@CONFIG_JSON@@

RETRY_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504, 522, 524})
_FORBIDDEN_HEADERS = frozenset(
    {"content-length", "host", "connection", "transfer-encoding", "proxy-connection"}
)


def _load_httpx():
    """运行时加载 httpx（生成器本身不依赖它）。"""
    global httpx
    if httpx is not None:
        return httpx
    try:
        import httpx as _httpx  # noqa: PLC0415
    except ImportError:
        sys.stderr.write(
            "[crawler] 缺少 httpx，请先安装：pip install \"httpx[http2,socks]\"\n"
            "          （--dry-run 不需要 httpx）\n"
        )
        raise SystemExit(2)
    httpx = _httpx
    return httpx


# ---------------------------------------------------------------------------
# 文件权限（结果与生成物都是敏感数据）
# ---------------------------------------------------------------------------


def ensure_private_dir(path: str) -> None:
    if not path:
        return
    os.makedirs(path, mode=0o700, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def append_jsonl(path: str, record: Dict[str, Any]) -> None:
    """追加一行 JSON（0644 -> 0600，写完立即 flush+fsync）。"""
    ensure_private_dir(os.path.dirname(os.path.abspath(path)))
    payload = json.dumps(record, ensure_ascii=False)
    fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            handle.write(payload + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def load_done(path: str) -> set:
    """读取已有 JSONL 的 ``key`` 集合；顺带修掉中断留下的半行。"""
    done = set()
    if not path or not os.path.exists(path):
        return done
    valid: List[str] = []
    corrupt = 0
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError:
                corrupt += 1
                continue
            valid.append(stripped)
            key = record.get("key")
            if key:
                done.add(key)
    if corrupt:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            for line in valid:
                handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
        sys.stderr.write(f"[crawler] 已修复 {corrupt} 行不完整的结果记录（{path}）\n")
    return done


# ---------------------------------------------------------------------------
# 目标构造
# ---------------------------------------------------------------------------


def render_template(template: str, path_params: Dict[str, List[str]]) -> str:
    """用抓到的路径参数值补全 {id} / {uuid} / {hash} 占位符。"""

    def replace(match: re.Match) -> str:
        values = path_params.get(match.group(1)) or []
        if not values:
            return match.group(0)
        return str(values[0])

    return re.sub(r"\{([A-Za-z0-9_]+)\}", replace, template)


def load_endpoints(args) -> List[Dict[str, Any]]:
    if args.endpoints:
        with open(args.endpoints, "r", encoding="utf-8") as handle:
            document = json.load(handle)
        if isinstance(document, dict):
            return document.get("endpoints") or []
        if isinstance(document, list):
            return document
        return []
    return ENDPOINTS


def build_targets(endpoints: List[Dict[str, Any]], expand_templates: bool, limit: int) -> List[Dict[str, Any]]:
    targets: List[Dict[str, Any]] = []
    seen = set()
    for endpoint in endpoints:
        method = str(endpoint.get("method") or "GET").upper()
        urls: List[str] = []
        sample = endpoint.get("sampleUrl")
        if sample:
            urls.append(str(sample))
        for url in endpoint.get("sampleUrls") or []:
            if str(url) not in urls:
                urls.append(str(url))
        if expand_templates:
            rendered = render_template(str(endpoint.get("urlTemplate") or ""), endpoint.get("pathParams") or {})
            if rendered and rendered not in urls:
                urls.append(rendered)
        for url in urls:
            key = f"{method} {url}"
            if key in seen:
                continue
            seen.add(key)
            targets.append(
                {
                    "key": key,
                    "method": method,
                    "url": url,
                    "headers": dict(endpoint.get("requestHeaders") or {}),
                    "body": str(endpoint.get("sampleBody") or ""),
                }
            )
    if limit and limit > 0:
        targets = targets[:limit]
    return targets


def sanitize_headers(headers: Dict[str, str]) -> Dict[str, str]:
    """去掉 httpx 会自行管理、或 HTTP/2 不允许手工设置的请求头。"""
    cleaned: Dict[str, str] = {}
    for name, value in (headers or {}).items():
        if not isinstance(name, str) or name.startswith(":"):
            continue
        if name.lower() in _FORBIDDEN_HEADERS:
            continue
        cleaned[name] = "" if value is None else str(value)
    return cleaned


# ---------------------------------------------------------------------------
# 代理池
# ---------------------------------------------------------------------------


class ProxyPool:
    """按请求轮换代理；无代理时返回 None（直连）。"""

    def __init__(self, proxies: List[str]) -> None:
        self._proxies = [p for p in proxies if p]
        self._index = 0
        self._lock = asyncio.Lock()

    def __len__(self) -> int:
        return len(self._proxies)

    async def next(self) -> Optional[str]:
        if not self._proxies:
            return None
        async with self._lock:
            proxy = self._proxies[self._index % len(self._proxies)]
            self._index += 1
            return proxy


def load_proxies(args) -> List[str]:
    proxies: List[str] = []
    for proxy in args.proxy or []:
        if proxy:
            proxies.append(proxy.strip())
    if args.proxies_file:
        with open(args.proxies_file, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                proxies.append(stripped)
    if not proxies:
        proxies = [str(p) for p in DEFAULT_CONFIG.get("proxies") or []]
    return proxies


# ---------------------------------------------------------------------------
# 重试
# ---------------------------------------------------------------------------


def backoff_delay(attempt: int, retry_after: Optional[str] = None) -> float:
    """指数退避 + 抖动；attempt 从 1 开始。"""
    base = float(DEFAULT_CONFIG.get("backoffBase", 0.5))
    cap = float(DEFAULT_CONFIG.get("backoffMax", 30.0))
    delay = min(cap, base * (2 ** max(0, attempt - 1)))
    delay += random.uniform(0.0, delay * 0.1 + 0.05)
    if retry_after:
        parsed = None
        try:
            parsed = float(retry_after)
        except (TypeError, ValueError):
            try:
                target = parsedate_to_datetime(str(retry_after))
                if target is not None:
                    parsed = max(0.0, target.timestamp() - time.time())
            except (TypeError, ValueError, OverflowError):
                parsed = None
        if parsed is not None:
            delay = max(delay, min(cap, parsed))
    return delay


# ---------------------------------------------------------------------------
# 请求
# ---------------------------------------------------------------------------


async def client_for(proxy: Optional[str], args, clients: Dict[str, Any]):
    key = proxy or "__direct__"
    client = clients.get(key)
    if client is not None:
        return client
    httpx_module = _load_httpx()
    common: Dict[str, Any] = {
        "timeout": args.timeout,
        "follow_redirects": True,
        "verify": not args.insecure,
    }
    if DEFAULT_CONFIG.get("userAgent"):
        common["headers"] = {"User-Agent": str(DEFAULT_CONFIG["userAgent"])}
    if proxy:
        try:
            client = httpx_module.AsyncClient(http2=True, proxy=proxy, **common)
        except TypeError:  # httpx < 0.26 参数名是 proxies
            client = httpx_module.AsyncClient(http2=True, proxies=proxy, **common)
    else:
        client = httpx_module.AsyncClient(http2=True, **common)
    clients[key] = client
    return client


async def fetch_one(client, target: Dict[str, Any], args, semaphore, stats: Dict[str, int], proxy: Optional[str]) -> Dict[str, Any]:
    method = target["method"]
    url = target["url"]
    headers = sanitize_headers(target["headers"])
    body = target["body"]
    attempts = 0
    last_error = ""
    started = time.monotonic()
    while True:
        attempts += 1
        try:
            request_kwargs: Dict[str, Any] = {"headers": headers}
            if body and method not in ("GET", "HEAD"):
                request_kwargs["content"] = body.encode("utf-8")
            # 并发闸门：只卡住真正发请求的那一段，退避等待不占并发名额
            async with semaphore:
                response = await client.request(method, url, **request_kwargs)
            if response.status_code in RETRY_STATUS and attempts <= args.retries:
                stats["retries"] += 1
                delay = backoff_delay(attempts, response.headers.get("retry-after"))
                sys.stderr.write(
                    f"[crawler] {response.status_code} {url} -> retry {attempts}/{args.retries} in {delay:.2f}s\n"
                )
                await asyncio.sleep(delay)
                continue
            record = {
                "key": target["key"],
                "method": method,
                "url": url,
                "status": response.status_code,
                "elapsedMs": round((time.monotonic() - started) * 1000.0, 3),
                "attempts": attempts,
                "proxy": proxy or "",
                "contentType": response.headers.get("content-type", ""),
                "bodyPreview": response.text[: args.body_bytes],
                "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            if response.status_code >= 400:
                stats["failed"] += 1
            else:
                stats["ok"] += 1
            append_jsonl(args.out, record)
            return record
        except Exception as exc:  # noqa: BLE001 - 网络层任何异常都要落盘并继续
            last_error = f"{type(exc).__name__}: {exc}"
            if attempts > args.retries:
                break
            stats["retries"] += 1
            delay = backoff_delay(attempts, None)
            sys.stderr.write(f"[crawler] {last_error} <- {url} retry {attempts}/{args.retries} in {delay:.2f}s\n")
            await asyncio.sleep(delay)
    stats["failed"] += 1
    record = {
        "key": target["key"],
        "method": method,
        "url": url,
        "status": 0,
        "error": last_error,
        "elapsedMs": round((time.monotonic() - started) * 1000.0, 3),
        "attempts": attempts,
        "proxy": proxy or "",
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    append_jsonl(args.out, record)
    return record


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="netdump 生成的 httpx 异步爬虫（复用浏览器抓包的真实请求）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--endpoints", default="", help="改用外部 endpoints.json（默认用脚本内嵌的抓包结果）")
    parser.add_argument("-o", "--out", default=DEFAULT_CONFIG["out"], help="结果 JSONL 路径（断点续跑依据）")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONFIG["concurrency"], help="并发请求数")
    parser.add_argument("--timeout", type=float, default=DEFAULT_CONFIG["timeout"], help="单请求超时（秒）")
    parser.add_argument("--retries", type=int, default=DEFAULT_CONFIG["retries"], help="失败重试次数（指数退避）")
    parser.add_argument("--proxy", action="append", default=[], metavar="URL", help="代理地址，可重复；支持 http(s)/socks5")
    parser.add_argument("--proxies-file", default=DEFAULT_CONFIG.get("proxiesFile") or "", help="代理列表文件（每行一个，# 注释）")
    parser.add_argument("--dry-run", action="store_true", help="只打印计划，不发请求（无需 httpx）")
    parser.add_argument("--no-resume", action="store_true", help="忽略已有结果，从头重跑")
    parser.add_argument("--expand-templates", action="store_true", help="用抓到的路径参数补全 {id}/{uuid}/{hash}")
    parser.add_argument("--limit", type=int, default=0, help="最多请求多少个目标（0=不限）")
    parser.add_argument("--body-bytes", type=int, default=512, help="结果里保留的响应体前缀字节数")
    parser.add_argument("--insecure", action="store_true", help="跳过 TLS 证书校验")
    return parser.parse_args(argv)


async def run(args) -> int:
    endpoints = load_endpoints(args)
    targets = build_targets(endpoints, args.expand_templates, args.limit)
    proxies = load_proxies(args)
    done = set() if args.no_resume else load_done(args.out)
    pending = [t for t in targets if t["key"] not in done]

    plan = {
        "endpoints": len(endpoints),
        "targets": len(targets),
        "alreadyDone": len(targets) - len(pending),
        "pending": len(pending),
        "concurrency": args.concurrency,
        "timeout": args.timeout,
        "retries": args.retries,
        "proxies": len(proxies),
        "proxyMode": "rotate" if len(proxies) > 1 else ("single" if proxies else "direct"),
        "out": os.path.abspath(args.out),
        "resume": not args.no_resume,
        "expandTemplates": bool(args.expand_templates),
    }
    if args.dry_run:
        plan["targetsPreview"] = [t["key"] for t in pending[:20]]
        plan["proxiesPreview"] = proxies[:10]
        print(json.dumps(plan, indent=2, ensure_ascii=False))
        return 0

    if not pending:
        print(f"[crawler] 没有待抓目标（{len(targets)} 个目标全部已完成，out={os.path.abspath(args.out)}）")
        return 0

    _load_httpx()
    ensure_private_dir(os.path.dirname(os.path.abspath(args.out)))
    if not os.path.exists(args.out):
        append_jsonl(args.out, {"$header": {"generatedAt": GENERATED_AT, "schema": SCHEMA_VERSION, "plan": plan}})

    print(f"[crawler] 开始：{len(pending)} 个目标 / 并发 {args.concurrency} / 代理 {len(proxies)} 个")
    pool = ProxyPool(proxies)
    semaphore = asyncio.Semaphore(max(1, args.concurrency))
    clients: Dict[str, Any] = {}
    stats = {"ok": 0, "failed": 0, "retries": 0}
    started = time.monotonic()
    tasks = []
    for target in pending:
        proxy = await pool.next()
        try:
            client = await client_for(proxy, args, clients)
        except Exception as exc:  # noqa: BLE001 - 代理配置非法时只跳过该目标
            stats["failed"] += 1
            sys.stderr.write(f"[crawler] 无法用代理 {proxy!r} 建连接池：{exc}\n")
            append_jsonl(
                args.out,
                {
                    "key": target["key"],
                    "method": target["method"],
                    "url": target["url"],
                    "status": 0,
                    "error": f"{type(exc).__name__}: {exc}",
                    "attempts": 0,
                    "proxy": proxy or "",
                    "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                },
            )
            continue
        tasks.append(asyncio.create_task(fetch_one(client, target, args, semaphore, stats, proxy)))
    interrupted = False
    try:
        await asyncio.gather(*tasks, return_exceptions=True)
    except (KeyboardInterrupt, asyncio.CancelledError):
        interrupted = True
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        for client in clients.values():
            await client.aclose()
    elapsed = time.monotonic() - started
    print(
        f"[crawler] 结束：ok={stats['ok']} failed={stats['failed']} retries={stats['retries']} "
        f"elapsed={elapsed:.1f}s -> {os.path.abspath(args.out)}"
    )
    if interrupted:
        print("[crawler] 已中断；结果已落盘，重跑会自动跳过已完成目标（--no-resume 可强制重跑）", file=sys.stderr)
        return 130
    return 0 if stats["failed"] == 0 else 1


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\n[crawler] 用户中断；已写入的结果保留在结果 JSONL 中", file=sys.stderr)
        return 130
    except (OSError, ValueError) as exc:  # 代理列表/endpoints 文件读不到之类
        print(f"[crawler] 配置或输入错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
'''

DEFAULT_CRAWL_CONFIG: Dict[str, Any] = {
    "concurrency": 8,
    "timeout": 30.0,
    "retries": 3,
    "out": "results.jsonl",
    "proxies": [],
    "proxiesFile": "",
    "backoffBase": 0.5,
    "backoffMax": 30.0,
    "userAgent": "",
}


def _merged_config(document: Dict[str, Any], overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    config = dict(DEFAULT_CRAWL_CONFIG)
    crawl_defaults = document.get("crawlDefaults") if isinstance(document.get("crawlDefaults"), dict) else {}
    for key, value in crawl_defaults.items():
        if value not in (None, "", []):
            config[key] = value
    for key, value in (overrides or {}).items():
        if value is not None:
            config[key] = value
    return config


def render_crawler(
    document: Dict[str, Any],
    netdump_version: str = "0.1.0",
    overrides: Optional[Dict[str, Any]] = None,
) -> str:
    """把 endpoints 文档渲染成 ``crawler.py`` 源码。"""
    endpoints = list(document.get("endpoints") or [])
    config = _merged_config(document, overrides)
    source = document.get("source") if isinstance(document.get("source"), dict) else {}
    source_meta = {
        "capture": source.get("path") or source.get("name") or "(unknown)",
        "format": source.get("format") or "unknown",
        "entries": source.get("entries"),
        "endpoints": len(endpoints),
        "generatedAt": document.get("generatedAt"),
        "scoreModel": document.get("scoreModel"),
    }
    replacements = {
        "@@SECURITY_BANNER@@": SECURITY_BANNER.rstrip("\n"),
        "@@NETDUMP_VERSION@@": json.dumps(netdump_version, ensure_ascii=False),
        "@@NETDUMP_VERSION_TEXT@@": netdump_version,
        "@@SCHEMA@@": json.dumps(document.get("schemaVersion") or "netdump/1", ensure_ascii=False),
        "@@SCHEMA_TEXT@@": str(document.get("schemaVersion") or "netdump/1"),
        "@@GENERATED_AT@@": json.dumps(document.get("generatedAt") or "", ensure_ascii=False),
        "@@SOURCE_JSON@@": "\n".join("#   " + line for line in json.dumps(source_meta, ensure_ascii=False, indent=2).splitlines()),
        "@@ENDPOINTS_JSON@@": json.dumps(endpoints, ensure_ascii=False, indent=4),
        "@@CONFIG_JSON@@": json.dumps(config, ensure_ascii=False, indent=4),
    }
    source_code = _CRAWLER_TEMPLATE
    for token, value in replacements.items():
        source_code = source_code.replace(token, value)
    return source_code


# ---------------------------------------------------------------------------
# 私有权限落盘
# ---------------------------------------------------------------------------


def chmod_private_dir(path: str) -> bool:
    """把目录权限收紧到 0700，返回是否成功。"""
    try:
        os.chmod(path, stat.S_IRWXU)
        return True
    except OSError:
        return False


def chmod_private_file(path: str) -> bool:
    """把文件权限收紧到 0600，返回是否成功。"""
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        return True
    except OSError:
        return False


def ensure_private_dir(path: str) -> str:
    """创建（或收紧）0700 目录。"""
    if path:
        os.makedirs(path, mode=0o700, exist_ok=True)
        chmod_private_dir(path)
    return path


def write_private_text(path: str, text: str) -> str:
    """以 0600 落盘文本（先建目录，再写文件，最后 chmod 兜底）。"""
    directory = os.path.dirname(os.path.abspath(path))
    ensure_private_dir(directory)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    chmod_private_file(path)
    return path


def emit_outputs(
    document: Dict[str, Any],
    outdir: str,
    netdump_version: str = "0.1.0",
    overrides: Optional[Dict[str, Any]] = None,
    crawler_name: str = CRAWLER_NAME,
    endpoints_name: str = ENDPOINTS_NAME,
    write_crawler: bool = True,
) -> Dict[str, Any]:
    """把 ``endpoints.json``（和 ``crawler.py``）写进 ``outdir``（0700/0600）。"""
    ensure_private_dir(outdir)
    endpoints_path = write_private_text(
        os.path.join(outdir, endpoints_name), json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    )
    result: Dict[str, Any] = {"outdir": outdir, "endpointsPath": endpoints_path, "crawlerPath": ""}
    if write_crawler:
        crawler_path = os.path.join(outdir, crawler_name)
        write_private_text(crawler_path, render_crawler(document, netdump_version, overrides))
        result["crawlerPath"] = crawler_path
    return result
