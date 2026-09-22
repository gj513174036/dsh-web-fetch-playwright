"""netdump.har —— 抓包输入解析（零第三方依赖）。

本模块把两种抓包来源统一成同一种数据结构 :class:`Entry`：

1. **标准 HAR 1.2**：``{"log": {"entries": [...]}}``（也接受 ``{"entries": [...]}``
   或直接是一个 entry 数组）。
2. **本插件的 CDP 抓包 JSONL 事件流**：每行一个 JSON 对象，通常是
   ``{"method": "Network.requestWillBeSent", "params": {...}}`` 形式的 CDP 事件
   （dsh-web-fetch-playwright 的 ``recordNetwork`` 录制探针输出）。

为了对上层保持宽容，JSONL 还额外接受两种常见写法（都是同一份信息的不同裁剪）：

* **简化记录**：``{"kind"|"type"|"event": "request"|"response"|"responseBody"|
  "wsFrame"|"wsCreated"|"wsClosed", ...}``，字段名允许 ``headers`` /
  ``requestHeaders`` / ``responseHeaders``、``postData`` / ``body``、
  ``mimeType`` / ``responseMimeType``、``resourceType``、``durationMs``。
* **单条扁平记录**：一行同时携带请求与响应信息，例如
  ``{"requestId": "1", "method": "POST", "url": "...", "status": 200,
  "requestHeaders": {...}, "responseMimeType": "application/json"}``。
* 一行就是一个 HAR entry 对象（``{"request": {...}, "response": {...}}``）也可混排。

统一后的字段名固定为（见 :class:`Entry`）：``method``、``url``、``status``、
``requestHeaders``、``responseHeaders``、``postData``、``responseMimeType``、
``resourceType``、``durationMs``、``wsFrames``，另有几个可选的辅助字段
（``responseBody`` / ``startedDateTime`` / ``error`` / ``source``）。
"""

from __future__ import annotations

import base64
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

__all__ = [
    "Entry",
    "EXTENSION_RESOURCE_HINTS",
    "detect_format",
    "entries_from_events",
    "load_entries",
    "load_entries_from_text",
    "normalize_headers",
    "parse_har",
    "parse_jsonl",
]

# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

#: HTTP 状态码到资源类型的兜底映射在 :func:`infer_resource_type` 中，这里只列扩展名提示。
EXTENSION_RESOURCE_HINTS: Dict[str, str] = {
    ".js": "script",
    ".mjs": "script",
    ".css": "stylesheet",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".gif": "image",
    ".svg": "image",
    ".ico": "image",
    ".webp": "image",
    ".avif": "image",
    ".woff": "font",
    ".woff2": "font",
    ".ttf": "font",
    ".otf": "font",
    ".eot": "font",
    ".mp4": "media",
    ".webm": "media",
    ".mp3": "media",
    ".m4a": "media",
}

_CDP_METHOD_KINDS: Dict[str, str] = {
    "Network.requestWillBeSent": "request",
    "Network.requestWillBeSentExtraInfo": "requestExtra",
    "Network.responseReceived": "response",
    "Network.responseReceivedExtraInfo": "responseExtra",
    "Network.loadingFinished": "finished",
    "Network.loadingFailed": "failed",
    "Network.getResponseBody": "responseBody",
    "Network.dataReceived": "data",
    "Network.webSocketCreated": "wsCreated",
    "Network.webSocketWillSendHandshakeRequest": "wsHandshake",
    "Network.webSocketFrameSent": "wsFrameSent",
    "Network.webSocketFrameReceived": "wsFrameReceived",
    "Network.webSocketFrameError": "wsFrameError",
    "Network.webSocketClosed": "wsClosed",
}

