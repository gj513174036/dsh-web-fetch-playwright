#!/usr/bin/env python3
"""查询端口：输姓名（可加手机号）→ 点选同名患者 → 看这个人的全部记录与指标趋势。

**为什么不是一个纯 HTML 文件**

页面跑在浏览器里，而病例系统在内网、靠 Cookie 会话、常常还要走 SOCKS5 代理。
浏览器直接跨域打那个接口必然被 CORS 挡掉，Cookie 也带不过去。所以这里配一个
**只监听回环地址**的小服务：它把页面发出去，替页面去取数；取回来的数据已经过
``rules.py`` 判定，页面只负责展示。

**三条设计上的硬要求**

1. **同名必须由人来选**：``identity`` 接口的 ``telephone`` 参数被服务端忽略（实测），
   所以搜索返回**全部**同名候选（手机号打码），由点击决定是哪一个 —— 绝不自动挑一个。
2. **一次点击 = 一次完整采集**，进度实时可见（后台线程 + 轮询），不是让浏览器干等 60 秒；
   采到的事实照旧落盘（``--out``），所以重复查询走的是同一份可审计数据。
3. **判异常只有 ``rules.py`` 一处**：页面不做任何阈值判断，它只展示 ``ruleId`` / ``why``，
   这样"凭什么判它异常"永远可复盘。页面里的红/蓝/黄只表示严重度，不表示新判断。

用法::

    python3 tools/his/portal.py --curlrc session.curlrc --base https://his.example.org \\
        --endpoints endpoints.json --out portal-out --via-curl
    # 然后浏览器打开 http://127.0.0.1:8787
"""

from __future__ import annotations

import argparse
import datetime as dt
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

import rules
from collect import (
    Client,
    CollectError,
    Dictionaries,
    Endpoints,
    Sink,
    collect_person_records,
    data_of,
    fact_key,
    fact_row,
    load_curlrc,
    load_session_json,
    rows_of,
    trend_points,
)

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE_PATH = os.path.join(HERE, "portal.html")
#: 页面引用的静态文件（与"片内直查"共用同一份界面与判定，不能再复制一份）
STATIC_FILES = {
    "/portal-app.css": "text/css; charset=utf-8",
    "/portal-core.js": "text/javascript; charset=utf-8",
    "/portal-app.js": "text/javascript; charset=utf-8",
    "/portal-transport-http.js": "text/javascript; charset=utf-8",
}
JSON_HEADERS = {"Cache-Control": "no-store, max-age=0"}
COOKIE_NAME = "portal_token"
#: 不需要令牌的路径（什么也不暴露，仅用于探活）
PUBLIC_PATHS = ("/api/health",)

KIND_LABEL = {
    "visit": "就诊病历",
    "prescription": "处方/医嘱",
    "lab": "检验",
    "exam": "检查",
    "checkup": "体检",
    "crisis": "危急值",
    "trend": "单项历史",
}


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #


def to_date(value: Any) -> str:
    """把各种形状的"时间"折成 ``YYYY-MM-DD``。

    真机实测：``checkTime`` / ``clinicTime`` / ``medicalDate`` 有的是**毫秒时间戳**
    （``1790215175465``，int 而不是字符串），有的是 ``YYYY-MM-DD HH:MM:SS``。
    先按字符串取前缀会得到 "1790215175" 这种假日期，所以必须分开处理。
    """
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, (int, float)):
        number = int(value)
        if number >= 10**12:  # 毫秒
            try:
                return dt.datetime.fromtimestamp(number / 1000).date().isoformat()
            except (OverflowError, OSError, ValueError):
                return ""
        if number >= 10**9:  # 秒
            try:
                return dt.datetime.fromtimestamp(number).date().isoformat()
            except (OverflowError, OSError, ValueError):
                return ""
        if 19000101 <= number <= 29991231:  # YYYYMMDD
            text = str(number)
            return f"{text[:4]}-{text[4:6]}-{text[6:]}"
        return ""
    text = str(value).strip()
    if not text:
        return ""
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", text)
    if match:
        return match.group(0)
    if text.isdigit():
        return to_date(int(text))
    return text[:10] if len(text) >= 10 else ""


def item_key(name: Any) -> str:
    """同一个项目的不同写法折成一个键：``尿酸(UA)`` / ``尿酸（UA）`` / ``尿酸`` → ``尿酸``。

    检验单里括号是"英文缩写/方法学"的补充说明，单项历史里又常常不带括号 ——
    不折起来，"尿酸"这次偏高和上次偏高就会变成两张卡片，趋势也就断了。
    折得过头（比如把"葡萄糖(空腹)"和"葡萄糖"并成一个）由**单位一致性**兜底：
    单位冲突时卡片会显式标出来，不会静默把两种量纲画成一条线。
    """
    raw = str(name or "").strip()
    stripped = re.sub(r"[（(][^）)]*[）)]", "", raw)
    stripped = re.sub(r"\s+", "", stripped)
    return (stripped or raw).lower()


def mask_phone(value: Any) -> str:
    text = str(value or "").strip()
    if len(text) < 7:
        return text
    return f"{text[:3]}****{text[-4:]}"


def mask_card(value: Any) -> str:
    text = str(value or "").strip()
    if len(text) < 8:
        return text
    return f"{text[:4]}**********{text[-4:]}"


