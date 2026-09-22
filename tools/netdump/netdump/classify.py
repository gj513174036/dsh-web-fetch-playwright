"""netdump.classify —— 静态资源过滤与业务 API 候选判定（零第三方依赖）。

默认规则（与任务契约一致）：

* **过滤**：资源类型属于 ``image`` / ``font`` / ``media`` / ``stylesheet`` /
  ``script``，或 URL 路径扩展名属于 ``.js .css .png .jpg .jpeg .gif .svg .ico
  .woff .woff2 .ttf``（另含少量同类扩展名，见 :data:`EXTRA_STATIC_EXTENSIONS`），
  或请求的是页面文档（``document`` / ``text/html``，可用 ``include_documents`` 放开）。
* **保留（业务 API 候选）**，满足任意一条即保留：

  1. 资源类型是 ``xhr`` / ``fetch``；
  2. 响应是 JSON（``application/json``、``*+json``、``text/json``，或响应体本身可解析为 JSON）；
  3. 请求头带 ``Authorization`` 或 ``Cookie``；
  4. 非 GET/HEAD 请求且带请求体（``postData``）。

WebSocket（``ws`` / ``wss``）默认保留，但会被 :mod:`netdump.endpoints` 归到
``websockets`` 分组，而不是 HTTP 接口清单。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .har import Entry, url_path, url_scheme

__all__ = [
    "ClassifyOptions",
    "Decision",
    "DEFAULT_STATIC_EXTENSIONS",
    "DEFAULT_STATIC_RESOURCE_TYPES",
    "EXTRA_STATIC_EXTENSIONS",
    "STATIC_RESOURCE_TYPES",
    "api_signals",
    "classify_entries",
    "classify_entry",
    "is_json_mime",
    "is_static_asset",
    "url_extension",
]

#: 契约里点名必须过滤的扩展名。
DEFAULT_STATIC_EXTENSIONS: Tuple[str, ...] = (
    ".js",
    ".css",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
)

#: 同类静态扩展名（默认一并过滤，可用 ``extra_static_extensions`` 之外的开关调整）。
EXTRA_STATIC_EXTENSIONS: Tuple[str, ...] = (
    ".webp",
    ".avif",
    ".bmp",
    ".map",
    ".eot",
    ".otf",
    ".mp4",
    ".webm",
    ".mp3",
    ".m4a",
    ".mov",
    ".wav",
)

#: 契约里点名必须过滤的 HAR/CDP 资源类型。
DEFAULT_STATIC_RESOURCE_TYPES: Tuple[str, ...] = (
    "image",
    "font",
    "media",
    "stylesheet",
    "script",
)

#: 兼容旧名。
STATIC_RESOURCE_TYPES = DEFAULT_STATIC_RESOURCE_TYPES

_JSON_MIME_SUFFIX = "+json"
_JSON_MIMES = ("application/json", "text/json", "application/x-json")
_READ_METHODS = ("GET", "HEAD", "OPTIONS")


@dataclass
class ClassifyOptions:
    """过滤/保留策略开关。"""

    include_static: bool = False
    include_documents: bool = False
    include_websockets: bool = True
    static_extensions: Tuple[str, ...] = DEFAULT_STATIC_EXTENSIONS + EXTRA_STATIC_EXTENSIONS
    static_resource_types: Tuple[str, ...] = DEFAULT_STATIC_RESOURCE_TYPES
    keep_resource_types: Tuple[str, ...] = ("xhr", "fetch")


@dataclass
class Decision:
    """单条记录的判定结果。"""

    entry: Entry
    keep: bool
    reason: str
    signals: List[str] = field(default_factory=list)
    kind: str = "http"  # "http" | "websocket"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.entry.url,
            "method": self.entry.method,
            "resourceType": self.entry.resourceType,
            "status": self.entry.status,
            "keep": self.keep,
            "reason": self.reason,
            "signals": list(self.signals),
            "kind": self.kind,
        }


def url_extension(url: str) -> str:
    """返回 URL 路径最后一段的小写扩展名（含点），没有则返回空串。"""
    path = url_path(url)
    return os.path.splitext(path.lower())[1]


def is_json_mime(mime: str) -> bool:
    """``application/json`` / ``application/vnd.api+json`` / ``text/json`` 等。"""
    if not mime:
        return False
    base = mime.split(";", 1)[0].strip().lower()
    if not base:
        return False
    return base in _JSON_MIMES or base.endswith(_JSON_MIME_SUFFIX)


def _body_looks_like_json(entry: Entry) -> bool:
    """响应 mime 缺失时，用响应体兜底判断是不是 JSON。"""
    body = (entry.responseBody or "").strip()
    if not body or body[0] not in "{[":
        return False
    try:
        json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return False
    return True


def _has_header(entry: Entry, name: str) -> bool:
    want = name.lower()
    return any(key.lower() == want and bool(value) for key, value in entry.requestHeaders.items())


def _method_allows_body(method: str) -> bool:
    return method.upper() not in _READ_METHODS


def api_signals(entry: Entry, options: Optional[ClassifyOptions] = None) -> List[str]:
    """返回该记录命中的「业务 API」信号列表，空列表表示无信号。"""
    options = options or ClassifyOptions()
    signals: List[str] = []
    resource_type = (entry.resourceType or "").lower()

    if resource_type in options.keep_resource_types:
        signals.append(f"resource-type:{resource_type}")
    if is_json_mime(entry.responseMimeType) or _body_looks_like_json(entry):
        signals.append("json-response")
    if _has_header(entry, "authorization"):
        signals.append("authorization-header")
    if _has_header(entry, "cookie"):
        signals.append("cookie-header")
    if _method_allows_body(entry.method) and (entry.postData or "").strip():
        signals.append("write-request-with-body")
    if entry.wsFrames and entry.method.upper() in ("WS", "WSS"):
        signals.append("websocket-frames")
    return signals


def is_static_asset(entry: Entry, options: Optional[ClassifyOptions] = None) -> Tuple[bool, str]:
    """判断是否是静态资源，返回 ``(是否静态, 原因)``。"""
    options = options or ClassifyOptions()
    resource_type = (entry.resourceType or "").lower()
    if resource_type in tuple(t.lower() for t in options.static_resource_types):
        return True, f"static-resource-type:{resource_type}"
    extension = url_extension(entry.url)
    if extension and extension in tuple(e.lower() for e in options.static_extensions):
        return True, f"static-extension:{extension}"
    return False, ""


def classify_entry(entry: Entry, options: Optional[ClassifyOptions] = None) -> Decision:
    """对单条记录做出保留/过滤判定。"""
    options = options or ClassifyOptions()
    scheme = url_scheme(entry.url)
    resource_type = (entry.resourceType or "").lower()
    is_websocket = scheme in ("ws", "wss") or resource_type in ("websocket", "ws", "wss")

    if not entry.url:
        return Decision(entry=entry, keep=False, reason="empty-url", kind="websocket" if is_websocket else "http")

    if is_websocket:
        kind = "websocket"
        if not options.include_websockets:
            return Decision(entry=entry, keep=False, reason="websocket-disabled", kind=kind)
        if entry.wsFrames or scheme in ("ws", "wss"):
            return Decision(
                entry=entry,
                keep=True,
                reason="websocket",
                signals=api_signals(entry, options) or ["websocket"],
                kind=kind,
            )
        return Decision(entry=entry, keep=False, reason="websocket-without-frames", kind=kind)

    if scheme not in ("http", "https"):
        return Decision(entry=entry, keep=False, reason=f"unsupported-scheme:{scheme or 'none'}")

    static, static_reason = is_static_asset(entry, options)
    if static and not options.include_static:
        # 静态扩展名（.js/.png/...）默认过滤；但如果这条记录确实返回 JSON，
        # 说明它是被静态后缀伪装的业务接口（例如 /api/report.png 返回 JSON），
        # 保留它并标注原因。资源类型层面的静态过滤是硬性的（bundle 就是 bundle）。
        if static_reason.startswith("static-extension:"):
            signals = api_signals(entry, options)
            if "json-response" in signals:
                return Decision(
                    entry=entry,
                    keep=True,
                    reason="api-over-static-extension",
                    signals=signals + ["static-extension-overridden"],
                )
        return Decision(entry=entry, keep=False, reason=static_reason)

    if resource_type == "document" and not options.include_documents:
        return Decision(entry=entry, keep=False, reason="document-page")

    signals = api_signals(entry, options)
    if not signals and not options.include_static:
        return Decision(entry=entry, keep=False, reason="no-api-signal")
    if not signals:
        # include_static 场景：保留但标注不是 API
        return Decision(entry=entry, keep=True, reason="static-included", signals=["static-included"])
    return Decision(entry=entry, keep=True, reason=signals[0], signals=signals)


def classify_entries(
    entries: Sequence[Entry], options: Optional[ClassifyOptions] = None
) -> Tuple[List[Decision], List[Decision]]:
    """批量判定，返回 ``(保留, 过滤)`` 两组 :class:`Decision`。"""
    options = options or ClassifyOptions()
    kept: List[Decision] = []
    dropped: List[Decision] = []
    for entry in entries:
        decision = classify_entry(entry, options)
        (kept if decision.keep else dropped).append(decision)
    return kept, dropped