_KIND_ALIASES: Dict[str, str] = {
    "request": "request",
    "requeststart": "request",
    "httprequest": "request",
    "requestwillsent": "request",
    "network.requestwillsent": "request",
    "requestextra": "requestExtra",
    "requestheaders": "requestExtra",
    "requestwillsentextrainfo": "requestExtra",
    "network.requestwillsentextrainfo": "requestExtra",
    "response": "response",
    "responsestart": "response",
    "httpresponse": "response",
    "responsereceived": "response",
    "network.responsereceived": "response",
    "responseextra": "responseExtra",
    "responseheaders": "responseExtra",
    "responsereceivedextrainfo": "responseExtra",
    "network.responsereceivedextrainfo": "responseExtra",
    "body": "responseBody",
    "responsebody": "responseBody",
    "resourcebody": "responseBody",
    "getresponsebody": "responseBody",
    "network.getresponsebody": "responseBody",
    "finished": "finished",
    "loadingfinished": "finished",
    "network.loadingfinished": "finished",
    "complete": "finished",
    "failed": "failed",
    "loadingfailed": "failed",
    "network.loadingfailed": "failed",
    "wscreated": "wsCreated",
    "websocketcreated": "wsCreated",
    "websocket": "wsCreated",
    "network.websocketcreated": "wsCreated",
    "wsframesent": "wsFrameSent",
    "websocketframesent": "wsFrameSent",
    "wsframereceived": "wsFrameReceived",
    "websocketframereceived": "wsFrameReceived",
    "wsframe": "wsFrame",
    "websocketframe": "wsFrame",
    "wsclosed": "wsClosed",
    "websocketclosed": "wsClosed",
    "network.websocketclosed": "wsClosed",
}


@dataclass
class Entry:
    """统一后的单条抓包记录。

    ``wsFrames`` 的每个元素形如 ``{"direction": "sent"|"received",
    "opcode": int|None, "payload": str, "time": float|None}``。
    """

    method: str = "GET"
    url: str = ""
    status: int = 0
    requestHeaders: Dict[str, str] = field(default_factory=dict)
    responseHeaders: Dict[str, str] = field(default_factory=dict)
    postData: str = ""
    responseMimeType: str = ""
    resourceType: str = "other"
    durationMs: float = 0.0
    wsFrames: List[Dict[str, Any]] = field(default_factory=list)
    # 可选辅助字段（不影响上述契约字段的语义）。
    responseBody: str = ""
    startedDateTime: str = ""
    error: str = ""
    source: str = ""

    # -- 便捷视图 ---------------------------------------------------------
    def header(self, name: str, default: str = "") -> str:
        """大小写不敏感地读取请求头。"""
        return _lookup_header(self.requestHeaders, name, default)

    def response_header(self, name: str, default: str = "") -> str:
        """大小写不敏感地读取响应头。"""
        return _lookup_header(self.responseHeaders, name, default)

    @property
    def host(self) -> str:
        return url_host(self.url)

    @property
    def path(self) -> str:
        return url_path(self.url)

    @property
    def scheme(self) -> str:
        return url_scheme(self.url)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "method": self.method,
            "url": self.url,
            "status": self.status,
            "requestHeaders": dict(self.requestHeaders),
            "responseHeaders": dict(self.responseHeaders),
            "postData": self.postData,
            "responseMimeType": self.responseMimeType,
            "resourceType": self.resourceType,
            "durationMs": self.durationMs,
            "wsFrames": [dict(f) for f in self.wsFrames],
            "responseBody": self.responseBody,
            "startedDateTime": self.startedDateTime,
            "error": self.error,
            "source": self.source,
        }


# ---------------------------------------------------------------------------
# URL / header 小工具（保持零依赖，不 import urllib 之外的东西）
# ---------------------------------------------------------------------------


_SCHEME_RE = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.\-]{0,31}):")


def url_scheme(url: str) -> str:
    """取 URL 的 scheme（含 ``data:`` / ``blob:`` 这类无 ``//`` 的形式）。

    ``localhost:8080/x`` 这种「只有 host:port」的写法不会被误判成 scheme。
    """
    match = _SCHEME_RE.match(url or "")
    if not match:
        return ""
    rest = url[match.end():]
    if rest.startswith("//"):
        return match.group(1).lower()
    if rest[:1].isdigit():
        return ""
    return match.group(1).lower()


