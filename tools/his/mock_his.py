#!/usr/bin/env python3
"""假的病例系统：够真到能验证采集与规则，且完全离线、无患者数据。

它按实测到的**响应形状**作答（字段名与真实系统一致），所以 `collect.py` 不需要
知道"这是 mock"；协议上的两个关键行为也照实模拟：

* 缺 `Cookie` 头时，返回 **HTTP 200 + `{"status":401,"message":"登录超时"}`**
  —— 这就是"只看 HTTP 码必然误判"的那个坑；
* `doctorName=NOBODY` 时名单返回空列表 —— 用来验证"0 条必须告警"。

手工起服务::

    python3 tools/his/mock_his.py --port 8099
    curl 'http://127.0.0.1:8099/api/example/auth/me' -H 'Cookie: x=1'

测试里用 `make_server()`（随机端口，进程内启动）。"""

from __future__ import annotations

import argparse
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

HIS_A, HMS_A, MED_A = "his-a-0001", "hms-a-0001", "M0000001"
HIS_B, HMS_B = "his-b-0002", "hms-b-0002"

ROSTER_A = {
    "userId": HIS_A, "name": "测试甲", "gender": "1", "age": 41, "telephone": "13800000001",
    "deptName": "全科门诊", "clinicTime": 1790179200000, "firstDiagnose": "高尿酸血症",
    "receiptState": "2", "id": "reg-a", "recordsId": "rec-a",
}
ROSTER_B = {
    "userId": HIS_B, "name": "测试乙", "gender": "2", "age": 33, "telephone": "13800000002",
    "deptName": "检后管理门诊", "clinicTime": 1790179500000, "firstDiagnose": "高脂血症",
    "receiptState": "1", "id": "reg-b", "recordsId": None,
}

LAB_REPORT = {
    "id": "rep-lab-1", "itemType": "LAB", "groupItemName": "血脂四项", "userId": HIS_A,
    "checkTime": "2026-09-24 09:10:00", "executeStatus": "1",
}
EXAM_REPORT = {
    "id": "rep-exam-1", "itemType": "EXAM", "groupItemName": "腹部超声", "userId": HIS_A,
    "checkTime": "2026-09-24 09:20:00", "executeStatus": "1",
}
LAB_DETAIL = {
    "id": "rep-lab-1", "userId": HIS_A, "groupItemName": "血脂四项", "reportResult": "血脂异常",
    "isPositive": "0",
    "detailList": [
        {"itemCode": "CHO", "itemName": "总胆固醇", "result": "9.80", "itemUnit": "mmol/L",
         "reference": "3.50-9.50", "abnormalTips": "", "resultRemark": None, "haveCrisis": "0",
         "crisisValue": None, "crtTime": "2026-09-24 09:10:00"},
        {"itemCode": "ALT", "itemName": "谷丙转氨酶", "result": "31", "itemUnit": "U/L",
         "reference": "9-50", "abnormalTips": "M", "resultRemark": None, "haveCrisis": "0",
         "crisisValue": None, "crtTime": "2026-09-24 09:10:00"},
        {"itemCode": "TG", "itemName": "甘油三酯", "result": "2.10", "itemUnit": "mmol/L",
         "reference": "0.40-1.70", "abnormalTips": "H", "resultRemark": "↑", "haveCrisis": "0",
         "crisisValue": None, "crtTime": "2026-09-24 09:10:00"},
        {"itemCode": "K", "itemName": "血钾", "result": "7.10", "itemUnit": "mmol/L",
         "reference": "3.50-5.30", "abnormalTips": "", "resultRemark": None, "haveCrisis": "1",
         "crisisValue": "7.10", "crtTime": "2026-09-24 09:10:00"},
        {"itemCode": "GLU", "itemName": "空腹血糖", "result": "5.20", "itemUnit": "mmol/L",
         "reference": "3.90-6.10", "abnormalTips": "", "resultRemark": None, "haveCrisis": "0",
         "crisisValue": None, "crtTime": "2026-09-24 09:10:00"},
        {"itemCode": "HBS", "itemName": "乙肝表面抗原", "result": "阴性", "itemUnit": None,
         "reference": "阴性", "abnormalTips": "", "resultRemark": None, "haveCrisis": "0",
         "crisisValue": None, "crtTime": "2026-09-24 09:10:00"},
        {"itemCode": "VITD", "itemName": "25-羟基维生素D", "result": "24.5", "itemUnit": "ng/mL",
         "reference": "缺乏:0--19.9|不充足:20--29.9|充足:30--100|过量:>100",
         "abnormalTips": "L", "resultRemark": "↓", "haveCrisis": "1", "crisisValue": "24.5",
         "crtTime": "2026-09-24 09:10:00"},
    ],
}
CHECKUP_LIST = [{"id": "med-1", "medicalDataId": "med-data-1", "medicalNo": MED_A, "userId": HMS_A, "medicalDate": 1789000000000,
                 "registerUserName": "测试甲", "age": 41}]