def series_key(row: dict[str, Any]) -> str:
    """一个指标点的身份。

    **优先用 ``itemCode``**（主数据项目编码），它是稳定身份：``尿酸(UA)`` 在不同组套里
    （"肾功3项" / "尿酸(尿酸酶法)"）编码都是 ``JYS00021``，该并成一条趋势；
    而"白细胞"在真机上是**三个不同项目** —— 尿白细胞 ``JYL00009``(Leu/ul)、
    尿沉渣白细胞 ``JYL00019``(个/ul)、大便白细胞 ``JYL00085``(/HP)。
    只按名字归并会把它们画成一条线（实测踩到），那是错的临床画面。
    没有编码时才退回项目名。
    """
    code = str(row.get("itemCode") or "").strip()
    if code:
        return f"code:{code}"
    return f"name:{item_key(row.get('itemName'))}"


def _now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# 事实 → 页面视图
# --------------------------------------------------------------------------- #


def _fact_label(fact: dict[str, Any]) -> str:
    kind = str(fact.get("kind") or "")
    extra = fact.get("extra") or {}
    label = KIND_LABEL.get(kind, kind or "记录")
    group = extra.get("groupItemName") or extra.get("medicalType")
    if kind == "checkup" and extra.get("medicalNo"):
        group = f"体检号 {extra['medicalNo']}"
    return f"{label} · {group}" if group else label


def _rows_by_item(fact: dict[str, Any], rows: list[dict[str, Any]]) -> list[tuple[Any, dict[str, Any] | None]]:
    """把"事实里的明细项"与"判定行"一一对上。

    ``evaluate_fact`` 会跳过非 dict 的项，直接 ``zip`` 会错位；这里按下标配。
    """
    paired: list[tuple[Any, dict[str, Any] | None]] = []
    index = 0
    for item in fact.get("items") or []:
        if not isinstance(item, dict):
            paired.append((item, None))
            continue
        paired.append((item, rows[index] if index < len(rows) else None))
        index += 1
    return paired


def _point_of(row: dict[str, Any], label: str) -> dict[str, Any]:
    date = to_date(row.get("checkTime")) or str(row.get("date") or "")
    return {
        "date": date,
        "time": "" if row.get("checkTime") is None else str(row.get("checkTime")),
        "value": rules.parse_number(row.get("result")),
        "text": "" if row.get("result") is None else str(row.get("result")),
        "unit": str(row.get("unit") or ""),
        "reference": str(row.get("reference") or ""),
        "refLow": row.get("refLow"),
        "refHigh": row.get("refHigh"),
        "refKind": row.get("refKind"),
        "verdict": row.get("verdict"),
        "severity": row.get("severity"),
        "flagText": row.get("flagText"),
        "arrow": row.get("arrow"),
        "why": row.get("why"),
        "ruleId": row.get("ruleId"),
        "itemName": row.get("itemName"),
        "itemCode": row.get("itemCode"),
        "kind": row.get("kind"),
        "source": label,
        "sourceId": row.get("sourceId"),
    }


def _finalize_series(key: str, points: list[dict[str, Any]]) -> dict[str, Any]:
    """一组同项目的点 → 一张趋势卡的数据。"""
    ordered = sorted(points, key=lambda point: (point.get("date") or "9999-99-99", point.get("time") or ""))
    units = [point["unit"] for point in ordered if point["unit"]]
    unit = max(sorted(set(units)), key=units.count) if units else ""
    names = [str(point["itemName"]) for point in ordered if point.get("itemName")]
    # 显示名取"出现最多、其次最长"的那个：同一项目在不同报告里可能带或不带括号缩写，
    # 排序后再取保证同样输入永远得到同一个名字（不依赖 set 的遍历顺序）。
    name = max(sorted(set(names)), key=lambda value: (names.count(value), len(value))) if names else key
    numeric = [point for point in ordered if point.get("value") is not None]
    severities = [str(point.get("severity") or "info") for point in ordered]
    worst = min(severities, key=lambda value: rules.SEVERITY_ORDER.get(value, 3)) if severities else "info"
    latest = ordered[-1] if ordered else {}
    delta = None
    if len(numeric) >= 2:
        delta = round(float(numeric[-1]["value"]) - float(numeric[-2]["value"]), 6)
    return {
        "key": key,
        "name": name,
        "unit": unit,
        "unitConflict": len({point["unit"] for point in ordered if point["unit"]}) > 1,
        "points": ordered,
        "numeric": numeric,
        "worst": worst,
        "latest": latest,
        "latestSeverity": str(latest.get("severity") or "info"),
        "delta": delta,
        "dates": len({point["date"] for point in ordered if point["date"]}),
        "abnormalCount": sum(1 for point in ordered if str(point.get("severity")) != "info"),
        "refLow": latest.get("refLow"),
        "refHigh": latest.get("refHigh"),
        "reference": latest.get("reference") or "",
        "sources": sorted({point["source"] for point in ordered}),
    }


