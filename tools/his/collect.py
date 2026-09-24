#!/usr/bin/env python3
"""采集：把"今天谁来了"变成一份可审计的原始数据（+ 规范化事实行）。

两条入口：

* ``--mode daily``  —— 名单 → 逐人扇出（就诊病历 / 检验 / 检查 / 体检 / 危急值）
* ``--mode person`` —— 姓名（+手机号）→ 档案 id → 该人的体检侧记录

设计要点（都是这套系统上实测出来的）：

1. **两套 id**：HIS 侧（就诊/检验/检查）用 ``hisUserId``，档案/体检侧（体检报告、单项历史、
   既往史…）用 ``hmsUserId``。桥是"就诊/病历列表"接口的返回行 —— 它同时带两个 id。
2. **成败看业务状态码，不看 HTTP 码**：会话失效时服务端回 ``HTTP 200`` +
   ``{"status":401,"message":"登录超时"}``。
3. **复放必须带 Cookie**：抓包 ``network.jsonl`` 里同一个请求有两行头，权威那行是
   ``requestExtra``；``--curlrc`` 读的就是从它导出的 curl 配置。
4. **静默失败是这里最大的风险**：接口改版后可能返回 ``status=0`` + 空列表，
   和"今天没人来"长得一样。所以名单为 0 直接以退出码 3 失败，并且每次都落
   ``pagination.total`` 供对账。

依赖：默认只用标准库（``urllib``）。要过 SOCKS5 代理时用 ``--via-curl``
（调用系统 curl，实测可用），或在服务器上装 ``httpx[socks]`` 后自行替换
``_http_urllib``。产物含明文凭据与患者数据：目录 0700、文件 0600。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Iterable

RULE_VERSION = "1"


# --------------------------------------------------------------------------- #
# 会话与传输
# --------------------------------------------------------------------------- #


class CollectError(RuntimeError):
    """配置/契约层面的失败（不是单个患者的偶发失败）。"""


@dataclass
class Session:
    """一次采集要用的东西：基地址、请求头、可选代理。"""

    base: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    proxy: str = ""

    def mask(self) -> str:
        return f"base={self.base} headers={len(self.headers)} 项 proxy={self.proxy or '(直连)'}"


def load_curlrc(path: str) -> Session:
    """读 curl 配置文件（``-K`` 那份）：``proxy = "socks5h://…"`` 与 ``header = "K: V"``。"""
    session = Session()
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip().lower()
            value = value.strip().strip('"')
            if key == "proxy":
                session.proxy = value
            elif key == "header":
                name, _, val = value.partition(":")
                session.headers[name.strip()] = val.strip()
    if not session.headers:
        raise CollectError(f"{path}: 没读到任何 header = 行")
    return session


def load_session_json(path: str) -> Session:
    with open(path, encoding="utf-8") as handle:
        doc = json.load(handle)
    return Session(
        base=str(doc.get("base") or ""),
        headers={str(k): str(v) for k, v in (doc.get("headers") or {}).items()},
        proxy=str(doc.get("proxy") or ""),
    )


def _build_url(session: Session, path: str, params: dict[str, Any] | None) -> str:
    if not session.base:
        raise CollectError("缺少基地址：用 --base 或 session.json 的 base 给出（本工具不内置任何站点）")
    query = dict(params or {})
    query.setdefault("timestamp", int(dt.datetime.now().timestamp() * 1000))
    return f"{session.base.rstrip('/')}{path}?{urllib.parse.urlencode(query)}"


def _http_urllib(session: Session, url: str) -> str:
    request = urllib.request.Request(url, headers=session.headers)
    handlers: list[Any] = []
    if session.proxy and session.proxy.startswith(("http://", "https://")):
        handlers.append(urllib.request.ProxyHandler({"http": session.proxy, "https": session.proxy}))
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(request, timeout=60) as response:
            return response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:  # 4xx/5xx 也会带 body，尽量读出来
        return error.read().decode("utf-8", "replace")
    except urllib.error.URLError as error:
        raise CollectError(f"传输失败 {url.split('?')[0]}: {error}") from error


def _curl_config(session: Session, path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("silent\nshow-error\n")
        if session.proxy:
            handle.write(f'proxy = "{session.proxy}"\n')
        for name, value in session.headers.items():
            handle.write(f'header = "{name}: {value.replace(chr(34), chr(92) + chr(34))}"\n')
    os.chmod(path, 0o600)


def _http_curl(session: Session, url: str, config_path: str) -> str:
    result = subprocess.run(
        ["curl", "-K", config_path, url], capture_output=True, text=True, timeout=120
    )
    if result.returncode != 0:
        raise CollectError(f"curl 失败({result.returncode}) {url.split('?')[0]}: {result.stderr.strip()[:200]}")
    return result.stdout


class Client:
    """带业务状态码校验的 GET；``via_curl`` 时走系统 curl（支持 socks5h）。"""

    def __init__(self, session: Session, via_curl: bool = False, strict: bool = True) -> None:
        self.session = session
        self.via_curl = via_curl
        self.strict = strict
        self.errors: list[str] = []
        self._config: str | None = None

    def __enter__(self) -> "Client":
        if self.via_curl:
            handle, path = tempfile.mkstemp(prefix="his-curl-", suffix=".rc")
            os.close(handle)
            _curl_config(self.session, path)
            self._config = path
        return self

    def __exit__(self, *_: object) -> None:
        if self._config:
            os.unlink(self._config)

    def get(self, path: str, **params: Any) -> dict[str, Any]:
        url = _build_url(self.session, path, params)
        raw = _http_curl(self.session, url, self._config) if self.via_curl else _http_urllib(self.session, url)
        try:
            doc = json.loads(raw)
        except json.JSONDecodeError as error:
            raise CollectError(f"{path}: 响应不是 JSON（{error}）: {raw[:120]!r}") from error
        status = str(doc.get("status", "0"))
        if status not in ("0", "success", ""):
            message = str(doc.get("message") or "")
            raise CollectError(f"{path}: 业务失败 status={status} message={message!r}")
        return doc

    def get_soft(self, path: str, **params: Any) -> dict[str, Any]:
        """单个患者的失败不该终止整趟采集：记下来，返回空。"""
        try:
            return self.get(path, **params)
        except CollectError as error:
            self.errors.append(str(error))
            if self.strict:
                raise
            return {}


class Endpoints:
    """端点表：把"哪些路径、什么参数"从代码里抽出来。

    这样插件/工具本身可以公开，而**具体的系统路径**留在仓库之外
    （``--endpoints`` 指过去的那份文件里）。``path`` 里的 ``{name}`` 用
    ``params`` 里同名参数替换。
    """

    REQUIRED = (
        "roster", "clinicRecords", "reports", "reportDetail", "checkups",
        "checkupSummary", "crisis", "itemHistory", "personByName", "personSearch",
    )

    def __init__(self, doc: dict[str, Any]) -> None:
        missing = [key for key in self.REQUIRED if key not in doc]
        if missing:
            raise CollectError(f"端点表缺少: {', '.join(missing)}")
        self.table = {key: doc[key] for key in self.REQUIRED}
        self.item_types = dict(self.table["reports"].get("itemTypes") or {"lab": "LAB", "exam": "EXAM"})

    @classmethod
    def load(cls, path: str) -> "Endpoints":
        try:
            with open(path, encoding="utf-8") as handle:
                doc = json.load(handle)
        except (OSError, json.JSONDecodeError) as error:
            raise CollectError(f"读不了端点表 {path}: {error}") from error
        return cls(doc)

    def render(self, key: str, **values: Any) -> tuple[str, dict[str, Any]]:
        spec = self.table[key]
        path = str(spec["path"])
        for name, value in values.items():
            path = path.replace("{" + name + "}", str(value))
        params = {name: values[name] for name in spec.get("params", []) if name in values}
        return path, params


def rows_of(doc: dict[str, Any]) -> list[dict[str, Any]]:
    data = doc.get("data")
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        for key in ("list", "records", "rows"):
            value = data.get(key)
            if isinstance(value, list):
                return [row for row in value if isinstance(row, dict)]
    return []


def total_of(doc: dict[str, Any]) -> int | None:
    data = doc.get("data")
    if isinstance(data, dict):
        pagination = data.get("pagination")
        if isinstance(pagination, dict) and isinstance(pagination.get("total"), (int, str)):
            try:
                return int(pagination["total"])
            except (TypeError, ValueError):
                return None
        if isinstance(data.get("total"), (int, str)):
            try:
                return int(data["total"])
            except (TypeError, ValueError):
                return None
    return None


def data_of(doc: dict[str, Any]) -> Any:
    """``data`` 既可能是 dict（带 list/pagination），也可能直接就是对象。"""
    return doc.get("data")


# --------------------------------------------------------------------------- #
# 产出
# --------------------------------------------------------------------------- #


class Sink:
    """两条 JSONL：``raw``（接口原文，可回放）与 ``facts``（rules.py 的输入）。

    断点续跑靠 facts 里已有的 ``(date, patient, kind, sourceId)`` 键。
    """

    def __init__(self, outdir: str, tag: str) -> None:
        os.makedirs(outdir, mode=0o700, exist_ok=True)
        self.raw_path = os.path.join(outdir, f"raw-{tag}.jsonl")
        self.facts_path = os.path.join(outdir, f"facts-{tag}.jsonl")
        for path in (self.raw_path, self.facts_path):
            if not os.path.exists(path):
                with open(path, "w", encoding="utf-8"):
                    pass
            os.chmod(path, 0o600)
        self.done: set[str] = set()
        if os.path.exists(self.facts_path):
            with open(self.facts_path, encoding="utf-8") as handle:
                for line in handle:
                    try:
                        fact = json.loads(line)
                    except json.JSONDecodeError:
                        continue  # 中断留下的半行
                    key = fact.get("key")
                    if isinstance(key, str):
                        self.done.add(key)

    def _append(self, path: str, record: dict[str, Any]) -> None:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def raw(self, endpoint: str, params: dict[str, Any], doc: dict[str, Any]) -> None:
        self._append(
            self.raw_path,
            {"endpoint": endpoint, "params": params, "collectedAt": dt.datetime.now().isoformat(timespec="seconds"), "body": doc},
        )

    def fact(self, fact: dict[str, Any]) -> None:
        self._append(self.facts_path, fact)


# --------------------------------------------------------------------------- #
# 各阶段
# --------------------------------------------------------------------------- #


def day_range(day: str | None) -> tuple[int, int, str]:
    """当天 00:00:00.000 与 23:59:59.999 的毫秒时间戳。"""
    if day:
        date = dt.date.fromisoformat(day)
    else:
        date = dt.date.today()
    start = dt.datetime.combine(date, dt.time.min)
    end = dt.datetime.combine(date, dt.time.max)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000), date.isoformat()


def fetch_roster(client: Client, endpoints: Endpoints, doctor: str, day: str | None, page_size: int = 50) -> list[dict[str, Any]]:
    start, end, _ = day_range(day)
    rows: list[dict[str, Any]] = []
    page = 1
    while True:
        path, params = endpoints.render("roster", doctorName=doctor, startDate=start, endDate=end,
                                        pageNum=page, pageSize=page_size)
        doc = client.get(path, **params)
        rows.extend(rows_of(doc))
        if page * page_size >= (total_of(doc) or 0) or not rows_of(doc):
            return rows
        page += 1


def bridge_ids(client: Client, endpoints: Endpoints, his_user_id: str) -> list[dict[str, Any]]:
    path, params = endpoints.render("clinicRecords", userId=his_user_id, pageNum=1, pageSize=50)
    return rows_of(client.get(path, **params))


def his_reports(client: Client, endpoints: Endpoints, his_user_id: str, kind: str, page_size: int = 50) -> list[dict[str, Any]]:
    item_type = endpoints.item_types.get(kind, kind)
    path, params = endpoints.render("reports", userId=his_user_id, itemType=item_type, pageNum=1, pageSize=page_size)
    return rows_of(client.get(path, **params))


def report_detail(client: Client, endpoints: Endpoints, report_id: str) -> dict[str, Any]:
    path, params = endpoints.render("reportDetail", id=report_id)
    return client.get(path, **params)


def checkup_reports(client: Client, endpoints: Endpoints, hms_user_id: str, page_size: int = 50) -> list[dict[str, Any]]:
    path, params = endpoints.render("checkups", userId=hms_user_id, pageNum=1, pageSize=page_size)
    return rows_of(client.get(path, **params))


def checkup_summary(client: Client, endpoints: Endpoints, report_id: str) -> dict[str, Any]:
    path, params = endpoints.render("checkupSummary", id=report_id)
    return client.get(path, **params)


def crisis_list(client: Client, endpoints: Endpoints, medical_no: str, page_size: int = 200) -> list[dict[str, Any]]:
    path, params = endpoints.render("crisis", medicalNo=medical_no, pageNum=1, pageSize=page_size)
    return rows_of(client.get(path, **params))


def item_history(client: Client, endpoints: Endpoints, hms_user_id: str, item_name: str) -> dict[str, Any]:
    path, params = endpoints.render("itemHistory", itemName=item_name, userId=hms_user_id)
    return client.get(path, **params)


def person_by_name(client: Client, endpoints: Endpoints, name: str, telephone: str = "") -> dict[str, Any] | None:
    """姓名（+手机号）→ 档案对象。

    给了手机号就走精确接口；只给姓名则退回模糊搜索，由调用方处理"同名多条"。
    """
    if telephone:
        path, params = endpoints.render("personByName", name=name, telephone=telephone)
        data = data_of(client.get(path, **params))
        return data if isinstance(data, dict) else None
    path, params = endpoints.render("personSearch", nameOrPhone=name, pageNum=1, pageSize=10)
    rows = rows_of(client.get(path, **params))
    return rows[0] if len(rows) == 1 else None


# --------------------------------------------------------------------------- #
# 把接口原文折成事实行
# --------------------------------------------------------------------------- #


def _now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def lab_items(detail: dict[str, Any]) -> list[dict[str, Any]]:
    data = data_of(detail) or {}
    items = data.get("detailList") if isinstance(data, dict) else None
    out: list[dict[str, Any]] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "itemCode": item.get("itemCode"),
                "itemName": item.get("itemName"),
                "result": item.get("result"),
                "unit": item.get("itemUnit"),
                "reference": item.get("reference"),
                "flagText": item.get("abnormalTips"),
                "arrow": item.get("resultRemark"),
                # haveCrisis 在本系统里近乎常态（实测 1664 项里 1609 项为 "1"），
                # 只能作为"请人看一眼"的线索；真正的危急值只认危急值模块。
                "crisis": False,
                "crisisHint": str(item.get("haveCrisis") or "").strip() not in ("", "0", "false", "None"),
                "crisisValue": item.get("crisisValue"),
                "checkTime": item.get("crtTime"),
            }
        )
    return out


def exam_conclusion(detail: dict[str, Any]) -> dict[str, Any]:
    """检查报告是描述型的：数值不存在，结论在报告级字段里。"""
    data = data_of(detail) or {}
    if not isinstance(data, dict):
        return {}
    return {
        "checkResult": data.get("checkResult"),
        "reportResult": data.get("reportResult"),
        "checkDoctorName": data.get("checkDoctorName"),
        "checkTime": data.get("checkTime"),
        "groupItemName": data.get("groupItemName"),
    }


def diagnosis_items(summary: dict[str, Any]) -> list[dict[str, Any]]:
    """体检小结里的**结论条目**：疾病 + 分级，没有数值。

    先前这里读的是 ``diagnoseItems[].items`` —— 那是疾病分组，不是检验明细，
    于是每条都成了"无结果"。真正的数值项走 ⑦ 单项历史那条线。
    """
    data = data_of(summary) or {}
    if not isinstance(data, dict):
        return []
    out: list[dict[str, Any]] = []
    for row in list(data.get("medicalDataRelDiseases") or []) + list(data.get("suggests") or []):
        if not isinstance(row, dict):
            continue
        disease = row.get("disease") or row.get("diseaseNickName")
        if not disease:
            continue
        out.append(
            {
                "itemCode": row.get("diseaseId"),
                "itemName": disease,
                "result": None,
                "unit": None,
                "reference": None,
                "flagText": row.get("crisisLevelName"),
                "level": row.get("crisisLevel"),
                "disease": disease,
                "checkTime": row.get("crtTime"),
            }
        )
    return out


def crisis_items(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """危急值列表 → 事实行：每一行本身就是一条已被系统标为危机的明细。"""
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        out.append(
            {
                "itemCode": row.get("signId") or row.get("itemCode"),
                "itemName": row.get("signType") or row.get("itemName"),
                "result": row.get("signMsg") or row.get("result"),
                "unit": row.get("unit"),
                "reference": row.get("reference"),
                "flagText": row.get("signStatusName") or row.get("crisisLevelName"),
                "crisis": True,
                "crisisValue": row.get("crisisLevelName") or row.get("crisisLevel"),
                "checkTime": row.get("checkTime") or row.get("crtTime"),
            }
        )
    return out


def fact_key(day: str, patient: dict[str, Any], kind: str, source_id: str) -> str:
    """一条事实的幂等键。

    续跑检查与落盘**必须走同一个函数**：先前检查处用 ``hmsUserId``、落盘处优先 ``hisUserId``，
    两边不一致，导致体检与危急值每轮都被重采。
    """
    who = patient.get("hisUserId") or patient.get("hmsUserId") or patient.get("name")
    return "|".join([day, str(who), kind, source_id])


def fact_row(
    *, day: str, patient: dict[str, Any], kind: str, source_id: str, endpoint: str, items: list[dict[str, Any]], extra: dict[str, Any] | None = None
) -> dict[str, Any]:
    return {
        "key": fact_key(day, patient, kind, source_id),
        "date": day,
        "kind": kind,
        "patient": patient,
        "source": {"endpoint": endpoint, "sourceId": source_id, "collectedAt": _now()},
        "items": items,
        "extra": extra or {},
    }


# --------------------------------------------------------------------------- #
# 两个模式
# --------------------------------------------------------------------------- #


def run_daily(client: Client, endpoints: Endpoints, sink: Sink, doctor: str, day: str | None, with_trends: bool, trends_per_patient: int) -> dict[str, Any]:
    start, end, date = day_range(day)
    roster = fetch_roster(client, endpoints, doctor, day)
    summary: dict[str, Any] = {"date": date, "rosterTotal": len(roster), "patients": 0, "facts": 0, "errors": list(client.errors)}
    if not roster:
        return summary
    for row in roster:
        his_user_id = row.get("userId")
        if not his_user_id:
            continue
        patient = {
            "hisUserId": his_user_id,
            "name": row.get("name"),
            "sex": row.get("gender"),
            "age": row.get("age"),
            "telephone": row.get("telephone"),
            "deptName": row.get("deptName"),
            "clinicTime": row.get("clinicTime"),
            "diagnose": row.get("firstDiagnose"),
        }
        summary["patients"] += 1
        # ② 桥：拿到 hmsUserId（体检/档案侧）
        records = bridge_ids(client, endpoints, his_user_id)
        hms_user_id = next((r.get("hmsUserId") for r in records if r.get("hmsUserId")), None)
        patient["hmsUserId"] = hms_user_id
        for record in records:
            key = fact_key(date, patient, "visit", str(record.get("id")))
            if key not in sink.done:
                sink.fact(fact_row(day=date, patient=patient, kind="visit", source_id=str(record.get("id")),
                                   endpoint=endpoints.table["clinicRecords"]["path"], items=[],
                                   extra={"diagnosisList": record.get("diagnosisList"), "mainSuit": record.get("mainSuit"),
                                          "recordsNo": record.get("recordsNo"), "registerId": record.get("registerId")}))
                summary["facts"] += 1
        # ④ HIS 侧：检验 / 检查报告 + 明细（顺便记住出现过的项目名，供 ⑦ 趋势用）
        seen_item_names: list[str] = []
        for item_type, kind in (("JY", "lab"), ("JC", "exam")):
            for report in his_reports(client, endpoints, his_user_id, kind):
                report_id = str(report.get("id"))
                key = fact_key(date, patient, kind, report_id)
                if key in sink.done:
                    continue
                detail_path, detail_params = endpoints.render("reportDetail", id=report_id)
                detail = client.get_soft(detail_path, **detail_params)
                if not detail:
                    continue  # 拉不到就不落事实：否则空事实进 done 集合，续跑永远补不回来
                sink.raw(detail_path, detail_params, detail)
                items = lab_items(detail) if kind == "lab" else []
                extra = {"groupItemName": report.get("groupItemName")}
                if kind == "exam":
                    extra.update(exam_conclusion(detail))
                sink.fact(fact_row(day=date, patient=patient, kind=kind, source_id=report_id,
                                   endpoint=detail_path, items=items, extra=extra))
                summary["facts"] += 1
                for item in items:
                    name = item.get("itemName")
                    if name and name not in seen_item_names:
                        seen_item_names.append(name)
        # ⑤ 体检侧：报告列表 + 小结 +（可选）单项历史
        if hms_user_id:
            for report in checkup_reports(client, endpoints, hms_user_id):
                # 小结接口要的是体检数据 id，**不是**报告行本身的 id（实测：用错会回
                # "体检数据不存在"）；行里给的是 medicalDataId。
                report_id = str(report.get("medicalDataId") or report.get("id"))
                medical_no = report.get("medicalNo")
                key = fact_key(date, patient, "checkup", report_id)
                if key not in sink.done:
                    summary_path, summary_params = endpoints.render("checkupSummary", id=report_id)
                    summary_doc = client.get_soft(summary_path, **summary_params)
                    if not summary_doc:
                        continue
                    sink.raw(summary_path, summary_params, summary_doc)
                    sink.fact(fact_row(day=date, patient=patient, kind="checkup", source_id=report_id,
                                       endpoint=summary_path,
                                       items=diagnosis_items(summary_doc), extra={"medicalNo": medical_no}))
                    summary["facts"] += 1
                if medical_no:
                    key = fact_key(date, patient, "crisis", str(medical_no))
                    if key not in sink.done:
                        crisis = crisis_list(client, endpoints, str(medical_no))
                        sink.fact(fact_row(day=date, patient=patient, kind="crisis", source_id=str(medical_no),
                                           endpoint=endpoints.table["crisis"]["path"], items=crisis_items(crisis)))
                        summary["facts"] += 1
            if with_trends:
                for item_name in seen_item_names[:trends_per_patient]:
                    key = fact_key(date, patient, "trend", item_name)
                    if key in sink.done:
                        continue
                    trend_path, trend_params = endpoints.render("itemHistory", itemName=item_name, userId=hms_user_id)
                    history = client.get_soft(trend_path, **trend_params)
                    series = data_of(history)
                    items: list[dict[str, Any]] = []
                    if isinstance(series, dict):
                        for group, points in series.items():
                            for point in points or []:
                                if isinstance(point, dict):
                                    items.append({"itemCode": point.get("itemCode"), "itemName": point.get("itemName") or group,
                                                  "result": point.get("result"), "unit": None,
                                                  "reference": point.get("referenceRange"), "flagText": point.get("tipsContent"),
                                                  "crisis": False, "crisisValue": None, "checkTime": point.get("checkTime"),
                                                  "isYang": point.get("isYang")})
                    sink.fact(fact_row(day=date, patient=patient, kind="trend", source_id=item_name,
                                       endpoint=trend_path, items=items,
                                       extra={"groupItemName": item_name}))
                    summary["facts"] += 1
    summary["errors"] = list(client.errors)
    return summary


def run_person(client: Client, endpoints: Endpoints, sink: Sink, name: str, telephone: str, with_trends: bool) -> dict[str, Any]:
    date = dt.date.today().isoformat()
    summary: dict[str, Any] = {"date": date, "person": name, "facts": 0, "candidates": []}
    search_path, search_params = endpoints.render("personSearch", nameOrPhone=name, pageNum=1, pageSize=10)
    doc = client.get(search_path, **search_params) if not telephone else {}
    summary["candidates"] = [r.get("id") for r in rows_of(doc)] if doc else []
    person = person_by_name(client, endpoints, name, telephone)
    if not person:
        raise CollectError(f"按姓名定位失败：{'同名多人，请带 --telephone' if summary['candidates'] else '没有匹配的档案'}")
    hms_user_id = str(person.get("id"))
    patient = {"hmsUserId": hms_user_id, "name": person.get("name"), "sex": person.get("gender"),
               "age": person.get("age"), "telephone": person.get("telephone"), "identityCard": person.get("identityCard")}
    for report in checkup_reports(client, endpoints, hms_user_id):
        report_id = str(report.get("medicalDataId") or report.get("id"))
        medical_no = report.get("medicalNo")
        key = fact_key(date, patient, "checkup", report_id)
        if key in sink.done:
            continue
        summary_path, summary_params = endpoints.render("checkupSummary", id=report_id)
        summary_doc = client.get_soft(summary_path, **summary_params)
        if not summary_doc:
            continue
        sink.fact(fact_row(day=date, patient=patient, kind="checkup", source_id=report_id,
                           endpoint=summary_path,
                           items=diagnosis_items(summary_doc), extra={"medicalNo": medical_no}))
        summary["facts"] += 1
        if medical_no:
            crisis = crisis_list(client, endpoints, str(medical_no))
            sink.fact(fact_row(day=date, patient=patient, kind="crisis", source_id=str(medical_no),
                               endpoint=endpoints.table["crisis"]["path"], items=crisis_items(crisis)))
            summary["facts"] += 1
    if with_trends:
        for item_name in ("总胆固醇", "甘油三酯", "尿酸"):
            trend_path, trend_params = endpoints.render("itemHistory", itemName=item_name, userId=hms_user_id)
            history = client.get_soft(trend_path, **trend_params)
            series = data_of(history)
            items: list[dict[str, Any]] = []
            if isinstance(series, dict):
                for group, points in series.items():
                    for point in points or []:
                        if isinstance(point, dict):
                            items.append({"itemCode": point.get("itemCode"), "itemName": point.get("itemName") or group,
                                          "result": point.get("result"), "reference": point.get("referenceRange"),
                                          "flagText": point.get("tipsContent"), "isYang": point.get("isYang"),
                                          "checkTime": point.get("checkTime")})
            if items:
                sink.fact(fact_row(day=date, patient=patient, kind="trend", source_id=item_name,
                                   endpoint=trend_path, items=items))
                summary["facts"] += 1
    return summary


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="病例系统采集（离线，可断点续跑）")
    parser.add_argument("--mode", choices=("daily", "person"), default="daily")
    parser.add_argument("--endpoints", required=True, help="端点表 JSON（见 tools/his/endpoints.example.json）")
    parser.add_argument("--out", default="his-out", help="输出目录（0700）")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--curlrc", help="curl 配置（含 Cookie 与 proxy），通常从抓包导出")
    source.add_argument("--session", help="JSON：{base, headers, proxy}")
    parser.add_argument("--base", help="基地址，如 https://his.example.org（curlrc 里没有基地址时必须给）")
    parser.add_argument("--via-curl", action="store_true", help="走系统 curl（支持 socks5h 代理）")
    parser.add_argument("--strict", action="store_true", help="任一患者失败即中止（默认只记录）")
    parser.add_argument("--date", help="YYYY-MM-DD，默认今天")
    parser.add_argument("--doctor", help="医生姓名（名单接口的 doctorName）")
    parser.add_argument("--name", help="mode=person：姓名")
    parser.add_argument("--telephone", default="", help="mode=person：手机号（消除同名歧义）")
    parser.add_argument("--with-trends", action="store_true", help="额外拉单项历史（异常值/趋势）")
    parser.add_argument("--trends-per-patient", type=int, default=8)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        session = load_curlrc(args.curlrc) if args.curlrc else load_session_json(args.session)
        if args.base:
            session.base = args.base.rstrip("/")
        endpoints = Endpoints.load(args.endpoints)
    except (CollectError, OSError) as error:
        print(f"[his] 配置错误: {error}", file=sys.stderr)
        return 2
    tag = args.date or dt.date.today().isoformat()
    sink = Sink(args.out, tag)
    print(f"[his] {session.mask()}  mode={args.mode}  续跑已完成 {len(sink.done)} 条")
    with Client(session, via_curl=args.via_curl, strict=args.strict) as client:
        try:
            if args.mode == "daily":
                if not args.doctor:
                    print("[his] mode=daily 需要 --doctor", file=sys.stderr)
                    return 2
                summary = run_daily(client, endpoints, sink, args.doctor, args.date, args.with_trends, args.trends_per_patient)
            else:
                if not args.name:
                    print("[his] mode=person 需要 --name", file=sys.stderr)
                    return 2
                summary = run_person(client, endpoints, sink, args.name, args.telephone, args.with_trends)
        except CollectError as error:
            print(f"[his] 采集失败: {error}", file=sys.stderr)
            return 1
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"[his] 原文 {sink.raw_path}\n[his] 事实 {sink.facts_path}")
    if args.mode == "daily" and summary.get("rosterTotal") == 0:
        print("[his] 名单为 0：接口改版或今天确实没人——请人工核对后再当成正常", file=sys.stderr)
        return 3
    return 1 if summary.get("errors") else 0


if __name__ == "__main__":
    sys.exit(main())
