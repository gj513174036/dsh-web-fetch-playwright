#!/usr/bin/env python3
"""把采集到的原始事实折成"异常清单"，且每一条都能回答"凭什么判它异常"。

判定优先级（这是本文件唯一的业务判断，刻意做得窄而硬）：

1. **危急值** —— ``crisis`` 为真，或 ``crisisValue`` 非空 → severity ``crisis``
2. **报告自带的异常标志** —— ``flagText``（``abnormalTips``）非空 → 从文本里读方向（↑/H/high 高，↓/L/low 低），
   读不出方向就记 ``abnormal``；定性项 ``isYang`` 为真 → ``positive``
3. **参考区间比对** —— 只有当前两步都没有证据时，才拿 ``result`` 与
   ``reference`` / ``minValue`` / ``maxValue`` 比
4. **判不了就明说** —— 有结果但既无数值也无可比区间 → ``unknown``（保留，交人看，不静默丢弃）

每条输出都带 ``ruleId`` / ``ruleVersion`` / ``sourceEndpoint`` / ``sourceId`` / ``checkTime``，
所以半年后仍能复盘"为什么这个人被标异常"。

用法::

    python3 tools/his/rules.py --facts his-out/facts-2026-09-24.jsonl --out his-out

产出 ``evaluated-<tag>.jsonl``（全部条目 + 判定）与 ``abnormal-<tag>.jsonl``（非 normal 的）。"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from typing import Any

RULE_VERSION = "4"

#: 结果里的方向标记与噪声。**裸 +/- 不算方向**：那会把 "-1.5" 的符号和 "3.5-9.5" 的连字符误当异常标记，
#: 所以"清理数值"和"读方向"用两套模式。
_NUMBER = re.compile(r"[-+]?\d+(?:\.\d+)?")
_HIGH_HINT = re.compile(r"(↑|↑↑|H|high|偏高|增高|升高)", re.I)
_LOW_HINT = re.compile(r"(↓|↓↓|L|low|偏低|降低|减低)", re.I)
#: 报告标志码。实测取值：``M``(正常) ``N``(正常) ``H``(高) ``L``(低) ``P``(阳性) —— 
#: "非空即异常"会把 1096 条 M 误判成异常，所以正常码必须显式列出。
_NORMAL_CODES = {"", "M", "N", "NM", "正常", "阴性", "NEGATIVE", "NORMAL"}
_POSITIVE_CODES = {"P", "POS", "阳性", "POSITIVE", "+"}
_FLAG_HIGH = re.compile(r"(↑|H|high|偏高|增高|升高|\+)", re.I)
_FLAG_LOW = re.compile(r"(↓|L|low|偏低|降低|减低|-)", re.I)
_QUALITATIVE_NEGATIVE = re.compile(r"(阴性|negative|正常|未见异常|\(-\)|normal)", re.I)
_RANGE = re.compile(
    r"^\s*([-+]?\d+(?:\.\d+)?)\s*(?:--|-|~|—|–|～|至|到)\s*([-+]?\d+(?:\.\d+)?)\s*$"
)
#: 分段参考区间：``缺乏:0--19.9|不充足:20--29.9|充足:30--100|过量:>100``
_SEGMENT = re.compile(r"^\s*([^:|]{0,12}?)\s*:\s*(.+?)\s*$")
_UPPER = re.compile(r"^\s*(?:<|≤|＜|不高于|低于)\s*([-+]?\d+(?:\.\d+)?)\s*$")
_LOWER = re.compile(r"^\s*(?:>|≥|＞|不低于|高于)\s*([-+]?\d+(?:\.\d+)?)\s*$")


def parse_number(text: Any) -> float | None:
    """从结果文本里取出数值；取不到返回 None（定性结果、文字描述都走这里）。"""
    if text is None:
        return None
    if isinstance(text, (int, float)):
        return float(text)
    stripped = str(text).strip()
    # 先去掉方向标记，避免 "5.2↑" 里那一撇干扰；再取第一个数字。
    stripped = _HIGH_HINT.sub("", stripped)
    stripped = _LOW_HINT.sub("", stripped)
    match = _NUMBER.search(stripped)
    if match is None:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def parse_reference(text: Any) -> tuple[float | None, float | None, str]:
    """把参考区间文本解析成 ``(low, high, kind)``。

    ``kind`` ∈ ``numeric`` / ``qualitative`` / ``unknown``；``low``/``high`` 为 None 表示该侧不设限。
    """
    if text is None or str(text).strip() == "":
        return None, None, "unknown"
    raw = str(text).strip()
    # 定性要先判：中文化验单里 "(-)" 就是阴性，而去括号那一步会把它整段吃掉。
    if _QUALITATIVE_NEGATIVE.search(raw):
        return None, None, "qualitative"
    if "|" in raw and ":" in raw:
        labels = [seg.split(":", 1)[0].strip() for seg in raw.split("|") if ":" in seg]
        if labels:
            return None, None, "segmented"
    raw = re.sub(r"[（(][A-Za-z0-9%/\s]*[)）]", "", raw).strip()  # 只去掉 "(mmol/L)" 这类单位括号
    match = _RANGE.match(raw)
    if match:
        low, high = float(match.group(1)), float(match.group(2))
        return (low, high, "numeric") if low <= high else (high, low, "numeric")
    match = _UPPER.match(raw)
    if match:
        return None, float(match.group(1)), "numeric"
    match = _LOWER.match(raw)
    if match:
        return float(match.group(1)), None, "numeric"
    return None, None, "unknown"


def segment_verdict(reference: str, value: float) -> tuple[str, str]:
    """分段参考区间 → ``(verdict, 命中的段)``。

    这套系统的检验参考区间常常是分段式的（缺乏 / 不充足 / 充足 / 过量），
    比"一个上下限"信息量更大：值落在哪一段，段名本身就说明了结论。
    """
    for segment in str(reference).split("|"):
        if ":" not in segment:
            continue
        label, _, bound_text = segment.partition(":")
        low, high, _kind = parse_reference(bound_text.strip())
        inside = True
        if high is not None and value > high:
            inside = False
        if low is not None and value < low:
            inside = False
        if not inside:
            continue
        name = label.strip()
        if _HIGH_HINT.search(name) or re.search(r"(过量|过高|偏高|上限)", name):
            return "high", name
        if _LOW_HINT.search(name) or re.search(r"(缺乏|不足|偏低|低下|下限)", name):
            return "low", name
        if _QUALITATIVE_NEGATIVE.search(name) or re.search(r"(充足|正常|适宜|理想)", name):
            return "normal", name
        return "abnormal", name
    return "unknown", ""


def _flag_direction(text: Any) -> str:
    """从报告自带的标志文本里读方向；这里才允许把裸 "+" / "-" 当方向。"""
    raw = str(text or "")
    if _FLAG_HIGH.search(raw):
        return "high"
    if _FLAG_LOW.search(raw):
        return "low"
    return ""


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() not in ("", "0", "false", "none", "null", "no")


def verdict_of(item: dict[str, Any], item_extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """一条明细项的判定。返回带审计字段的 dict。

    真实字段语义（实测，与本文件顶部的优先级一一对应）：

    * ``crisis`` —— 只有**危急值模块**（``crisis_manager``）来的行才算；
    * ``flagText`` / ``arrow`` —— 报告自带的异常标志（``abnormalTips``）与方向箭头（``resultRemark``）；
    * ``reference`` —— 可能是简单区间，也可能是**分段式**（缺乏/不充足/充足/过量）；
    * ``crisisHint`` —— 明细里的 ``haveCrisis``。**它在本系统里几乎是常态（97% 为 1）**，
      所以只能降级成"请人看一眼"，绝不能当危急值。
    """
    extra = item_extra or {}
    result_text = item.get("result")
    reference_text = item.get("reference")
    flag_text = item.get("flagText")
    arrow_text = item.get("arrow")

    low, high, kind = parse_reference(reference_text)
    if low is None and extra.get("minValue") is not None:
        low = parse_number(extra.get("minValue"))
    if high is None and extra.get("maxValue") is not None:
        high = parse_number(extra.get("maxValue"))
    if (low is not None or high is not None) and kind == "unknown":
        kind = "numeric"

    verdict: dict[str, Any] = {
        "verdict": "normal",
        "severity": "info",
        "ruleId": "none",
        "ruleVersion": RULE_VERSION,
        "why": "",
        "result": result_text,
        "flagText": flag_text,
        "arrow": arrow_text,
        "reference": reference_text,
        "refLow": low,
        "refHigh": high,
        "refKind": kind,
    }

    # 0a) 处方/医嘱：它是"开过什么药"，不是化验值，永远不进异常清单
    if str(item.get("orderType") or "").strip() or item.get("frequency") or item.get("itemKind"):
        verdict.update(verdict="recorded", severity="info", ruleId="prescription",
                       why=f"处方/医嘱：{result_text or ''}".strip("："))
        return verdict

    # 0) 体检小结里的疾病/建议条目：没有数值，只有分级
    if item.get("level") is not None or (item.get("disease") and result_text in (None, "")):
        level = str(item.get("level") or "").strip()
        level_name = str(flag_text or "").strip()
        # 体检小结列的是"这个人有哪些诊断"，每条都带严重度分级；整体算异常会把
        # 数百条既往诊断刷成异常（实测 949 条）。只有名字本身指向危急时才升级。
        if re.search(r"(危急|危机|critical)", level_name, re.I):
            verdict.update(verdict="abnormal", severity="abnormal", ruleId="diagnosis-crisis",
                           why=f"体检结论分级 {level_name}")
        else:
            verdict.update(verdict="recorded", severity="info", ruleId="diagnosis",
                           why=f"体检结论条目（分级 {level_name or level or '无'}）")
        return verdict

    # 1) 危急值（只认危急值模块）
    if _truthy(item.get("crisis")):
        verdict.update(verdict="crisis", severity="crisis", ruleId="crisis",
                       why=f"危急值模块标记（{item.get('crisisValue') or '未给级别'}）")
        return verdict

    # 2) 报告自带的异常标志 / 方向箭头
    code = str(flag_text or "").strip().upper()
    arrow = str(arrow_text or "").strip()
    if code or arrow:
        direction = _flag_direction(arrow) or _flag_direction(code)
        if direction:
            verdict.update(verdict=direction, severity="abnormal", ruleId="report-flag",
                           why=f"报告标志 {code or arrow!r} 指向{'偏高' if direction == 'high' else '偏低'}")
        elif code in _POSITIVE_CODES:
            verdict.update(verdict="positive", severity="abnormal", ruleId="report-positive",
                           why=f"报告标志 {code!r} 为阳性")
        elif code in _NORMAL_CODES:
            verdict.update(verdict="normal", severity="info", ruleId="report-normal",
                           why=f"报告标志 {code or '(无)'!r} 表示正常")
        else:
            verdict.update(verdict="abnormal", severity="abnormal", ruleId="report-flag",
                           why=f"报告标志 {code!r} 无法归类，按异常保守处理")
        return verdict
    if _truthy(item.get("isYang")) or _truthy(extra.get("isYang")):
        verdict.update(verdict="positive", severity="abnormal", ruleId="report-positive", why="报告标记阳性")
        return verdict

    # 3) 参考区间比对：分段式优先（段名即结论），其次简单区间
    value = parse_number(result_text)
    if value is not None and kind == "segmented":
        seg_verdict, seg_name = segment_verdict(str(reference_text), value)
        verdict.update(verdict=seg_verdict, severity="info" if seg_verdict in ("normal", "unknown") else "abnormal",
                       ruleId="ref-segment", why=f"{value} 落在分段 {seg_name!r}")
        return verdict
    if value is not None and (low is not None or high is not None):
        if high is not None and value > high:
            verdict.update(verdict="high", severity="abnormal", ruleId="ref-range", why=f"{value} > 上限 {high}")
        elif low is not None and value < low:
            verdict.update(verdict="low", severity="abnormal", ruleId="ref-range", why=f"{value} < 下限 {low}")
        else:
            verdict.update(verdict="normal", severity="info", ruleId="ref-range", why=f"{value} 落在 [{low}, {high}] 内")
        return verdict

    # 3.5) 结果本身是定性阴性（如 "阴性(-)"）→ 正常。有定性参考区间的情形留给下面的
    #      qualitative 分支（它的 why 会带上参考，信息更多）。
    if (value is None and kind != "qualitative" and result_text is not None
            and _QUALITATIVE_NEGATIVE.search(str(result_text))):
        verdict.update(verdict="negative", severity="info", ruleId="qualitative-result",
                       why=f"定性结果 {str(result_text).strip()!r} 本身为阴性")
        return verdict

    # 4) 只有 haveCrisis 线索：降级为"请人看一眼"
    if _truthy(item.get("crisisHint")):
        verdict.update(verdict="unknown", severity="review", ruleId="crisis-hint",
                       why="明细带 haveCrisis 标记但无其他异常证据（该字段在本系统里近乎常态，需人工确认）")
        return verdict

    # 5) 判不了就明说
    if value is None and str(result_text or "").strip():
        if kind == "qualitative" or _QUALITATIVE_NEGATIVE.search(str(reference_text)):
            verdict.update(verdict="negative" if _QUALITATIVE_NEGATIVE.search(str(result_text)) else "abnormal",
                           severity="info", ruleId="qualitative",
                           why=f"定性结果 {str(result_text).strip()!r} 对参考 {reference_text!r}")
        else:
            verdict.update(verdict="unknown", severity="review", ruleId="unparsed",
                           why=f"既无异常标志、也无法解析数值（result={result_text!r} reference={reference_text!r}）")
        return verdict

    verdict.update(verdict="unknown", severity="review", ruleId="no-result", why="没有结果值")
    return verdict


def evaluate_fact(fact: dict[str, Any]) -> list[dict[str, Any]]:
    patient = fact.get("patient") or {}
    source = fact.get("source") or {}
    rows: list[dict[str, Any]] = []
    for item in fact.get("items") or []:
        if not isinstance(item, dict):
            continue
        verdict = verdict_of(item, fact.get("extra") if isinstance(fact.get("extra"), dict) else None)
        rows.append(
            {
                "date": fact.get("date"),
                "kind": fact.get("kind"),
                "patientKey": patient.get("hisUserId") or patient.get("hmsUserId"),
                "hisUserId": patient.get("hisUserId"),
                "hmsUserId": patient.get("hmsUserId"),
                "patientName": patient.get("name"),
                "itemCode": item.get("itemCode"),
                "itemName": item.get("itemName"),
                "unit": item.get("unit"),
                "checkTime": item.get("checkTime"),
                "sourceEndpoint": source.get("endpoint"),
                "sourceId": source.get("sourceId"),
                "collectedAt": source.get("collectedAt"),
                "evaluatedAt": dt.datetime.now().isoformat(timespec="seconds"),
                **verdict,
            }
        )
    return rows


SEVERITY_ORDER = {"crisis": 0, "abnormal": 1, "review": 2, "info": 3}


def evaluate(facts_path: str, outdir: str, tag: str, min_severity: str = "info") -> dict[str, Any]:
    os.makedirs(outdir, mode=0o700, exist_ok=True)
    evaluated_path = os.path.join(outdir, f"evaluated-{tag}.jsonl")
    abnormal_path = os.path.join(outdir, f"abnormal-{tag}.jsonl")
    counts: dict[str, int] = {}
    rule_counts: dict[str, int] = {}
    keep_at_or_above = SEVERITY_ORDER.get(min_severity, 3)
    total = 0
    abnormal = 0
    with open(facts_path, encoding="utf-8") as facts, \
            open(evaluated_path, "w", encoding="utf-8") as evaluated, \
            open(abnormal_path, "w", encoding="utf-8") as abnormal_out:
        for line in facts:
            line = line.strip()
            if not line:
                continue
            try:
                fact = json.loads(line)
            except json.JSONDecodeError:
                continue
            for row in evaluate_fact(fact):
                total += 1
                counts[row["verdict"]] = counts.get(row["verdict"], 0) + 1
                rule_counts[row["ruleId"]] = rule_counts.get(row["ruleId"], 0) + 1
                evaluated.write(json.dumps(row, ensure_ascii=False) + "\n")
                # 只看严重度：``negative`` / ``recorded`` 这类 verdict 是"正常/已记录"，
                # 按 verdict != normal 过滤会把 228 条阴性结果刷进异常清单。
                if row["severity"] != "info" and SEVERITY_ORDER.get(row["severity"], 3) <= keep_at_or_above:
                    abnormal += 1
                    abnormal_out.write(json.dumps(row, ensure_ascii=False) + "\n")
    for path in (evaluated_path, abnormal_path):
        os.chmod(path, 0o600)
    return {
        "facts": facts_path,
        "items": total,
        "abnormal": abnormal,
        "byVerdict": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
        "byRule": dict(sorted(rule_counts.items(), key=lambda kv: -kv[1])),
        "evaluated": evaluated_path,
        "abnormalPath": abnormal_path,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="异常值判定（规则化、可审计、可重跑）")
    parser.add_argument("--facts", required=True)
    parser.add_argument("--out", default="his-out")
    parser.add_argument("--tag", default=dt.date.today().isoformat())
    parser.add_argument("--min-severity", choices=tuple(SEVERITY_ORDER), default="info")
    args = parser.parse_args(argv)
    if not os.path.exists(args.facts):
        print(f"[rules] 找不到 {args.facts}", file=sys.stderr)
        return 2
    summary = evaluate(args.facts, args.out, args.tag, args.min_severity)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