def build_view(patient: dict[str, Any], facts: list[dict[str, Any]], meta: dict[str, Any]) -> dict[str, Any]:
    """事实行 + 判定 → 页面要的那一份 JSON（唯一的数据来源）。"""
    per_fact: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    all_rows: list[dict[str, Any]] = []
    for fact in facts:
        rows = rules.evaluate_fact(fact)
        per_fact.append((fact, rows))
        all_rows.extend(rows)

    # ① 指标序列：收"有数值语义的明细"（检验 + 单项历史 + 危急值），
    #    处方和体检结论不进来 —— 那是"开过什么药 / 诊断过什么"，不是化验值。
    buckets: dict[str, list[dict[str, Any]]] = {}
    crisis_points: list[dict[str, Any]] = []
    for fact, rows in per_fact:
        kind = str(fact.get("kind"))
        if kind not in ("lab", "trend", "crisis"):
            continue
        label = _fact_label(fact)
        for item, row in _rows_by_item(fact, rows):
            if row is None:
                continue
            if not (str(row.get("itemName") or "").strip() or str(row.get("itemCode") or "").strip()):
                continue
            point = _point_of(row, label)
            # 危急值模块给的是"危急值类型码"，不是项目编码，不能当身份；
            # 它的点先攒着，下面尽量并进同名的检验序列。
            if kind == "crisis":
                crisis_points.append(point)
            else:
                buckets.setdefault(series_key(row), []).append(point)

    # 危急值点并进同名的检验序列（**只有同名序列唯一时才并**，否则自成一张卡）。
    # 真机上"血钾 7.10"检验明细说偏高、危急值模块说危急，并起来这张卡才说得清；
    # 而"肺结节"这种没有对应检验序列的，就该是独立一张卡。
    name_index: dict[str, set[str]] = {}
    for key, points in buckets.items():
        for point in points:
            name_index.setdefault(item_key(point.get("itemName")), set()).add(key)
    for point in crisis_points:
        candidates = name_index.get(item_key(point.get("itemName"))) or set()
        target = next(iter(candidates)) if len(candidates) == 1 else f"crisis:{item_key(point.get('itemName'))}"
        buckets.setdefault(target, []).append(point)

    series = {key: _finalize_series(key, points) for key, points in buckets.items()}
    for entry in series.values():
        entry["points"] = entry["points"][-200:]

    abnormal = sorted(
        (entry for entry in series.values() if entry["worst"] != "info"),
        key=lambda entry: (rules.SEVERITY_ORDER.get(entry["worst"], 3), entry["name"]),
    )
    trends = sorted(
        (entry for entry in series.values() if len(entry["numeric"]) >= 2),
        key=lambda entry: (-entry["dates"], entry["name"]),
    )

    # ② 就诊 + 处方
    visits: list[dict[str, Any]] = []
    prescriptions: list[dict[str, Any]] = []
    by_visit: dict[str, dict[str, Any]] = {}
    for fact, _rows in per_fact:
        if fact.get("kind") != "visit":
            continue
        extra = fact.get("extra") or {}
        visit = {
            "id": fact["source"]["sourceId"],
            "date": to_date(extra.get("clinicTime")) or fact.get("date"),
            "deptName": extra.get("deptName"),
            "recordsNo": extra.get("recordsNo"),
            "mainSuit": extra.get("mainSuit"),
            "diagnoses": [str(row.get("diagnosisName")) for row in (extra.get("diagnosisList") or [])
                          if isinstance(row, dict) and row.get("diagnosisName")],
            "prescriptions": [],
        }
        visits.append(visit)
        by_visit[str(visit["id"])] = visit
    for fact, rows in per_fact:
        if fact.get("kind") != "prescription":
            continue
        visit = by_visit.get(str(fact["source"]["sourceId"]))
        for item, row in _rows_by_item(fact, rows):
            if not isinstance(item, dict):
                continue
            entry = {
                "date": to_date(item.get("checkTime")) or (visit or {}).get("date") or fact.get("date"),
                "itemName": item.get("itemName"),
                "spec": item.get("reference"),
                "usage": item.get("usage"),
                "frequency": item.get("frequency"),
                "orderType": item.get("orderType"),
                "status": item.get("flagText"),
                "price": item.get("price"),
                "itemKind": item.get("itemKind"),
                "summary": item.get("result"),
                "verdict": (row or {}).get("verdict"),
                "visitId": fact["source"]["sourceId"],
            }
            prescriptions.append(entry)
            if visit is not None:
                visit["prescriptions"].append(entry)
    visits.sort(key=lambda visit: str(visit.get("date") or ""), reverse=True)
    prescriptions.sort(key=lambda entry: str(entry.get("date") or ""), reverse=True)

    # ③ 检验 / 检查 / 体检 / 危急值
    labs: list[dict[str, Any]] = []
    exams: list[dict[str, Any]] = []
    checkups: list[dict[str, Any]] = []
    crises: list[dict[str, Any]] = []
    for fact, rows in per_fact:
        kind = fact.get("kind")
        extra = fact.get("extra") or {}
        label = _fact_label(fact)
        if kind == "lab":
            items = []
            date = ""
            for item, row in _rows_by_item(fact, rows):
                if not isinstance(item, dict) or row is None:
                    continue
                date = date or to_date(row.get("checkTime"))
                items.append({
                    "itemName": row.get("itemName"),
                    "result": row.get("result"),
                    "unit": row.get("unit"),
                    "reference": row.get("reference"),
                    "flagText": row.get("flagText"),
                    "arrow": row.get("arrow"),
                    "verdict": row.get("verdict"),
                    "severity": row.get("severity"),
                    "why": row.get("why"),
                    "ruleId": row.get("ruleId"),
                    "refLow": row.get("refLow"),
                    "refHigh": row.get("refHigh"),
                })
            labs.append({
                "id": fact["source"]["sourceId"],
                "date": date or to_date(extra.get("checkTime")) or fact.get("date"),
                "group": extra.get("groupItemName"),
                "items": items,
                "abnormal": sum(1 for item in items if item["severity"] != "info"),
            })
        elif kind == "exam":
            exams.append({
                "id": fact["source"]["sourceId"],
                "date": to_date(extra.get("checkTime")) or fact.get("date"),
                "group": extra.get("groupItemName"),
                "doctor": extra.get("checkDoctorName"),
                "conclusion": extra.get("checkResult") or extra.get("reportResult") or "",
            })
        elif kind == "checkup":
            diagnoses = []
            for item, row in _rows_by_item(fact, rows):
                if not isinstance(item, dict):
                    continue
                diagnoses.append({
                    "name": item.get("disease") or item.get("itemName"),
                    "level": item.get("level"),
                    "levelName": item.get("flagText"),
                    "severity": (row or {}).get("severity"),
                    "verdict": (row or {}).get("verdict"),
                    "why": (row or {}).get("why"),
                })
            checkups.append({
                "id": fact["source"]["sourceId"],
                "date": to_date(extra.get("medicalDate")) or fact.get("date"),
                "medicalNo": extra.get("medicalNo"),
                "medicalType": extra.get("medicalType"),
                "medicalGroup": extra.get("medicalGroup"),
                "grade": extra.get("grade"),
                "diagnoses": diagnoses,
            })
        elif kind == "crisis":
            for item, row in _rows_by_item(fact, rows):
                if not isinstance(item, dict):
                    continue
                crises.append({
                    "date": to_date(item.get("checkTime")) or fact.get("date"),
                    "itemName": item.get("itemName"),
                    "result": item.get("result"),
                    "unit": item.get("unit"),
                    "level": item.get("crisisValue"),
                    "status": item.get("flagText"),
                    "disease": item.get("disease"),
                    "severity": (row or {}).get("severity"),
                    "why": (row or {}).get("why"),
                    "source": label,
                })
    labs.sort(key=lambda entry: str(entry.get("date") or ""), reverse=True)
    exams.sort(key=lambda entry: str(entry.get("date") or ""), reverse=True)
    checkups.sort(key=lambda entry: str(entry.get("date") or ""), reverse=True)
    crises.sort(key=lambda entry: str(entry.get("date") or ""), reverse=True)

    # ④ 待人工复核：这一档是**故意**留给人看的，不是失败
    review = [
        {
            "itemName": row.get("itemName"),
            "result": row.get("result"),
            "reference": row.get("reference"),
            "date": to_date(row.get("checkTime")) or row.get("date"),
            "why": row.get("why"),
            "ruleId": row.get("ruleId"),
            "source": KIND_LABEL.get(str(row.get("kind")), str(row.get("kind"))),
        }
        for row in all_rows if row.get("severity") == "review"
    ]

    by_verdict: dict[str, int] = {}
    by_rule: dict[str, int] = {}
    by_kind: dict[str, int] = {}
    for row in all_rows:
        by_verdict[str(row.get("verdict"))] = by_verdict.get(str(row.get("verdict")), 0) + 1
        by_rule[str(row.get("ruleId"))] = by_rule.get(str(row.get("ruleId")), 0) + 1
    for fact in facts:
        kind = str(fact.get("kind"))
        by_kind[kind] = by_kind.get(kind, 0) + 1

    counts = {
        "visits": len(visits),
        "prescriptions": len(prescriptions),
        "labs": len(labs),
        "exams": len(exams),
        "checkups": len(checkups),
        "crises": len(crises),
        "items": len(all_rows),
        "abnormalItems": len(abnormal),
        "crisis": sum(1 for entry in abnormal if entry["worst"] == "crisis"),
        "abnormal": sum(1 for entry in abnormal if entry["worst"] == "abnormal"),
        "reviewItems": len(abnormal) - sum(1 for entry in abnormal if entry["worst"] in ("crisis", "abnormal")),
        "reviewRows": len(review),
        "trends": len(trends),
    }

    return {
        "patient": {
            "name": patient.get("name"),
            "sex": patient.get("sex"),
            "age": patient.get("age"),
            "telephone": patient.get("telephone"),
            "telephoneMasked": patient.get("telephoneMasked") or mask_phone(patient.get("telephone")),
            "identityCardMasked": patient.get("identityCardMasked") or mask_card(patient.get("identityCard")),
            "hisUserId": patient.get("hisUserId"),
            "hmsUserId": patient.get("hmsUserId"),
        },
        "meta": meta,
        "counts": counts,
        "abnormal": abnormal,
        "trends": trends,
        "visits": visits,
        "prescriptions": prescriptions,
        "labs": labs,
        "exams": exams,
        "checkups": checkups,
        "crises": crises,
        "review": review,
        "audit": {"byVerdict": by_verdict, "byRule": by_rule, "byKind": by_kind},
    }