def url_host(url: str) -> str:
    """返回 ``host[:port]``（小写 host，保留端口）。"""
    rest = url.split("://", 1)[1] if "://" in url else url
    authority = rest.split("/", 1)[0]
    authority = authority.split("?", 1)[0].split("#", 1)[0]
    if "@" in authority:  # 去掉 user:pass@
        authority = authority.rsplit("@", 1)[1]
    if authority.startswith("["):  # IPv6 字面量
        host, _, port = authority.partition("]")
        host = host + "]"
        if port.startswith(":"):
            return host.lower() + port
        return host.lower()
    if ":" in authority:
        host, _, port = authority.rpartition(":")
        return host.lower() + ":" + port
    return authority.lower()


def url_path(url: str) -> str:
    rest = url.split("://", 1)[1] if "://" in url else url
    rest = rest.split("#", 1)[0]
    path = rest.split("/", 1)[1] if "/" in rest else ""
    return "/" + path.split("?", 1)[0] if ("/" in rest) else "/"


def url_query(url: str) -> str:
    return url.split("?", 1)[1].split("#", 1)[0] if "?" in url else ""


def _lookup_header(headers: Dict[str, str], name: str, default: str = "") -> str:
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return default


def normalize_headers(raw: Any) -> Dict[str, str]:
    """把各种 headers 表示法统一为 ``{name: value}``。

    接受：``dict``、HAR 的 ``[{"name": ..., "value": ...}]``、``[[name, value]]``、
    以及 httpx/requests 风格的 ``[(name, value)]``。``None`` → 空字典。
    重复出现的同名头以 ``", "`` 连接（``set-cookie`` 用换行连接）。HTTP/2 伪头
    （``:authority`` / ``:method`` 等）不是真实请求头，直接丢弃。
    """
    result: Dict[str, str] = {}
    if raw is None:
        return result
    if isinstance(raw, dict):
        items: Iterable[Any] = raw.items()
    elif isinstance(raw, (list, tuple)):
        items = raw
    elif isinstance(raw, str):
        # 极少数录制器会把 headers 存成 "Name: value\r\nName2: value2"
        for line in raw.replace("\r\n", "\n").split("\n"):
            if ":" not in line:
                continue
            name, _, value = line.partition(":")
            _merge_header(result, name.strip(), value.strip())
        return result
    else:
        return result

    for item in items:
        if isinstance(item, dict):
            name = item.get("name")
            value = item.get("value")
            if value is None:
                value = item.get("valueString", "")
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            name, value = item
        else:
            continue
        if name is None:
            continue
        _merge_header(result, str(name), "" if value is None else str(value))
    return result


def _merge_header(target: Dict[str, str], name: str, value: str) -> None:
    if not name or name.startswith(":"):
        return  # HTTP/2 伪头（:authority/:method/...）不是真实请求头
    existing_key = next((k for k in target if k.lower() == name.lower()), None)
    if existing_key is None:
        target[name] = value
        return
    if value and value not in target[existing_key].split(", "):
        sep = "\n" if name.lower() == "set-cookie" else ", "
        target[existing_key] = target[existing_key] + sep + value if target[existing_key] else value


def infer_resource_type(url: str, mime: str = "", explicit: str = "") -> str:
    """在抓包没有给出资源类型时做兜底推断。"""
    if explicit:
        return str(explicit).lower()
    ext = os.path.splitext(url_path(url).lower())[1]
    if ext in EXTENSION_RESOURCE_HINTS:
        return EXTENSION_RESOURCE_HINTS[ext]
    base = (mime or "").split(";", 1)[0].strip().lower()
    if base:
        if base.endswith("+json") or base in ("application/json", "text/json"):
            return "xhr"
        if base.startswith("image/"):
            return "image"
        if base.startswith("font/"):
            return "font"
        if base.startswith("audio/") or base.startswith("video/"):
            return "media"
        if base in ("text/css",):
            return "stylesheet"
        if base in ("application/javascript", "text/javascript"):
            return "script"
        if base in ("text/html", "application/xhtml+xml"):
            return "document"
    return "other"


# ---------------------------------------------------------------------------
# 时间 / body 辅助
# ---------------------------------------------------------------------------


def _iso_from_wall_time(wall_time: Any) -> str:
    try:
        seconds = float(wall_time)
    except (TypeError, ValueError):
        return ""
    if seconds <= 0:
        return ""
    try:
        return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return ""


def _coerce_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number


