"""netdump.endpoints —— URL 模板化、去重合并与接口评分排序（零第三方依赖）。

输入是一批已通过 :mod:`netdump.classify` 过滤的业务 API 记录，输出是
``endpoints.json`` 的完整文档结构（dict）：

* ``endpoints``：HTTP 业务接口，按 ``(method, host, pathTemplate)`` 去重合并，
  合并 headers / cookies / query / payload，并给出评分与排序依据；
* ``websockets``：WebSocket 通道（含抓到的帧样本），不混入 HTTP 接口清单；
* ``filtered``：被过滤的记录及其原因（便于人工复核，默认截断）。

模板化规则：路径段为纯数字 → ``{id}``，UUID → ``{uuid}``，长度 ≥ 16 的十六进制
串 → ``{hash}``；同一模板里重复出现的同类占位符会带序号（``{id}``、``{id2}``）。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .classify import (
    ClassifyOptions,
    api_signals,
    classify_entries,
    is_json_mime,
    is_static_asset,
)
from .har import Entry, url_host, url_path, url_query, url_scheme

__all__ = [
    "GROUP_KEY",
    "SCHEMA_VERSION",
    "SCORE_WEIGHTS",
    "build_endpoints_document",
    "describe_body",
    "group_entries",
    "parse_cookies",
    "parse_query",
    "parse_set_cookie",
    "score_endpoint",
    "templatize_path",
]

SCHEMA_VERSION = "netdump/1"

GROUP_KEY = "method+host+pathTemplate"

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
HEX_RE = re.compile(r"^[0-9a-fA-F]{16,}$")
DIGITS_RE = re.compile(r"^\d+$")

#: 评分权重（全部为正分，静态资源在 ``include_static`` 下扣分）。
SCORE_WEIGHTS: Dict[str, int] = {
    "resource-type:xhr": 30,
    "resource-type:fetch": 30,
    "json-response": 25,
    "write-request-with-body": 20,
    "authorization-header": 15,
    "cookie-header": 10,
    "websocket": 10,
    "websocket-frames": 10,
    "query-params": 5,
    "static-included": -20,
}

_REPEAT_POINTS_PER_CALL = 5
_REPEAT_POINTS_CAP = 15

#: 合并进生成脚本时会由 httpx 自行管理的请求头（避免冲突），其余原样保留。
_DROPPED_REQUEST_HEADERS = (
    "content-length",
    "host",
    "connection",
    "transfer-encoding",
    "proxy-connection",
)
_MAX_SAMPLE_URLS = 5
_MAX_PATH_VALUES = 5
_MAX_FRAME_SAMPLES = 5
_MAX_FILTERED_LISTED = 200
_MAX_BODY_SAMPLE = 8192
_MAX_RESPONSE_BODY_SAMPLE = 2048


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------


def _placeholder_for(segment: str) -> Optional[str]:
    if UUID_RE.match(segment):
        return "uuid"
    if HEX_RE.match(segment):
        return "hash"
    if DIGITS_RE.match(segment):
        return "id"
    return None


def templatize_path(path: str) -> Tuple[str, Dict[str, List[str]]]:
    """把 URL 路径模板化，返回 ``(pathTemplate, {占位符名: [原始值...]})``。"""
    if not path:
        return "/", {}
    trailing_slash = path.endswith("/") and path != "/"
    segments = [seg for seg in path.split("/")]
    # split("/a/b") -> ["", "a", "b"]，首个空段代表前导斜杠
    out_segments: List[str] = []
    values: Dict[str, List[str]] = {}
    counters: Dict[str, int] = {}
    for index, segment in enumerate(segments):
        if index == 0 and segment == "":
            out_segments.append("")
            continue
        base = _placeholder_for(segment)
        if base is None:
            out_segments.append(segment)
            continue
        counters[base] = counters.get(base, 0) + 1
        name = base if counters[base] == 1 else f"{base}{counters[base]}"
        out_segments.append("{" + name + "}")
        values.setdefault(name, [])
        if segment not in values[name] and len(values[name]) < _MAX_PATH_VALUES:
            values[name].append(segment)
    template = "/".join(out_segments)
    if not template.startswith("/"):
        template = "/" + template
    if trailing_slash and not template.endswith("/"):
        template += "/"
    return template, values


def parse_query(url: str) -> Dict[str, str]:
    """解析查询串，返回 ``{name: 首个非空值}``（保持原始出现顺序）。"""
    raw = url_query(url)
    if not raw:
        return {}
    result: Dict[str, str] = {}
    for chunk in raw.split("&"):
        if not chunk:
            continue
        name, sep, value = chunk.partition("=")
        if not name:
            continue
        if name not in result or (not result[name] and value):
            result[name] = value if sep else ""
    return result


def parse_cookies(header_value: str) -> Dict[str, str]:
    """把 ``Cookie: a=1; b=2`` 解析成 ``{a: "1", b: "2"}``。"""
    cookies: Dict[str, str] = {}
    if not header_value:
        return cookies
    for chunk in re.split(r"[;\n]", header_value):
        name, sep, value = chunk.strip().partition("=")
        name = name.strip()
        if not name or not sep:
            continue
        cookies.setdefault(name, value.strip())
    return cookies


def parse_set_cookie(header_value: str) -> Dict[str, str]:
    """解析 ``Set-Cookie`` 头，只保留 ``name=value``，丢弃 Path/Expires 等属性。

    多个 ``Set-Cookie`` 由 :func:`netdump.har.normalize_headers` 用换行连接。
    """
    cookies: Dict[str, str] = {}
    if not header_value:
        return cookies
    for line in re.split(r"\n", header_value):
        first = line.split(";", 1)[0].strip()
        name, sep, value = first.partition("=")
        name = name.strip()
        if not name or not sep:
            continue
        cookies.setdefault(name, value.strip())
    return cookies


def _json_type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "unknown"


def _describe_json(value: Any, depth: int = 0) -> Any:
    if depth >= 6:
        return _json_type_name(value)
    if isinstance(value, dict):
        return {str(key): _describe_json(item, depth + 1) for key, item in value.items()}
    if isinstance(value, list):
        if not value:
            return {"kind": "array", "items": "unknown", "length": 0}
        return {"kind": "array", "items": _describe_json(value[0], depth + 1), "length": len(value)}
    return _json_type_name(value)


def describe_body(post_data: str, content_type: str = "") -> Dict[str, Any]:
    """把请求体描述成可序列化的「形状」，供人读也供生成脚本参考。"""
    body = (post_data or "").strip()
    if not body:
        return {}
    base_mime = (content_type or "").split(";", 1)[0].strip().lower()

    if body[0] in "{[" and ("json" in base_mime or not base_mime or base_mime.endswith("+json")):
        try:
            parsed = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            parsed = None
        if parsed is not None:
            kind = "array" if isinstance(parsed, list) else "json"
            return {"kind": kind, "encoding": "json", "fields": _describe_json(parsed)}

    if base_mime == "application/x-www-form-urlencoded" or (
        "=" in body and "&" in body and "{" not in body
    ):
        fields: Dict[str, str] = {}
        for chunk in body.split("&"):
            name, _, value = chunk.partition("=")
            if name:
                fields[name] = "string"
        return {"kind": "form", "encoding": "urlencoded", "fields": fields}

    if base_mime in ("multipart/form-data",) or base_mime.startswith("multipart/"):
        return {"kind": "multipart", "encoding": "multipart", "length": len(body)}

    return {"kind": "text", "encoding": base_mime or "text", "length": len(body)}


def _body_is_json(entry: Entry) -> bool:
    """响应体本身是 JSON（mime 缺失时的兜底判据）。"""
    body = (entry.responseBody or "").strip()
    if not body or body[0] not in "{[":
        return False
    try:
        json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return False
    return True


# ---------------------------------------------------------------------------
# 合并
# ---------------------------------------------------------------------------


@dataclass
class _Group:
    method: str
    host: str
    path_template: str
    url_template: str
    sample_url: str
    sample_urls: List[str] = field(default_factory=list)
    request_headers: Dict[str, str] = field(default_factory=dict)
    _header_values: Dict[str, List[str]] = field(default_factory=dict)
    response_headers: Dict[str, str] = field(default_factory=dict)
    cookies: Dict[str, str] = field(default_factory=dict)
    set_cookies: Dict[str, str] = field(default_factory=dict)
    query: Dict[str, str] = field(default_factory=dict)
    query_values: Dict[str, List[str]] = field(default_factory=dict)
    path_params: Dict[str, List[str]] = field(default_factory=dict)
    sample_body: str = ""
    body_variants: int = 0
    _seen_bodies: List[str] = field(default_factory=list)
    content_type: str = ""
    resource_types: Dict[str, int] = field(default_factory=dict)
    json_seen: bool = False
    static_included: bool = False
    mime_types: Dict[str, int] = field(default_factory=dict)
    statuses: Dict[str, int] = field(default_factory=dict)
    durations: List[float] = field(default_factory=list)
    call_count: int = 0

    def signal_set(self) -> List[str]:
        """命中的评分信号（顺序固定，便于比对）。"""
        signals: List[str] = []
        api_types = [name for name in self.resource_types if name in ("xhr", "fetch")]
        if api_types:
            best = max(api_types, key=lambda name: (self.resource_types[name], name))
            signals.append(f"resource-type:{best}")
        if self.json_seen:
            signals.append("json-response")
        header_names = {name.lower() for name in self.request_headers}
        if "authorization" in header_names:
            signals.append("authorization-header")
        if "cookie" in header_names:
            signals.append("cookie-header")
        if self.sample_body and self.method.upper() not in ("GET", "HEAD", "OPTIONS"):
            signals.append("write-request-with-body")
        if self.query:
            signals.append("query-params")
        if self.static_included:
            signals.append("static-included")
        return signals

    def header_variants(self) -> Dict[str, List[str]]:
        variants: Dict[str, List[str]] = {}
        for name, values in self._header_values.items():
            if len(values) > 1:
                variants[name] = list(values)[:10]
        return variants


def _canonical_header_key(headers: Dict[str, str], name: str) -> Optional[str]:
    target = name.lower()
    for key in headers:
        if key.lower() == target:
            return key
    return None


def _merge_entry_into_group(group: _Group, entry: Entry) -> None:
    group.call_count += 1
    if len(group.sample_urls) < _MAX_SAMPLE_URLS and entry.url not in group.sample_urls:
        group.sample_urls.append(entry.url)
    resource_type = (entry.resourceType or "").lower()
    if resource_type:
        group.resource_types[resource_type] = group.resource_types.get(resource_type, 0) + 1
    mime = (entry.responseMimeType or "").split(";", 1)[0].strip().lower()
    if mime:
        group.mime_types[mime] = group.mime_types.get(mime, 0) + 1
    if is_json_mime(entry.responseMimeType) or _body_is_json(entry):
        group.json_seen = True
    # 「静态噪音」扣分只作用于「因为没有 API 信号、纯靠 --include-static 才被留下」的
    # 记录；被 api-over-static-extension 保留下来的伪静态接口不算噪音。
    if is_static_asset(entry)[0] and not api_signals(entry):
        group.static_included = True
    group.statuses[str(entry.status)] = group.statuses.get(str(entry.status), 0) + 1
    if entry.durationMs:
        group.durations.append(entry.durationMs)

    for name, value in entry.requestHeaders.items():
        if name.startswith(":"):
            continue
        if name.lower() in _DROPPED_REQUEST_HEADERS:
            continue
        key = _canonical_header_key(group.request_headers, name)
        if key is None:
            group.request_headers[name] = value
            group._header_values[name] = [value] if value else []
            continue
        values = group._header_values.setdefault(key, [])
        if value and value not in values:
            values.append(value)

    for name, value in entry.responseHeaders.items():
        if name.startswith(":"):
            continue
        key = _canonical_header_key(group.response_headers, name)
        if key is None:
            group.response_headers[name] = value

    cookie_header = entry.header("cookie")
    for name, value in parse_cookies(cookie_header).items():
        group.cookies.setdefault(name, value)
    for name, value in parse_set_cookie(entry.response_header("set-cookie")).items():
        group.set_cookies.setdefault(name, value)

    for name, value in parse_query(entry.url).items():
        group.query.setdefault(name, value)
        values = group.query_values.setdefault(name, [])
        if value and value not in values and len(values) < _MAX_PATH_VALUES:
            values.append(value)

    _, path_values = templatize_path(url_path(entry.url))
    for name, values in path_values.items():
        target = group.path_params.setdefault(name, [])
        for value in values:
            if value not in target and len(target) < _MAX_PATH_VALUES:
                target.append(value)

    body = entry.postData or ""
    if body.strip():
        if not group.sample_body:
            group.sample_body = body[:_MAX_BODY_SAMPLE]
        if body not in group._seen_bodies and len(group._seen_bodies) < 10:
            group._seen_bodies.append(body)
    if not group.content_type:
        group.content_type = entry.header("content-type")


def _split_url(url: str) -> Tuple[str, str, str]:
    scheme = url_scheme(url) or "https"
    host = url_host(url)
    path = url_path(url)
    return scheme, host, path


def _most_common(counter: Dict[str, int]) -> str:
    if not counter:
        return ""
    return max(counter.items(), key=lambda item: (item[1], item[0]))[0]


def group_entries(entries: Sequence[Entry]) -> List[_Group]:
    """按 ``(method, host, pathTemplate)`` 去重合并。"""
    groups: Dict[Tuple[str, str, str], _Group] = {}
    for entry in entries:
        scheme, host, path = _split_url(entry.url)
        path_template, _ = templatize_path(path)
        key = (entry.method.upper() or "GET", host.lower(), path_template)
        group = groups.get(key)
        if group is None:
            group = _Group(
                method=entry.method.upper() or "GET",
                host=host,
                path_template=path_template,
                url_template=f"{scheme}://{host}{path_template}",
                sample_url=entry.url,
            )
            groups[key] = group
        _merge_entry_into_group(group, entry)
    return list(groups.values())


def score_endpoint(group: _Group) -> Tuple[int, List[Dict[str, Any]], str]:
    """计算评分，返回 ``(score, factors, rankReason)``。"""
    factors: List[Dict[str, Any]] = []
    signals = group.signal_set()
    for signal in signals:
        points = SCORE_WEIGHTS.get(signal)
        if points is None:
            continue
        factors.append({"factor": signal, "points": points})
    if group.call_count > 1:
        points = min(_REPEAT_POINTS_CAP, _REPEAT_POINTS_PER_CALL * (group.call_count - 1))
        factors.append({"factor": f"repeated-calls:x{group.call_count}", "points": points})
    score = sum(item["points"] for item in factors)
    if not factors:
        factors.append({"factor": "no-strong-signal", "points": 0})
    reason = ", ".join(f"{item['factor']}({item['points']:+d})" for item in factors)
    return score, factors, reason


def _endpoint_from_group(group: _Group) -> Dict[str, Any]:
    score, factors, reason = score_endpoint(group)
    headers = dict(group.request_headers)
    endpoint: Dict[str, Any] = {
        "key": f"{group.method} {group.host}{group.path_template}",
        "method": group.method,
        "urlTemplate": group.url_template,
        "pathTemplate": group.path_template,
        "host": group.host,
        "sampleUrl": group.sample_url,
        "sampleUrls": list(group.sample_urls),
        "requestHeaders": headers,
        "headerVariants": group.header_variants(),
        "cookies": dict(group.cookies),
        "setCookies": dict(group.set_cookies),
        "query": dict(group.query),
        "queryParams": sorted(group.query),
        "pathParams": {name: list(values) for name, values in group.path_params.items()},
        "contentType": group.content_type or headers.get("Content-Type", ""),
        "bodyShape": describe_body(group.sample_body, group.content_type or headers.get("Content-Type", "")),
        "sampleBody": group.sample_body,
        "bodyVariants": max(0, len(group._seen_bodies) - 1),
        "resourceType": _most_common(group.resource_types),
        "responseMimeType": _most_common(group.mime_types),
        "statuses": {key: value for key, value in sorted(group.statuses.items())},
        "callCount": group.call_count,
        "durationMsAvg": round(sum(group.durations) / len(group.durations), 3) if group.durations else 0.0,
        "score": score,
        "scoreFactors": factors,
        "rankReason": f"score={score}: {reason}",
    }
    return endpoint


def _websocket_from_entries(entries: Sequence[Entry]) -> List[Dict[str, Any]]:
    channels: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        scheme, host, path = _split_url(entry.url)
        path_template, _ = templatize_path(path)
        key = f"{host.lower()}{path_template}"
        channel = channels.setdefault(
            key,
            {
                "key": f"WS {host}{path_template}",
                "scheme": scheme or "wss",
                "host": host,
                "pathTemplate": path_template,
                "urlTemplate": f"{scheme or 'wss'}://{host}{path_template}",
                "sampleUrl": entry.url,
                "callCount": 0,
                "frameCount": 0,
                "sentFrames": 0,
                "receivedFrames": 0,
                "sampleFrames": [],
                "requestHeaders": {},
            },
        )
        channel["callCount"] += 1
        for name, value in entry.requestHeaders.items():
            if name.startswith(":"):
                continue
            channel["requestHeaders"].setdefault(name, value)
        for frame in entry.wsFrames:
            direction = frame.get("direction") or ""
            if direction == "sent":
                channel["sentFrames"] += 1
            elif direction == "received":
                channel["receivedFrames"] += 1
            elif direction == "closed":
                continue
            channel["frameCount"] += 1
            if len(channel["sampleFrames"]) < _MAX_FRAME_SAMPLES:
                payload = frame.get("payload") or ""
                channel["sampleFrames"].append(
                    {
                        "direction": direction or "unknown",
                        "opcode": frame.get("opcode"),
                        "payload": payload[:512],
                    }
                )
    result: List[Dict[str, Any]] = []
    for channel in channels.values():
        score = SCORE_WEIGHTS["websocket"] + (
            SCORE_WEIGHTS["websocket-frames"] if channel["frameCount"] else 0
        )
        channel["score"] = score
        channel["scoreFactors"] = [
            {"factor": "websocket", "points": SCORE_WEIGHTS["websocket"]},
        ] + (
            [{"factor": "websocket-frames", "points": SCORE_WEIGHTS["websocket-frames"]}]
            if channel["frameCount"]
            else []
        )
        channel["rankReason"] = f"score={score}: websocket channel with {channel['frameCount']} captured frames"
        result.append(channel)
    result.sort(key=lambda item: (-item["score"], item["key"]))
    return result


def _sort_endpoints(endpoints: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(
        endpoints,
        key=lambda item: (
            -item["score"],
            -item["callCount"],
            item["method"],
            item["urlTemplate"],
        ),
    )


def build_endpoints_document(
    entries: Sequence[Entry],
    options: Optional[ClassifyOptions] = None,
    source: Optional[Dict[str, Any]] = None,
    generated_at: Optional[str] = None,
    crawl_defaults: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """把 :class:`~netdump.har.Entry` 列表变成 ``endpoints.json`` 文档。"""
    options = options or ClassifyOptions()
    kept, dropped = classify_entries(entries, options)
    http_decisions = [decision for decision in kept if decision.kind == "http"]
    ws_decisions = [decision for decision in kept if decision.kind == "websocket"]

    endpoints = _sort_endpoints([_endpoint_from_group(group) for group in group_entries([d.entry for d in http_decisions])])
    websockets = _websocket_from_entries([d.entry for d in ws_decisions])
    filtered = [
        {
            "url": decision.entry.url,
            "method": decision.entry.method,
            "resourceType": decision.entry.resourceType,
            "reason": decision.reason,
        }
        for decision in dropped[:_MAX_FILTERED_LISTED]
    ]

    hosts = sorted({item["host"] for item in endpoints} | {item["host"] for item in websockets})
    document: Dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "tool": "netdump",
        "generatedAt": generated_at or datetime.now(timezone.utc).isoformat(),
        "source": dict(source or {}),
        "options": {
            "includeStatic": options.include_static,
            "includeDocuments": options.include_documents,
            "includeWebsockets": options.include_websockets,
            "staticExtensions": list(options.static_extensions),
            "staticResourceTypes": list(options.static_resource_types),
            "keepResourceTypes": list(options.keep_resource_types),
        },
        "summary": {
            "totalEntries": len(entries),
            "kept": len(kept),
            "filtered": len(dropped),
            "endpoints": len(endpoints),
            "websockets": len(websockets),
            "hosts": hosts,
        },
        "scoreModel": {
            "weights": dict(SCORE_WEIGHTS),
            "repeatCalls": {"pointsPerExtraCall": _REPEAT_POINTS_PER_CALL, "cap": _REPEAT_POINTS_CAP},
            "sortKey": "score desc, callCount desc, method asc, urlTemplate asc",
            "dedupeKey": GROUP_KEY,
        },
        "endpoints": endpoints,
        "websockets": websockets,
        "filtered": filtered,
    }
    if crawl_defaults:
        document["crawlDefaults"] = dict(crawl_defaults)
    return document
