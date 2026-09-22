"""netdump —— 离线抓包 → 业务 API 清单 → httpx 异步爬虫流水线（纯标准库）。

典型用法::

    # 1) 从插件 JSONL 抓包或标准 HAR 1.2 生成 endpoints.json + crawler.py
    PYTHONPATH=tools/netdump python3 -m netdump build capture.jsonl -o netdump-out
    PYTHONPATH=tools/netdump python3 -m netdump build capture.har --top 20 --proxy socks5://127.0.0.1:1080

    # 2) 只看抓包里有什么（不落盘）
    PYTHONPATH=tools/netdump python3 -m netdump summary capture.har

生成的 ``crawler.py`` 运行时依赖 httpx：``pip install "httpx[http2,socks]"``。
"""

from __future__ import annotations

__version__ = "0.1.0"

from .classify import ClassifyOptions, classify_entries, classify_entry  # noqa: E402
from .emit import emit_outputs, render_crawler, write_private_text  # noqa: E402
from .endpoints import build_endpoints_document  # noqa: E402
from .har import Entry, detect_format, load_entries  # noqa: E402

__all__ = [
    "ClassifyOptions",
    "Entry",
    "__version__",
    "build_endpoints_document",
    "classify_entries",
    "classify_entry",
    "detect_format",
    "emit_outputs",
    "load_entries",
    "render_crawler",
    "write_private_text",
]