def _coerce_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _post_data_text(post_data: Any) -> str:
    """把 HAR 的 ``postData`` 归一为字符串。"""
    if post_data is None:
        return ""
    if isinstance(post_data, str):
        return post_data
    if isinstance(post_data, dict):
        text = post_data.get("text")
        if isinstance(text, str) and text:
            return text
        params = post_data.get("params")
        if isinstance(params, list) and params:
            parts = []
            for item in params:
                if not isinstance(item, dict):
                    continue
                name = item.get("name")
                if name is None:
                    continue
                parts.append(f"{name}={item.get('value', '')}")
            return "&".join(parts)
        return ""
    return ""


def _decode_body(body: Any, base64_encoded: bool) -> str:
    if body is None:
        return ""
    if not isinstance(body, str):
        return json.dumps(body, ensure_ascii=False)
    if base64_encoded:
        try:
            return base64.b64decode(body).decode("utf-8", "replace")
        except Exception:  # pragma: no cover - 只有畸形 base64 会走到
            return body
    return body


def _normalize_ws_frame(raw: Any, direction: str = "") -> Dict[str, Any]:
    frame: Dict[str, Any] = {"direction": direction, "opcode": None, "payload": "", "time": None}
    if isinstance(raw, dict):
        kind = str(raw.get("type") or raw.get("direction") or direction or "").lower()
        if kind in ("send", "sent", "outgoing", "framesent"):
            frame["direction"] = "sent"
        elif kind in ("receive", "received", "incoming", "framereceived"):
            frame["direction"] = "received"
        elif kind in ("sent", "received"):
            frame["direction"] = kind
        opcode = raw.get("opcode")
        frame["opcode"] = _coerce_int(opcode, 0) if opcode is not None else None
        payload = raw.get("payloadData")
        if payload is None:
            payload = raw.get("payload")
        if payload is None:
            payload = raw.get("data")
        frame["payload"] = "" if payload is None else str(payload)
        frame["time"] = raw.get("time")
    elif isinstance(raw, str):
        frame["payload"] = raw
        if direction:
            frame["direction"] = direction
    elif raw is not None:
        frame["payload"] = str(raw)
    return frame


# ---------------------------------------------------------------------------
# HAR 1.2
# ---------------------------------------------------------------------------


def _looks_like_har_document(document: Any) -> bool:
    """判断一个已解析的 JSON 文档是否是 HAR（允许 entries 为空）。"""
    if not isinstance(document, dict):
        return False
    log = document.get("log")
    if isinstance(log, dict) and isinstance(log.get("entries"), list):
        return True
    if isinstance(document.get("entries"), list):
        return True
    return "request" in document and "response" in document


def _iter_har_entries(document: Any) -> List[Any]:
    if isinstance(document, list):
        return document
    if isinstance(document, dict):
        log = document.get("log")
        if isinstance(log, dict) and isinstance(log.get("entries"), list):
            return log["entries"]
        if isinstance(document.get("entries"), list):
            return document["entries"]
        if "request" in document and "response" in document:
            return [document]
    return []


def entry_from_har(har_entry: Dict[str, Any]) -> Entry:
    """HAR 1.2 entry → :class:`Entry`。"""
    request = har_entry.get("request") or {}
    response = har_entry.get("response") or {}
    if not isinstance(request, dict):
        request = {}
    if not isinstance(response, dict):
        response = {}
    content = response.get("content") if isinstance(response.get("content"), dict) else {}

    url = str(request.get("url") or har_entry.get("url") or "")
    request_headers = normalize_headers(request.get("headers"))
    response_headers = normalize_headers(response.get("headers"))
    mime = str(content.get("mimeType") or response.get("mimeType") or har_entry.get("responseMimeType") or "")
    resource_type = (
        har_entry.get("_resourceType")
        or har_entry.get("resourceType")
        or request.get("_resourceType")
        or ""
    )
    frames: List[Dict[str, Any]] = []
    raw_frames = har_entry.get("_webSocketMessages")
    if isinstance(raw_frames, list):
        for raw_frame in raw_frames:
            frames.append(_normalize_ws_frame(raw_frame))
    status = _coerce_int(response.get("status"), _coerce_int(har_entry.get("status"), 0))
    return Entry(
        method=str(request.get("method") or har_entry.get("method") or "GET").upper(),
        url=url,
        status=status,
        requestHeaders=request_headers,
        responseHeaders=response_headers,
        postData=_post_data_text(request.get("postData")),
        responseMimeType=mime,
        resourceType=str(resource_type).lower()
        if resource_type
        else infer_resource_type(url, mime),
        durationMs=_coerce_float(har_entry.get("time"), 0.0),
        wsFrames=frames,
        responseBody=str(content.get("text") or ""),
        startedDateTime=str(har_entry.get("startedDateTime") or ""),
        source="har",
    )