def load_facts(path: str, patient: dict[str, Any]) -> list[dict[str, Any]]:
    """从事实文件里只取这个人的行。

    不能只用"本次新写的事实"：``Sink`` 有断点续跑，第二次点同一个人时一条都不新写，
    视图就会是空的。落盘的那份才是权威（也正好和命令行采集共用同一批数据）。
    """
    his = str(patient.get("hisUserId") or "")
    hms = str(patient.get("hmsUserId") or "")
    out: list[dict[str, Any]] = []
    if not (his or hms) or not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                fact = json.loads(line)
            except json.JSONDecodeError:
                continue  # 中断留下的半行
            who = fact.get("patient") or {}
            if (his and str(who.get("hisUserId") or "") == his) or \
                    (hms and str(who.get("hmsUserId") or "") == hms):
                out.append(fact)
    return out


# --------------------------------------------------------------------------- #
# 端口状态：搜索 / 采集任务 / 缓存
# --------------------------------------------------------------------------- #


class Portal:
    """一个进程内的全部状态。HTTP 层只做协议，业务都在这里。"""

    def __init__(
        self,
        session: Any,
        endpoints: Endpoints,
        outdir: str,
        tag: str,
        via_curl: bool = False,
        dictionaries: bool = True,
        cache_ttl: float = 600.0,
        verbose: bool = False,
        token: str = "",
    ) -> None:
        self.session = session
        self.endpoints = endpoints
        self.outdir = outdir
        self.tag = tag
        self.via_curl = via_curl
        self.dictionaries_enabled = dictionaries
        self.cache_ttl = cache_ttl
        self.verbose = verbose
        #: 访问令牌。为空表示不需要（只在监听回环时允许为空）。
        self.token = token
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._cache: dict[str, dict[str, Any]] = {}
        self._dicts: Dictionaries | None = None

    # -- 字典：加载一次，之后所有查询共用 ---------------------------------- #
    def dicts(self) -> Dictionaries:
        with self._lock:
            if self._dicts is None:
                with Client(self.session, via_curl=self.via_curl) as client:
                    self._dicts = Dictionaries(client, self.endpoints, enabled=self.dictionaries_enabled)
            return self._dicts

    def facts_path(self) -> str:
        return os.path.join(self.outdir, f"facts-{self.tag}.jsonl")

    # -- 搜索 -------------------------------------------------------------- #
    def search(self, name: str, telephone: str = "") -> list[dict[str, Any]]:
        """姓名 → **全部**同名候选。手机号只用来标"就是他"，绝不替人做决定。"""
        path, params = self.endpoints.render("identity", name=name, pageNum=1, pageSize=50)
        with Client(self.session, via_curl=self.via_curl) as client:
            rows = rows_of(client.get(path, **params))
        wanted = str(telephone or "").strip()
        dicts = self.dicts()
        out: list[dict[str, Any]] = []
        for row in rows:
            phone = str(row.get("telephone") or "")
            out.append({
                "name": row.get("name"),
                "sex": dicts.label("sex", row.get("gender")) or str(row.get("gender") or ""),
                "age": row.get("age"),
                # 页面只拿到打码后的手机号/身份证：够用来区分同名，又不把完整身份信息
                # 送进浏览器。精确匹配在服务端做（phoneMatch），页面不需要原文。
                "telephoneMasked": mask_phone(phone),
                "identityCardMasked": mask_card(row.get("identityCard")),
                "phoneMatch": bool(wanted) and phone == wanted,
                "hisUserId": row.get("id"),
                "hmsUserId": row.get("hmsArchivesUserId"),
            })
        out.sort(key=lambda entry: (not entry["phoneMatch"], str(entry["name"] or "")))
        return out

    # -- 采集任务 ---------------------------------------------------------- #
    def _prune(self) -> None:
        if len(self._jobs) <= 40:
            return
        for job_id in sorted(self._jobs, key=lambda key: self._jobs[key].get("startedAt") or "")[:20]:
            self._jobs.pop(job_id, None)

    def start(self, candidate: dict[str, Any], refresh: bool = False) -> str:
        his = str(candidate.get("hisUserId") or "")
        hms = str(candidate.get("hmsUserId") or "")
        if not (his or hms):
            raise CollectError("这条候选没有可用的患者 id，无法采集")
        key = f"{his}|{hms}"
        job_id = uuid.uuid4().hex[:12]
        with self._lock:
            cached = self._cache.get(key)
            if cached and not refresh and time.time() - float(cached.get("_at") or 0) < self.cache_ttl:
                self._jobs[job_id] = {
                    "state": "done", "phase": "缓存", "done": 1, "total": 1, "cached": True,
                    "result": cached["view"], "startedAt": _now(), "finishedAt": _now(), "error": "",
                }
                return job_id
            self._jobs[job_id] = {
                "state": "queued", "phase": "排队", "done": 0, "total": 1, "cached": False,
                "result": None, "startedAt": _now(), "finishedAt": "", "error": "",
            }
            self._prune()
        threading.Thread(target=self._run, args=(job_id, candidate, key), daemon=True).start()
        return job_id

    def _run(self, job_id: str, candidate: dict[str, Any], key: str) -> None:
        job = self._jobs[job_id]

        def progress(phase: str, done: int, total: int) -> None:
            with self._lock:
                job["state"] = "running"
                job["phase"] = phase
                job["done"] = int(done)
                job["total"] = max(int(total), 1)

        try:
            with self._lock:
                job["state"] = "running"
            patient = {
                "hisUserId": candidate.get("hisUserId"),
                "hmsUserId": candidate.get("hmsUserId"),
                "name": candidate.get("name"),
                "sex": candidate.get("sex"),
                "age": candidate.get("age"),
                # 候选行给的是打码值；直接用，别再打一次码（会把 **** 也当成原文）
                "telephoneMasked": candidate.get("telephoneMasked"),
                "identityCardMasked": candidate.get("identityCardMasked"),
            }
            sink = Sink(self.outdir, self.tag)
            dicts = self.dicts()
            with Client(self.session, via_curl=self.via_curl) as client:
                summary = collect_person_records(
                    client, self.endpoints, sink, patient, dicts,
                    with_trends=False, on_progress=progress, day=self.tag,
                )
                errors = list(client.errors)
            facts = load_facts(sink.facts_path, patient)
            view = build_view(patient, facts, {
                "collectedAt": _now(),
                "day": self.tag,
                "factsPath": sink.facts_path,
                "rawPath": sink.raw_path,
                "session": self.session.mask(),
                "dictionaries": dicts.loaded(),
                "summary": summary,
                "errors": errors,
            })
            with self._lock:
                job.update(state="done", phase="完成", done=1, total=1, result=view,
                           finishedAt=_now(), error="")
                self._cache[key] = {"_at": time.time(), "view": view}
        except Exception as error:  # noqa: BLE001  —— 任务失败要变成页面上的红字，不是崩掉服务
            with self._lock:
                job.update(state="failed", phase="失败", finishedAt=_now(),
                           error=f"{type(error).__name__}: {error}")

    def job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return {
                "state": job["state"], "phase": job["phase"], "done": job["done"],
                "total": job["total"], "cached": job.get("cached", False),
                "error": job.get("error") or "", "result": job.get("result"),
                "startedAt": job.get("startedAt"), "finishedAt": job.get("finishedAt"),
            }

    # -- 单项历史（按需拉更长的历史，不拖慢首屏） --------------------------- #
    def item_history(self, candidate: dict[str, Any], item_name: str) -> dict[str, Any]:
        hms = str(candidate.get("hmsUserId") or "")
        if not hms:
            raise CollectError("这个人没有档案侧 id（hmsUserId），拿不到单项历史")
        name = str(item_name or "").strip()
        if not name:
            raise CollectError("缺少项目名")
        patient = {
            "hisUserId": candidate.get("hisUserId"),
            "hmsUserId": candidate.get("hmsUserId"),
            "name": candidate.get("name"),
            "telephone": candidate.get("telephone"),
        }
        sink = Sink(self.outdir, self.tag)
        path, params = self.endpoints.render("itemHistory", itemName=name, userId=hms)
        key = fact_key(self.tag, patient, "trend", name)
        if key in sink.done:
            fact = next((row for row in load_facts(sink.facts_path, patient)
                         if row.get("key") == key), None)
        else:
            with Client(self.session, via_curl=self.via_curl) as client:
                doc = client.get(path, **params)
            items = trend_points(data_of(doc))
            fact = fact_row(day=self.tag, patient=patient, kind="trend", source_id=name,
                            endpoint=path, items=items, extra={"groupItemName": name})
            sink.fact(fact)
        if not fact:
            raise CollectError(f"{name}: 单项历史没有返回任何点")
        label = _fact_label(fact)
        rows = rules.evaluate_fact(fact)
        points = [_point_of(row, label) for _item, row in _rows_by_item(fact, rows) if row is not None]
        return _finalize_series(item_key(name), points)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    portal: Portal

    def log_message(self, fmt: str, *args: Any) -> None:
        if getattr(self.portal, "verbose", False):
            sys.stderr.write(f"[portal] {fmt % args}\n")

    def _authorized(self, query: dict[str, list[str]]) -> bool:
        """令牌校验：``?token=`` 或 ``Cookie: portal_token=``。

        ``?token=`` 命中后会立刻设 Cookie 并 302 掉地址栏里的令牌 —— 令牌不该留在
        浏览器历史、书签和同事发来的截图里。
        """
        token = getattr(self.portal, "token", "")
        if token:
            supplied = (query.get("token") or [""])[0]
            if not supplied:
                for chunk in (self.headers.get("Cookie") or "").split(";"):
                    name, _, value = chunk.strip().partition("=")
                    if name == COOKIE_NAME:
                        supplied = value
                        break
            if not supplied or not hmac.compare_digest(str(supplied), token):
                return False
        return True

    def _wants_redirect(self, query: dict[str, list[str]]) -> bool:
        """带 ``?token=`` 的首次访问：换成 Cookie 再跳回干净地址。"""
        token = getattr(self.portal, "token", "")
        return bool(token) and bool((query.get("token") or [""])[0])

    def _send(self, payload: bytes, content_type: str, code: int = 200) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in JSON_HEADERS.items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _json(self, doc: Any, code: int = 200) -> None:
        self._send(json.dumps(doc, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8", code)

    def _fail(self, message: str, code: int = 400) -> None:
        self._json({"error": message}, code)

    def do_GET(self) -> None:  # noqa: N802  (stdlib 命名)
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        one = lambda key: (query.get(key) or [""])[0]  # noqa: E731
        if parsed.path not in PUBLIC_PATHS:
            if not self._authorized(query):
                self._json({"error": "需要访问令牌：用启动时打印的那个带 ?token= 的网址打开"}, 401)
                return
            if self._wants_redirect(query) and self.command == "GET":
                self.send_response(302)
                self.send_header("Location", parsed.path or "/")
                self.send_header("Set-Cookie",
                                 f"{COOKIE_NAME}={self.portal.token}; Path=/; HttpOnly; SameSite=Lax")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        try:
            if parsed.path in ("/", "/index.html", "/portal.html"):
                self._page()
            elif parsed.path in STATIC_FILES:
                self._static(parsed.path)
            elif parsed.path == "/favicon.ico":
                # 浏览器会自己来要图标；没有就干脆回 204，别在控制台留 404 噪声
                self._send(b"", "image/x-icon", 204)
            elif parsed.path == "/api/health":
                # 探活不需要令牌，但**只有持令牌的人**才看得到会话与落盘路径 ——
                # 那些里面有内网基地址，"页面在哪台机器上"这类信息不该白送给整个局域网。
                if not self._authorized(query):
                    self._json({"ok": True})
                else:
                    self._json({
                        "ok": True,
                        "session": self.portal.session.mask(),
                        "outdir": os.path.abspath(self.portal.outdir),
                        "day": self.portal.tag,
                        "viaCurl": self.portal.via_curl,
                        "dictionaries": self.portal.dicts().loaded(),
                    })
            elif parsed.path == "/api/search":
                name = one("name").strip()
                if not name:
                    self._fail("请至少输入姓名（同名靠手机号区分，点选决定采谁）")
                    return
                self._json({"candidates": self.portal.search(name, one("telephone"))})
            elif parsed.path == "/api/job":
                job = self.portal.job(one("id"))
                if job is None:
                    self._fail("没有这个任务", 404)
                else:
                    self._json(job)
            elif parsed.path == "/api/item-history":
                candidate = {
                    "hisUserId": one("hisUserId"), "hmsUserId": one("hmsUserId"),
                    "name": one("name"), "telephone": one("telephone"),
                }
                self._json({"series": self.portal.item_history(candidate, one("itemName"))})
            else:
                self._fail("没有这个路径", 404)
        except CollectError as error:
            self._fail(str(error), 502)
        except Exception as error:  # noqa: BLE001
            self._fail(f"{type(error).__name__}: {error}", 500)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if not self._authorized(parse_qs(parsed.query)):
            self._json({"error": "需要访问令牌"}, 401)
            return
        if parsed.path != "/api/collect":
            self._fail("没有这个路径", 404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("请求体必须是 JSON 对象")
            job_id = self.portal.start(body, bool(body.get("refresh")))
            self._json({"jobId": job_id})
        except CollectError as error:
            self._fail(str(error), 502)
        except Exception as error:  # noqa: BLE001
            self._fail(f"{type(error).__name__}: {error}", 500)

    def _page(self) -> None:
        try:
            with open(PAGE_PATH, "rb") as handle:
                self._send(handle.read(), "text/html; charset=utf-8")
        except OSError as error:
            self._fail(f"读不了页面 {PAGE_PATH}: {error}", 500)

    def _static(self, path: str) -> None:
        """页面引用的 JS/CSS。

        只按白名单发固定几个文件（`STATIC_FILES`），不接受任意路径 —— 这个服务的手上
        有患者数据，别给自己开一个目录穿越的口子。
        """
        content_type = STATIC_FILES.get(path)
        if not content_type:
            self._fail("没有这个静态文件", 404)
            return
        try:
            with open(os.path.join(HERE, path.lstrip("/")), "rb") as handle:
                self._send(handle.read(), content_type)
        except OSError as error:
            self._fail(f"读不了 {path}: {error}", 500)


def create_server(portal: Portal, host: str = "127.0.0.1", port: int = 8787) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"portal": portal})
    return ThreadingHTTPServer((host, port), handler)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="病例查询端口（本地页面 + 采集服务）")
    parser.add_argument("--endpoints", required=True, help="端点表 JSON（见 tools/his/endpoints.example.json）")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--curlrc", help="curl 配置（含 Cookie 与 proxy），通常从抓包导出")
    source.add_argument("--session", help="JSON：{base, headers, proxy}")
    parser.add_argument("--base", help="基地址，如 https://his.example.org")
    parser.add_argument("--out", default="portal-out", help="事实/原文落盘目录（0700，与命令行采集共用）")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认只监听本机")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--allow-remote", action="store_true",
                        help="允许监听非回环地址（页面里有患者数据，默认拒绝）")
    parser.add_argument("--token", help="访问令牌；监听非回环地址时自动生成一个（除非显式给了）")
    parser.add_argument("--no-token", action="store_true", help="不要令牌（只建议在纯回环+可信机器上）")
    parser.add_argument("--via-curl", action="store_true", help="走系统 curl（支持 socks5h 代理）")
    parser.add_argument("--no-dictionaries", action="store_true", help="跳过字典翻译")
    parser.add_argument("--cache-ttl", type=float, default=600.0, help="同一患者的结果缓存秒数")
    parser.add_argument("--date", help="事实落盘的日期标签，默认今天")
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    parser.add_argument("--verbose", action="store_true", help="打印每个请求")
    return parser


