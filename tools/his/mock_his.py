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


def _ok(data: Any) -> dict[str, Any]:
    return {"httpStatus": 200, "status": "0", "message": "success", "result": {}, "data": data}


def _paged(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {"list": rows, "pagination": {"pageSize": 50, "pageNum": 1, "pages": 1, "total": len(rows)}}


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
            rows = [] if one("doctorName") == "NOBODY" else [ROSTER_A, ROSTER_B]
            self._send(_ok(_paged(rows)))
        elif path == "/api/example/identity":
            self._send(_ok(_paged([r for r in IDENTITY_ROWS if r["name"] == one("name")])))
        elif path == "/api/example/dictionaries":
            wanted = [c for c in one("dictionaryTypeCode").split(",") if c]
            self._send(_ok({c: DICT_ENTRIES.get(c, []) for c in wanted}))
        elif re.match(r"^/api/example/visit/[^/]+$", path):
            self._send(_ok(VISIT_DETAIL))
        elif path == "/api/example/visits":
            user = one("userId")
            rows = []
            if user == HIS_A:
                rows = [{"id": "visit-a1", "hisUserId": HIS_A, "hmsUserId": HMS_A, "name": "测试甲",
                         "recordsNo": "R0001", "registerId": "reg-a", "clinicTime": 1790179200000,
                         "diagnosisList": [{"diseaseName": "高尿酸血症"}], "mainSuit": "体检复查"}]
            elif user == HIS_B:
                rows = [{"id": "visit-b1", "hisUserId": HIS_B, "hmsUserId": HMS_B, "name": "测试乙",
                         "recordsNo": "R0002", "registerId": "reg-b", "clinicTime": 1790179500000,
                         "diagnosisList": [{"diseaseName": "高脂血症"}], "mainSuit": ""}]
            self._send(_ok(_paged(rows)))
        elif path == "/api/example/reports":
            item_type = one("itemType")
            rows = []
            if one("userId") == HIS_A:
                for wanted, row in (("LAB", LAB_REPORT), ("EXAM", EXAM_REPORT)):
                    if wanted in item_type:
                        rows.append(row)
            self._send(_ok(_paged(rows)))
        elif re.match(r"^/api/example/report/[^/]+$", path):
            self._send(_ok(LAB_DETAIL if "lab" in path else {"id": path.rsplit("/", 1)[-1], "detailList": []}))
        elif path == "/api/example/checkups":
            self._send(_ok(_paged(CHECKUP_LIST if one("userId") == HMS_A else [])))
        elif re.match(r"^/api/example/checkup/[^/]+$", path):
            # 小结只认体检数据 id；用报告行 id 会被拒绝 —— 真实系统就是这个行为
            self._send(_ok(CHECKUP_SUMMARY if path.endswith("/checkup/med-data-1") else None))
        elif path == "/api/example/crisis":
            self._send(_ok(_paged(CRISIS_ROWS if one("medicalNo") == MED_A else [])))
        elif path == "/api/example/item-history":
            self._send(_ok(TREND if one("userId") == HMS_A else {}))
        elif path == "/api/example/person":
            match = one("name") == "测试甲" and one("telephone") == "13800000001"
            self._send(_ok(ARCHIVE_PERSON if match else None))
        elif path == "/api/example/person-search":
            rows = ARCHIVE_PAGE if one("nameOrPhone") == "测试甲" else []
            self._send(_ok(_paged(rows)))
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