def parse_har(document: Any) -> List[Entry]:
    """解析 HAR 1.2（dict 或 JSON 文本），返回 :class:`Entry` 列表。"""
    if isinstance(document, (str, bytes, bytearray)):
        if isinstance(document, bytes):
            document = document.decode("utf-8", "replace")
        document = json.loads(document)
    return [entry_from_har(item) for item in _iter_har_entries(document) if isinstance(item, dict)]


# ---------------------------------------------------------------------------
# JSONL 事件流（CDP / 简化 / 扁平）
# ---------------------------------------------------------------------------


def _looks_like_har_entry(event: Any) -> bool:
    if not isinstance(event, dict):
        return False
    request = event.get("request")
    response = event.get("response")
    return (
        isinstance(request, dict)
        and isinstance(response, dict)
        and isinstance(request.get("url"), str)
        and "params" not in event
    )


def _event_kind(event: Dict[str, Any]) -> str:
    """判断一行 JSONL 的语义类型。"""
    cdp_method = event.get("method")
    if isinstance(cdp_method, str) and cdp_method.startswith("Network."):
        return _CDP_METHOD_KINDS.get(cdp_method, "unknown")
    alias = event.get("kind") or event.get("event") or event.get("type") or event.get("phase")
    if isinstance(alias, str):
        mapped = _KIND_ALIASES.get(alias.strip().lower())
        if mapped:
            return mapped
    if isinstance(cdp_method, str) and cdp_method.upper() in _HTTP_METHODS:
        return "flat"
    if isinstance(event.get("url"), str):
        return "flat"
    return "unknown"


_HTTP_METHODS = {
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "TRACE",
    "CONNECT",
}


class _Pending:
    """按 ``requestId`` 聚合 CDP 事件的中间态。"""

    __slots__ = ("entry", "start_wall", "start_ts", "saw_response", "response_body_seen")

    def __init__(self, entry: Entry, start_wall: Optional[float], start_ts: Optional[float]) -> None:
        self.entry = entry
        self.start_wall = start_wall
        self.start_ts = start_ts
        self.saw_response = False
        self.response_body_seen = False