def _loopback(host: str) -> bool:
    return host in ("127.0.0.1", "localhost", "::1") or host.startswith("127.")


#: 这些接口上的地址用户不可能拿去开页面（docker 网桥、容器 veth）
_VIRTUAL_PREFIX = ("docker", "br-", "veth", "virbr", "vnet", "cni", "flannel")


def _classify_addresses(pairs: list[tuple[str, str]]) -> tuple[list[str], list[str]]:
    """``(接口, IPv4)`` → ``(真实网卡地址, 虚拟接口地址)``。

    真机实测：这台机器上光 docker 网桥就有十几个（``172.17.0.1`` 之类），
    全打出来会把真正有用的那两个（物理网卡 + 代理所在的 tun0）淹掉。
    """
    real, virtual = [], []
    for name, address in pairs:
        if not address or address.startswith("127."):
            continue
        (virtual if name.startswith(_VIRTUAL_PREFIX) else real).append(address)
    return real, virtual


def _address_report(pairs: list[tuple[str, str]], preferred: str = "",
                    limit: int = 4) -> tuple[list[str], int]:
    """→ ``(要展示的地址, 被折叠掉的地址个数)``。

    有真实网卡就只展示它们（虚拟接口折成一行"另有 N 个"）；
    一台真实网卡都没有时才退回虚拟地址，因为那时候它至少还能用。
    """
    real, virtual = _classify_addresses(pairs)
    ordered = ([preferred] if preferred in real else []) + [a for a in real if a != preferred]
    if ordered:
        return ordered[:limit], max(0, len(real) - limit) + len(virtual)
    return virtual[:limit], max(0, len(virtual) - limit)