CHECKUP_SUMMARY = {
    "id": "med-1", "checkNum": 1, "grade": "B",
    # 小结里给的是**结论条目**（疾病 + 分级），不是检验明细；数值项走单项历史那条线
    "diagnoseItems": [{"groupItem": "生化", "items": [{"itemCode": "UA", "itemName": "尿酸"}]}],
    "medicalDataRelDiseases": [
        {"disease": "高尿酸血症", "diseaseId": "d-1", "crisisLevel": "2", "crisisLevelName": "中度"},
        {"disease": "脂肪肝", "diseaseId": "d-2", "crisisLevel": "0", "crisisLevelName": ""},
    ],
    "suggests": [{"disease": "建议低嘌呤饮食", "crisisLevel": "0", "crisisLevelName": ""}],
}
CRISIS_ROWS = [{"id": "cri-1", "medicalNo": MED_A, "userId": HMS_A, "crisisLevel": "3",
                "crisisName": "血钾危急值", "crisisType": "1", "itemName": "血钾",
                "result": "7.10", "medicalValue": "7.10 mmol/L", "handleStatus": "未处理",
                "checkDate": "2026-06-01 08:30:00"}]
TREND = {
    "血脂四项": [
        {"itemCode": "CHO", "itemName": "总胆固醇", "result": "9.80", "referenceRange": "3.50-9.50",
         "isYang": "1", "tipsContent": "偏高", "checkTime": "2026-09-24 09:10:00"},
        {"itemCode": "CHO", "itemName": "总胆固醇", "result": "5.10", "referenceRange": "3.50-9.50",
         "isYang": "0", "tipsContent": "", "checkTime": "2026-03-01 09:00:00"},
    ]
}
VISIT_DETAIL = {
    "id": "visit-a1", "registerId": "reg-a", "userId": HIS_A, "name": "测试甲",
    "diagnosisList": [{"diagnosisName": "高尿酸血症", "diagnosisCode": "E79.0", "diagnosisType": "1"}],
    "itemList": [
        {"itemCode": "XY001", "name": "非布司他片", "medicineName": "非布司他片",
         "specifications": "40mg*16T", "usage": "01", "dosage": "40", "adultDose": "40",
         "adultUnit": "24", "executeFrequencyName": "qd", "count": 1, "totalCount": 7,
         "dayCount": 7, "itemType": "2", "executeStatus": "DONE", "totalPrice": "38.50",
         "changeTime": "2026-09-24 09:20:00"},
        {"itemCode": "JY001", "name": "血脂四项", "itemType": "5",
         "executeFrequencyName": "", "executeStatus": "TO_EXECUTE", "totalPrice": "60.00"},
    ],
}
IDENTITY_ROWS = [
    {"id": HIS_A, "hmsArchivesUserId": HMS_A, "name": "测试甲", "telephone": "13800000001",
     "identityCard": "440000199001010000", "gender": "1", "age": 41},
    {"id": "his-a-9998", "hmsArchivesUserId": "hms-a-9998", "name": "测试甲",
     "telephone": "13900000009", "identityCard": "440000199001010009", "gender": "2", "age": 41},
    {"id": HIS_B, "hmsArchivesUserId": HMS_B, "name": "测试乙", "telephone": "13800000002",
     "identityCard": "440000199303030002", "gender": "2", "age": 33},
]
DICT_ENTRIES = {
    "MD_ITEM_USAGE": [{"itemValue": "01", "name": "口服"}, {"itemValue": "02", "name": "外用"}],
    "MD_ITEM_DOSE_UNIT": [{"itemValue": "24", "name": "mg"}, {"itemValue": "01", "name": "小包"}],
    "HMS_TANANT_OPERATION_ITEM_TYPE": [{"itemValue": "1", "name": "中药"}, {"itemValue": "2", "name": "西药"}],
    "HIS_DOCTOR_WORK_BENCH_REPORT_EXECUTE_TYPE": [{"itemValue": "DONE", "name": "已执行"},
                                                  {"itemValue": "TO_EXECUTE", "name": "待执行"}],
    "HMS_MEDICAL_TYPE": [{"itemValue": "1", "name": "福利体检"}],
    "HMS_MEDICAL_GROUP": [{"itemValue": "1", "name": "单位体检"}],
    "HMS_COMM_SEX": [{"itemValue": "M", "name": "男"}, {"itemValue": "F", "name": "女"}],
}
ARCHIVE_PERSON = {"id": HMS_A, "name": "测试甲", "gender": "1", "age": 41, "telephone": "13800000001",
                  "identityCard": "440000199001010000", "bmi": "24.1", "bloodType": "A"}