def entries_from_events(events: Sequence[Any]) -> List[Entry]:
    """把一串 JSONL 事件（已 ``json.loads``）统一为 :class:`Entry` 列表。"""
    out: List[Entry] = []
    pending: Dict[str, _Pending] = {}
    order: List[str] = []
    synthetic = 0

    def key_for(event: Dict[str, Any], params: Dict[str, Any]) -> str:
        nonlocal synthetic
        for candidate in (params.get("requestId"), event.get("requestId"), event.get("id")):
            if isinstance(candidate, str) and candidate:
                return candidate
        synthetic += 1
        return f"__synthetic_{synthetic}"

    flushed: Dict[str, Entry] = {}

    def flush(request_id: str) -> None:
        state = pending.pop(request_id, None)
        if state is not None:
            out.append(state.entry)
            flushed[request_id] = state.entry

    for raw_event in events:
        if not isinstance(raw_event, dict):
            continue
        if _looks_like_har_entry(raw_event):
            out.append(entry_from_har(raw_event))
            continue

        kind = _event_kind(raw_event)
        params = raw_event.get("params") if isinstance(raw_event.get("params"), dict) else raw_event
        assert isinstance(params, dict)

        if kind == "request":
            request_id = key_for(raw_event, params)
            request = params.get("request") if isinstance(params.get("request"), dict) else {}
            url = str(request.get("url") or params.get("url") or raw_event.get("url") or "")
            method = str(request.get("method") or params.get("method") or raw_event.get("method") or "GET")
            if method.upper() not in _HTTP_METHODS:  # 不是 HTTP 动词，说明是别的事件
                method = "GET"
            headers = normalize_headers(
                request.get("headers")
                or params.get("requestHeaders")
                or params.get("headers")
                or raw_event.get("requestHeaders")
                or raw_event.get("headers")
            )
            post_data = _post_data_text(
                request.get("postData")
                if request.get("postData") is not None
                else params.get("postData", raw_event.get("postData"))
            )
            if not post_data and isinstance(params.get("body"), str):
                post_data = params["body"]
            resource_type = (
                params.get("type")
                or params.get("resourceType")
                or raw_event.get("resourceType")
                or ""
            )
            wall = params.get("wallTime", raw_event.get("wallTime"))
            start_ts = params.get("timestamp", raw_event.get("timestamp"))
            redirect = params.get("redirectResponse") if isinstance(params.get("redirectResponse"), dict) else None
            previous = pending.get(request_id)
            if previous is not None:
                if redirect is not None:
                    previous.entry.status = _coerce_int(redirect.get("status"), previous.entry.status)
                    previous.entry.responseHeaders = normalize_headers(redirect.get("headers"))
                    previous.entry.responseMimeType = str(redirect.get("mimeType") or previous.entry.responseMimeType)
                    flush(request_id)
                else:
                    # 同一 requestId 的重复 request 事件（例如重试/预检），合并头即可
                    for name, value in headers.items():
                        previous.entry.requestHeaders.setdefault(name, value)
                    if post_data and not previous.entry.postData:
                        previous.entry.postData = post_data
                    continue
            entry = Entry(
                method=method.upper(),
                url=url,
                requestHeaders=headers,
                postData=post_data,
                responseMimeType="",
                resourceType=str(resource_type).lower() if resource_type else "",
                startedDateTime=_iso_from_wall_time(wall) or str(raw_event.get("startedDateTime") or ""),
                source="jsonl",
            )
            state = _Pending(entry, _coerce_float(wall, 0.0) or None, _coerce_float(start_ts, 0.0) or None)
            pending[request_id] = state
            order.append(request_id)
            continue

        if kind == "requestExtra":
            request_id = key_for(raw_event, params)
            state = pending.get(request_id)
            headers = normalize_headers(params.get("headers") or raw_event.get("headers"))
            if state is not None:
                for name, value in headers.items():
                    state.entry.requestHeaders.setdefault(name, value)
            continue

        if kind == "response":
            request_id = key_for(raw_event, params)
            state = pending.get(request_id)
            response = params.get("response") if isinstance(params.get("response"), dict) else params
            if state is None:
                # 只有响应没有请求（部分录制器只落盘响应），补一条骨架
                url = str(response.get("url") or params.get("url") or raw_event.get("url") or "")
                if not url:
                    continue
                entry = Entry(url=url, source="jsonl")
                state = _Pending(entry, None, None)
                pending[request_id] = state
                order.append(request_id)
            state.saw_response = True
            state.entry.status = _coerce_int(
                response.get("status", params.get("status", raw_event.get("status"))), state.entry.status
            )
            state.entry.responseHeaders.update(
                normalize_headers(response.get("headers") or params.get("responseHeaders") or params.get("headers"))
            )
            content = response.get("content") if isinstance(response.get("content"), dict) else {}
            mime = str(
                response.get("mimeType")
                or content.get("mimeType")
                or params.get("responseMimeType")
                or params.get("mimeType")
                or raw_event.get("responseMimeType")
                or ""
            )
            if mime:
                state.entry.responseMimeType = mime
            resource_type = (
                params.get("type") or params.get("resourceType") or raw_event.get("resourceType") or ""
            )
            if resource_type:
                state.entry.resourceType = str(resource_type).lower()
            if isinstance(content.get("text"), str) and content["text"]:
                state.entry.responseBody = content["text"]
            duration = params.get("durationMs", raw_event.get("durationMs"))
            if duration is not None:
                state.entry.durationMs = _coerce_float(duration, state.entry.durationMs)
            continue

        if kind == "responseExtra":
            request_id = key_for(raw_event, params)
            state = pending.get(request_id)
            headers = normalize_headers(params.get("headers") or raw_event.get("headers"))
            status_code = params.get("statusCode", raw_event.get("statusCode"))
            if state is not None:
                for name, value in headers.items():
                    state.entry.responseHeaders.setdefault(name, value)
                if status_code is not None and not state.entry.status:
                    state.entry.status = _coerce_int(status_code, 0)
            continue

        if kind == "responseBody":
            request_id = key_for(raw_event, params)
            state = pending.get(request_id)
            # recorder 一般在 loadingFinished 之后才取响应体，此时 entry 已经
            # flush 进 out，必须回到同一条 Entry 上补写，而不是新建记录。
            entry = state.entry if state is not None else flushed.get(request_id)
            body = _decode_body(
                params.get("body", raw_event.get("body")),
                bool(params.get("base64Encoded", raw_event.get("base64Encoded"))),
            )
            if entry is not None:
                if state is not None:
                    state.response_body_seen = True
                entry.responseBody = body or entry.responseBody
                mime = params.get("mimeType") or raw_event.get("mimeType")
                if mime and not entry.responseMimeType:
                    entry.responseMimeType = str(mime)
            elif body:
                # 完全没有配对请求：仅当事件自带 URL 时才作为兜底独立记录
                url = params.get("url") or raw_event.get("url")
                if isinstance(url, str) and url:
                    out.append(Entry(url=url, source="jsonl", responseBody=body))
            continue

        if kind == "finished":
            request_id = key_for(raw_event, params)
            state = pending.get(request_id)
            if state is None:
                continue
            if not state.entry.durationMs:
                end_ts = _coerce_float(params.get("timestamp", raw_event.get("timestamp")), 0.0)
                if state.start_ts and end_ts >= state.start_ts:
                    state.entry.durationMs = round((end_ts - state.start_ts) * 1000.0, 3)
                else:
                    duration = params.get("durationMs", raw_event.get("durationMs"))
                    if duration is not None:
                        state.entry.durationMs = _coerce_float(duration, 0.0)
            flush(request_id)
            continue

        if kind == "failed":
            request_id = key_for(raw_event, params)
            state = pending.get(request_id)
            if state is None:
                continue
            state.entry.error = str(
                params.get("errorText") or params.get("error") or raw_event.get("error") or "loadingFailed"
            )
            flush(request_id)
            continue

        if kind == "wsCreated":
            request_id = key_for(raw_event, params)
            url = str(params.get("url") or raw_event.get("url") or "")
            entry = Entry(
                method="WS",
                url=url,
                status=101,
                resourceType="websocket",
                startedDateTime=_iso_from_wall_time(params.get("wallTime", raw_event.get("wallTime"))),
                source="jsonl",
            )
            initiator = params.get("initiator")
            if isinstance(initiator, dict) and initiator.get("requestHeaders"):
                entry.requestHeaders = normalize_headers(initiator.get("requestHeaders"))
            pending[request_id] = _Pending(entry, None, None)
            order.append(request_id)
            continue

        if kind in ("wsFrameSent", "wsFrameReceived", "wsFrame"):
            request_id = key_for(raw_event, params)
            state = pending.get(request_id)
            if state is None:
                url = str(params.get("url") or raw_event.get("url") or "")
                if not url:
                    continue
                state = _Pending(
                    Entry(method="WS", url=url, status=101, resourceType="websocket", source="jsonl"), None, None
                )
                pending[request_id] = state
                order.append(request_id)
            response = params.get("response") if isinstance(params.get("response"), dict) else params
            direction = "sent" if kind == "wsFrameSent" else "received" if kind == "wsFrameReceived" else ""
            frame = _normalize_ws_frame(response, direction=direction)
            state.entry.wsFrames.append(frame)
            continue

        if kind == "wsClosed":
            request_id = key_for(raw_event, params)
            state = pending.get(request_id)
            if state is not None:
                state.entry.wsFrames.append(
                    {
                        "direction": "closed",
                        "opcode": None,
                        "payload": str(params.get("reason") or raw_event.get("reason") or ""),
                        "time": None,
                    }
                )
                flush(request_id)
            continue

        if kind == "flat":
            out.append(_entry_from_flat(raw_event))
            continue

        # unknown / data / handshake / wsFrameError：忽略但不致命
        continue

    # 未收到 finished/closed 的请求也要落盘（best-effort 抓包很可能被中断）
    for request_id in order:
        flush(request_id)
    return out