def _interface_pairs() -> list[tuple[str, str]]:
    """``[(接口名, IPv4), …]``：直接从网卡读地址（不依赖 ``ip`` 命令是否存在）。"""
    import fcntl
    import socket as _socket
    import struct

    pairs: list[tuple[str, str]] = []
    try:
        names = sorted(os.listdir("/sys/class/net"))
    except OSError:
        names = []
    for name in names:
        if name == "lo":
            continue
        probe = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        try:
            packed = struct.pack("256s", name.encode("utf-8")[:15])
            result = fcntl.ioctl(probe.fileno(), 0x8915, packed)  # SIOCGIFADDR
            pairs.append((name, _socket.inet_ntoa(result[20:24])))
        except OSError:
            pass
        finally:
            probe.close()
    if pairs:
        return pairs
    probe = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)  # 兜底：默认出口
    try:
        probe.connect(("8.8.8.8", 80))
        return [("", probe.getsockname()[0])]
    except OSError:
        return []
    finally:
        probe.close()


def _local_addresses(preferred: str = "") -> list[str]:
    """本机可展示的 IPv4 地址（按"该不该给用户看"排序）。"""
    return _address_report(_interface_pairs(), preferred)[0]


def _default_route_ip() -> str:
    import socket as _socket
    probe = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except OSError:
        return ""
    finally:
        probe.close()


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    # 监听策略先判：它只看命令行，与"会话能不能读到"无关。
    # 先读配置再拒绝，用户会看到"读不了 session.json"而看不到真正的拒绝理由。
    loopback = _loopback(args.host)
    if not loopback and not args.allow_remote:
        print(f"[portal] 拒绝监听 {args.host}：页面会展示患者数据，请用 --allow-remote 明确同意",
              file=sys.stderr)
        return 2

    # 令牌策略：显式给了就用；监听非回环地址时自动生成（患者数据不该裸奔在局域网上）；
    # 纯回环 + --no-token 才允许没有令牌。
    token = args.token or ""
    generated = False
    if not token and not args.no_token and not loopback:
        token = secrets.token_urlsafe(18)
        generated = True
    if not loopback and not token:
        print("[portal] 监听非回环地址却没有令牌，拒绝启动（去掉 --no-token 即为自动生成）", file=sys.stderr)
        return 2

    try:
        session = load_curlrc(args.curlrc) if args.curlrc else load_session_json(args.session)
        if args.base:
            session.base = args.base.rstrip("/")
        endpoints = Endpoints.load(args.endpoints)
    except (CollectError, OSError) as error:
        print(f"[portal] 配置错误: {error}", file=sys.stderr)
        return 2

    tag = args.date or dt.date.today().isoformat()
    os.makedirs(args.out, mode=0o700, exist_ok=True)
    portal = Portal(session, endpoints, args.out, tag,
                    via_curl=args.via_curl, dictionaries=not args.no_dictionaries,
                    cache_ttl=args.cache_ttl, verbose=args.verbose, token=token)
    server = create_server(portal, args.host, args.port)
    host, port = server.server_address[0], server.server_address[1]
    suffix = f"?token={token}" if token else ""
    print(f"[portal] {session.mask()}")
    if _loopback(host):
        print(f"[portal] 查询端口已就绪: http://127.0.0.1:{port}/{suffix}")
    else:
        # 从别的机器（或经 SOCKS5 代理）访问时，127.0.0.1 指的是**访问者自己**，
        # 所以必须用本机在局域网上的地址。
        show, folded = _address_report(_interface_pairs(), _default_route_ip())
        if not show:
            show, folded = ["127.0.0.1"], 0
        print(f"[portal] 查询端口已就绪（{host}:{port}）：")
        for address in show:
            print(f"[portal]     http://{address}:{port}/{suffix}")
        if folded:
            print(f"[portal]     （另有 {folded} 个 docker/网桥地址没列出来，一般用不上）")
        print("[portal] 浏览器在另一台机器上时用上面的地址；有些 SOCKS5 代理会拒绝 127.0.0.1"
              "（防 SSRF），也必须用这些地址。")
    if generated:
        print("[portal] 已自动生成访问令牌（--token 可指定，--no-token 可关闭）")
    if token:
        print("[portal] 首次访问会带上 ?token=…，随后写进 Cookie 并跳转到干净地址。")
    print(f"[portal] 事实落盘: {os.path.abspath(args.out)}/facts-{tag}.jsonl")
    print("[portal] Ctrl-C 停止。数据只在你这台机器与浏览器之间。")
    # 输出被重定向到日志时 stdout 是块缓冲，不刷一下用户就看不到"该打开哪个网址"
    sys.stdout.flush()
    if args.open:
        target = (f"http://127.0.0.1:{port}/{suffix}" if _loopback(host)
                  else f"http://{(_local_addresses(preferred=_default_route_ip()) or ['127.0.0.1'])[0]}:{port}/{suffix}")
        threading.Timer(0.5, lambda: webbrowser.open(target)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[portal] 已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