ARCHIVE_PAGE = [ARCHIVE_PERSON, {"id": "hms-a-9999", "name": "测试甲", "telephone": "13900000009",
                                 "age": 41, "gender": "1", "companyName": "示例公司"}]


# ---- 多报告患者：分页测试专用（报告数故意多于每页条数） ----
HIS_C, HMS_C = "his-c-0003", "hms-c-0003"

ROSTER_C = {
    "userId": HIS_C, "name": "测试丙", "gender": "1", "age": 52, "telephone": "13800000003",
    "deptName": "检后管理门诊", "clinicTime": 1790179800000, "firstDiagnose": "血脂异常",
    "receiptState": "2", "id": "reg-c", "recordsId": "rec-c",
}
#: 5 份检验报告 —— 端点表把 pageSize 设成 2 时，必须翻 3 页才取得全
LAB_REPORTS_C = [
    {"id": f"rep-c-{index}", "itemType": "LAB", "groupItemName": f"组套{index}", "userId": HIS_C,
     "checkTime": f"2026-0{index}-10 09:00:00", "executeStatus": "1"}
    for index in range(1, 6)
]
#: 3 次体检
CHECKUP_LIST_C = [
    {"id": f"med-c-{index}", "medicalDataId": f"med-data-c-{index}", "medicalNo": f"MC{index}",
     "userId": HMS_C, "medicalDate": 1789000000000 + index, "registerUserName": "测试丙", "age": 52}
    for index in range(1, 4)
]
IDENTITY_ROW_C = {"id": HIS_C, "hmsArchivesUserId": HMS_C, "name": "测试丙",
                  "telephone": "13800000003", "identityCard": "440000199505050003",
                  "gender": "1", "age": 52}


def lab_detail_c(report_id: str) -> dict[str, Any]:
    """每份报告的明细项数不同，翻页漏掉哪一份一眼能看出来。"""
    index = int(report_id.rsplit("-", 1)[-1])
    return {
        "id": report_id, "userId": HIS_C, "groupItemName": f"组套{index}",
        "detailList": [
            {"itemCode": f"C{index}-{item}", "itemName": f"分页项目{index}-{item}",
             "result": str(index * 10 + item), "itemUnit": "mmol/L", "reference": "0--5",
             "abnormalTips": "", "resultRemark": None, "haveCrisis": "0", "crisisValue": None,
             "crtTime": f"2026-0{index}-10 09:00:00"}
            for item in range(1, index + 2)          # 第 1 份 2 项、第 5 份 6 项
        ],
    }


def checkup_summary_c(data_id: str) -> dict[str, Any]:
    index = int(data_id.rsplit("-", 1)[-1])
    return {
        "id": data_id, "checkNum": index, "grade": "A",
        "medicalDataRelDiseases": [
            {"disease": f"结论{index}-{item}", "diseaseId": f"dc-{index}-{item}",
             "crisisLevel": "0", "crisisLevelName": ""}
            for item in range(1, index + 2)
        ],
        "suggests": [],
    }


def _ok(data: Any) -> dict[str, Any]:
    return {"httpStatus": 200, "status": "0", "message": "success", "result": {}, "data": data}