def _entry_from_flat(event: Dict[str, Any]) -> Entry:
    url = str(event.get("url") or "")
    request_headers = normalize_headers(
        event.get("requestHeaders") or event.get("headers") or event.get("request_header")
    )
    response_headers = normalize_headers(event.get("responseHeaders") or event.get("response_headers"))
    mime = str(event.get("responseMimeType") or event.get("mimeType") or event.get("response_mime_type") or "")
    resource_type = str(event.get("resourceType") or event.get("type") or "")
    frames = event.get("wsFrames") or event.get("frames") or []
    ws_frames = [_normalize_ws_frame(f) for f in frames] if isinstance(frames, list) else []
    method = str(event.get("method") or "GET").upper()
    if method not in _HTTP_METHODS:
        method = "GET"
    return Entry(
        method=method,
        url=url,
        status=_coerce_int(event.get("status", event.get("statusCode")), 0),
        requestHeaders=request_headers,
        responseHeaders=response_headers,
        postData=_post_data_text(event.get("postData") if event.get("postData") is not None else event.get("body")),
        responseMimeType=mime,
        resourceType=resource_type.lower() if resource_type else "",
        durationMs=_coerce_float(event.get("durationMs", event.get("time")), 0.0),
        wsFrames=ws_frames,
        responseBody=str(event.get("responseBody") or ""),
        startedDateTime=str(event.get("startedDateTime") or ""),
        error=str(event.get("error") or ""),
        source="jsonl",
    )


def _iter_json_lines(text: str) -> Iterable[Any]:
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        try:
            yield json.loads(stripped)
        except json.JSONDecodeError:
            # 容忍尾部半行（录制进程被 kill 时会留下不完整 JSON）
            continue


def parse_jsonl(text: str) -> List[Entry]:
    """解析本插件 JSONL 抓包事件流（文本），返回 :class:`Entry` 列表。"""
    if not text.strip():
        return []
    # 整个文本可能是一个 JSON 文档（单事件或整份 HAR），先尝试整体解析
    try:
        document = json.loads(text)
    except json.JSONDecodeError:
        return entries_from_events(list(_iter_json_lines(text)))
    if isinstance(document, list):
        return entries_from_events(document)
    if isinstance(document, dict):
        if _looks_like_har_document(document):
            return parse_har(document)
        return entries_from_events([document])
    return []


def detect_format(text: str) -> str:
    """嗅探文本是 ``har`` 还是 ``jsonl``（无法解析时抛 :class:`ValueError`）。"""
    stripped = text.lstrip("\ufeff \t\r\n")
    if not stripped:
        raise ValueError("输入为空，无法判断抓包格式")
    try:
        document = json.loads(stripped)
    except json.JSONDecodeError:
        # 多个 JSON 对象拼接 → JSONL
        return "jsonl"
    if _looks_like_har_document(document):
        return "har"
    if isinstance(document, (list, dict)):
        return "jsonl"
    raise ValueError("无法识别的抓包格式（既不是 HAR 1.2 也不是 JSONL 事件流）")


def load_entries_from_text(text: str, fmt: str = "auto") -> Tuple[List[Entry], str]:
    """按 ``fmt``（``auto``/``har``/``jsonl``）解析文本，返回 ``(entries, fmt)``。"""
    if fmt not in ("auto", "har", "jsonl"):
        raise ValueError(f"未知格式: {fmt!r}（可选 auto/har/jsonl）")
    resolved = detect_format(text) if fmt == "auto" else fmt
    entries = parse_har(text) if resolved == "har" else parse_jsonl(text)
    return entries, resolved


def load_entries(path: str, fmt: str = "auto") -> Tuple[List[Entry], str]:
    """读取抓包文件（HAR 或 JSONL），返回 ``(entries, fmt)``。"""
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        text = handle.read()
    return load_entries_from_text(text, fmt=fmt)