#: 测试用：置 True 时服务端**忽略 pageNum**、永远回第一页 —— 复现"页码没生效"的服务端
IGNORE_PAGINATION = False
#: 测试用：每页最多回这么多行（不管请求的 pageSize），并且**与上一页重叠一行**。
#: 这是真机上 `clinic_record/page` 的真实形状：19/15/30/15 行一页，`pages=4` 但 total=175。
SHORT_PAGES = 0
#: 测试用：服务端声称的 total 比实际能给出的行数多这么多 —— 真机上 `clinic_record/page`
#: 就是 `total=175` 而四页加起来只有 79 行。用来验证"对不上账要报警"。
INFLATED_TOTAL = 0


def _paged(rows: list[dict[str, Any]], query: dict[str, list[str]] | None = None) -> dict[str, Any]:
    """真的按 pageNum/pageSize 切片。

    假系统必须会翻页，否则"采集有没有翻到底"这件事在测试里根本证明不了 ——
    而真机上正是这里出的问题（检验报告共 71 份、一页只回 50 份）。

    ``IGNORE_PAGINATION`` 复现另一种真实故障：**服务端忽略 pageNum**，第二页和第一页
    一模一样。这时候客户端必须停下来并且报"取不全"，不能把同一页抄很多遍。
    """
    total = len(rows)

    def _int(key: str, fallback: int) -> int:
        try:
            return max(1, int((query.get(key) or [str(fallback)])[0]))
        except (TypeError, ValueError):
            return fallback

    if not query:
        return {"list": rows,
                "pagination": {"pageSize": total or 1, "pageNum": 1, "pages": 1, "total": total}}

    page_num = _int("pageNum", 1)
    size = _int("pageSize", 50)
    claimed = total + INFLATED_TOTAL
    pages = max(1, (claimed + size - 1) // size)
    if IGNORE_PAGINATION:
        return {"list": rows[:size],
                "pagination": {"pageSize": size, "pageNum": page_num, "pages": pages, "total": claimed}}
    start = (page_num - 1) * size
    if SHORT_PAGES:
        # 偏移按请求的 pageSize 算，但只回 SHORT_PAGES 行，并叠上一页的最后一行
        chunk = rows[start:start + SHORT_PAGES]
        if page_num > 1 and start > 0 and chunk:
            chunk = [rows[start - 1]] + chunk
        return {"list": chunk,
                "pagination": {"pageSize": size, "pageNum": page_num, "pages": pages, "total": claimed}}
    return {"list": rows[start:start + size],
            "pagination": {"pageSize": size, "pageNum": page_num, "pages": pages, "total": claimed}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_: Any) -> None:  # 测试里不要噪声
        pass

    def _send(self, payload: dict[str, Any], code: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802  (stdlib 命名)
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        # 一个最小的"工作台页面"：扩展要注入到真实的页面里，所以假系统也得有页面。
        # 它故意不带 CSP —— 真实系统实测也没有（否则注入的内联引导会被浏览器拦掉）。
        if path in ("/", "/demo", "/demo/"):
            page = ("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
                    "<title>假工作台</title></head><body><h1>假工作台</h1>"
                    "<p>用来验证扩展的注入与同源直查。</p></body></html>").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)
            return
        # 会话校验：缺 Cookie 就回 HTTP 200 + 业务 401（真实系统的行为）
        if "cookie" not in {k.lower() for k in self.headers}:
            self._send({"httpStatus": 200, "status": "401", "message": "登录超时", "data": None})
            return
        one = lambda key: (query.get(key) or [""])[0]  # noqa: E731
        if path == "/api/example/roster":
            if one("doctorName") == "NOBODY":
                rows = []
            elif one("doctorName") == "PAGED":
                rows = [ROSTER_C]          # 多报告患者：分页测试专用
            else:
                rows = [ROSTER_A, ROSTER_B]
            self._send(_ok(_paged(rows, query)))
        elif path == "/api/example/identity":
            wanted = one("name")
            rows = [r for r in IDENTITY_ROWS if r["name"] == wanted]
            if wanted == IDENTITY_ROW_C["name"]:
                rows = [IDENTITY_ROW_C]
            self._send(_ok(_paged(rows, query)))
        elif path == "/api/example/dictionaries":
            wanted = [c for c in one("dictionaryTypeCode").split(",") if c]
            self._send(_ok({c: DICT_ENTRIES.get(c, []) for c in wanted}))
        elif re.match(r"^/api/example/visit/[^/]+$", path):
            self._send(_ok(VISIT_DETAIL))
        elif path == "/api/example/visits":
            user = one("userId")
            rows = []
            if user == HIS_C:
                rows = [
                    {"id": "visit-c1", "hisUserId": HIS_C, "hmsUserId": HMS_C, "name": "测试丙",
                     "recordsNo": "R0003", "registerId": "reg-c", "clinicTime": 1790179800000,
                     "diagnosisList": [{"diseaseName": "血脂异常"}], "mainSuit": ""},
                    # 真机上有 11/76 条就诊记录没有 registerId，详情接口会拒 —— 假系统照实模拟
                    {"id": "visit-c2", "hisUserId": HIS_C, "hmsUserId": HMS_C, "name": "测试丙",
                     "recordsNo": "R0004", "registerId": None, "clinicTime": 1790179900000,
                     "diagnosisList": [{"diseaseName": "高尿酸血症"}], "mainSuit": ""},
                ]
            elif user == HIS_A:
                rows = [{"id": "visit-a1", "hisUserId": HIS_A, "hmsUserId": HMS_A, "name": "测试甲",
                         "recordsNo": "R0001", "registerId": "reg-a", "clinicTime": 1790179200000,
                         "diagnosisList": [{"diseaseName": "高尿酸血症"}], "mainSuit": "体检复查"}]
            elif user == HIS_B:
                rows = [{"id": "visit-b1", "hisUserId": HIS_B, "hmsUserId": HMS_B, "name": "测试乙",
                         "recordsNo": "R0002", "registerId": "reg-b", "clinicTime": 1790179500000,
                         "diagnosisList": [{"diseaseName": "高脂血症"}], "mainSuit": ""}]
            self._send(_ok(_paged(rows, query)))
        elif path == "/api/example/reports":
            item_type = one("itemType")
            rows = []
            if one("userId") == HIS_C:
                if "LAB" in item_type:
                    rows = list(LAB_REPORTS_C)
            elif one("userId") == HIS_A:
                for wanted, row in (("LAB", LAB_REPORT), ("EXAM", EXAM_REPORT)):
                    if wanted in item_type:
                        rows.append(row)
            self._send(_ok(_paged(rows, query)))
        elif re.match(r"^/api/example/report/[^/]+$", path):
            report_id = path.rsplit("/", 1)[-1]
            if report_id.startswith("rep-c-"):
                self._send(_ok(lab_detail_c(report_id)))
            else:
                self._send(_ok(LAB_DETAIL if "lab" in path else {"id": report_id, "detailList": []}))
        elif path == "/api/example/checkups":
            if one("userId") == HMS_A:
                rows = CHECKUP_LIST
            elif one("userId") == HMS_C:
                rows = CHECKUP_LIST_C
            else:
                rows = []
            self._send(_ok(_paged(rows, query)))
        elif re.match(r"^/api/example/checkup/[^/]+$", path):
            # 小结只认体检数据 id；用报告行 id 会被拒绝 —— 真实系统就是这个行为
            data_id = path.rsplit("/", 1)[-1]
            if data_id.startswith("med-data-c-"):
                self._send(_ok(checkup_summary_c(data_id)))
            else:
                self._send(_ok(CHECKUP_SUMMARY if data_id == "med-data-1" else None))
        elif path == "/api/example/crisis":
            self._send(_ok(_paged(CRISIS_ROWS if one("medicalNo") == MED_A else [], query)))
        elif path == "/api/example/item-history":
            self._send(_ok(TREND if one("userId") == HMS_A else {}))
        elif path == "/api/example/person":
            match = one("name") == "测试甲" and one("telephone") == "13800000001"
            self._send(_ok(ARCHIVE_PERSON if match else None))
        elif path == "/api/example/person-search":
            rows = ARCHIVE_PAGE if one("nameOrPhone") == "测试甲" else []
            self._send(_ok(_paged(rows, query)))
        else:
            self._send(_ok(None), 200)


def make_server(port: int = 0) -> tuple[ThreadingHTTPServer, str]:
    """就地起一个假系统，返回 ``(server, base_url)``；调用方负责 ``server.shutdown()``。"""
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, bound = server.server_address[0], server.server_address[1]
    return server, f"http://{host}:{bound}"


def main() -> int:
    parser = argparse.ArgumentParser(description="假的病例系统（离线测试用）")
    parser.add_argument("--port", type=int, default=8099)
    args = parser.parse_args()
    server, base = make_server(args.port)
    print(f"[mock] 假病例系统已启动: {base}（缺 Cookie 时回业务 401；doctorName=NOBODY 时名单为空）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
