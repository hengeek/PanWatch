"""Bounded, independent PE and securities checks. Results are unsaved drafts."""
from __future__ import annotations

import importlib
import json
import logging
import math
import re
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)
SOURCE = "BaoStock"
EVIDENCE_URL = "https://github.com/zxygithub/baostock/blob/master/docs/pythonAPI.md"


def _rows(response: Any) -> list[dict[str, str]]:
    if response.error_code != "0":
        raise RuntimeError("provider_query_failed")
    rows = []
    while response.next():
        rows.append(dict(zip(response.fields, response.get_row_data())))
    if response.error_code != "0":
        raise RuntimeError("provider_query_failed")
    return rows


def _query_provider(bs: Any, code: str, signal_date: str, today: str) -> dict[str, Any]:
    if bs.login().error_code != "0":
        raise RuntimeError("provider_login_failed")
    result: dict[str, Any] = {}
    try:
        queries = {
            "signal": lambda: bs.query_history_k_data_plus(code, "date,code,peTTM,isST,tradestatus", start_date=signal_date, end_date=signal_date, frequency="d", adjustflag="3"),
            "calendar": lambda: bs.query_trade_dates(start_date=(date.fromisoformat(today) - timedelta(days=15)).isoformat(), end_date=today),
            "basic": lambda: bs.query_stock_basic(code=code),
        }
        for key, query in queries.items():
            try:
                result[key] = _rows(query())
            except Exception:
                result[key] = []
                result[key + "_error"] = "query_failed"
        trading_days = [r.get("calendar_date", "") for r in result["calendar"] if r.get("is_trading_day") == "1" and r.get("calendar_date", "") <= today]
        expected = max(trading_days, default="")
        result["expected_date"] = expected
        result["current"] = []
        if expected:
            try:
                result["current"] = _rows(bs.query_history_k_data_plus(code, "date,code,isST,tradestatus", start_date=expected, end_date=expected, frequency="d", adjustflag="3"))
            except Exception:
                result["current_error"] = "query_failed"
        return result
    finally:
        bs.logout()


def _query_isolated(code: str, signal: str, today: str) -> dict[str, Any]:
    # BaoStock maintains a process-global session; a short-lived process isolates
    # it from financial cross-checks and bounds socket hangs without global settings.
    completed = subprocess.run(
        [sys.executable, "-m", __name__], input=json.dumps([code, signal, today]),
        text=True, capture_output=True, timeout=45, check=True,
    )
    marker = "PANWATCH_VERIFICATION="
    payload = next(line[len(marker):] for line in reversed(completed.stdout.splitlines()) if line.startswith(marker))
    return json.loads(payload)


def verify_candidate(symbol: str, signal_date: str, observed_pe: float, observed_source: str, *, today: date | None = None, provider: Any = None) -> dict[str, Any]:
    from src.modules.strategy.left_side.workflows import pe_confirmation_errors

    code = re.sub(r"\D", "", symbol)
    if len(code) != 6:
        raise ValueError("股票代码格式无效")
    signal = date.fromisoformat(signal_date)
    now = datetime.now(timezone.utc)
    today = today or now.astimezone(ZoneInfo("Asia/Shanghai")).date()
    if signal > today:
        raise ValueError("信号日期不能晚于当前日期")
    patch: dict[str, Any] = {
        "pe_status": "unknown", "pe_verified_value": None, "pe_checked_at": signal_date,
        "pe_source": SOURCE, "pe_evidence_url": EVIDENCE_URL, "pe_evidence": "",
        "security_status": "unknown", "security_trading_status": "unknown",
        "security_checked_at": today.isoformat(), "security_valid_until": today.isoformat(),
        "security_effective_at": "", "security_version": "baostock-daily-v1",
        "security_source": SOURCE, "security_evidence_url": EVIDENCE_URL, "security_evidence": "",
    }
    checks: list[dict[str, str]] = []
    result = {"symbol": code, "signal_date": signal_date, "checked_at": now.isoformat(timespec="seconds"), "source": SOURCE, "evidence_url": EVIDENCE_URL, "patch": patch, "checks": checks}
    if not code.startswith(("0", "3", "6")):
        reason = "该证券市场尚不支持 BaoStock 自动核验，请使用独立来源人工核验。"
        checks.append({"key": "provider", "status": "unavailable", "message": reason})
        patch["pe_evidence"] = patch["security_evidence"] = reason
        return result
    market_code = ("sh." if code.startswith("6") else "sz.") + code
    try:
        raw = _query_provider(provider, market_code, signal_date, today.isoformat()) if provider is not None else _query_isolated(market_code, signal_date, today.isoformat())
    except Exception:
        logger.warning("Independent candidate verification unavailable for %s", code, exc_info=True)
        reason = "自动核验数据源不可用或45秒内未完成；本次未核验成功，可重试或补充人工证据。"
        checks.append({"key": "provider", "status": "unavailable", "message": reason})
        patch["pe_evidence"] = patch["security_evidence"] = reason
        return result

    row = next((r for r in raw.get("signal", []) if r.get("code") == market_code and r.get("date") == signal_date), None)
    if row:
        try:
            value = float(row.get("peTTM", ""))
            patch["pe_verified_value"] = value if math.isfinite(value) else None
        except (ValueError, TypeError):
            pass
        patch["pe_evidence"] = json.dumps({"provider": SOURCE, "code": market_code, "signal_row": row, "fetched_at": result["checked_at"]}, ensure_ascii=False)
        patch["pe_status"] = "verified"
        item = SimpleNamespace(pe_ttm=observed_pe, pe_source=observed_source)
        errors = pe_confirmation_errors(item, SimpleNamespace(**patch), signal_date)
        # Provider identity is compared by family, not just a display label.
        if "baostock" in re.sub(r"[^a-z]", "", observed_source.lower()):
            errors.append("榜单与核验来源均为 BaoStock，不满足独立来源要求")
        if errors:
            patch["pe_status"] = "conflict" if patch["pe_verified_value"] is not None else "unknown"
        checks.append({"key": "pe", "status": patch["pe_status"], "message": "；".join(errors) if errors else "同一信号日独立 PE_TTM 核验通过，满足 0 < PE < 30 且与榜单偏差在允许范围内。"})
    else:
        patch["pe_evidence"] = f"BaoStock 未返回 {market_code} 在 {signal_date} 的精确日期数据；未使用其他日期替代。"
        checks.append({"key": "pe", "status": "unavailable", "message": patch["pe_evidence"]})

    expected = raw.get("expected_date", "")
    basic = next((r for r in raw.get("basic", []) if r.get("code") == market_code), None)
    current = next((r for r in raw.get("current", []) if r.get("code") == market_code and r.get("date") == expected), None)
    patch["security_effective_at"] = expected
    evidence = {"provider": SOURCE, "code": market_code, "expected_session": expected, "basic": basic, "daily": current, "fetched_at": result["checked_at"], "scope": "上市/退市状态、ST标志及日线停牌状态；不覆盖日内临停和重大事件"}
    patch["security_evidence"] = json.dumps(evidence, ensure_ascii=False)
    fresh = bool(expected and timedelta(0) <= today - date.fromisoformat(expected) <= timedelta(days=4))
    name = re.sub(r"\s+", "", str((basic or {}).get("code_name", ""))).upper().replace("＊", "*").replace("ＳＴ", "ST")
    if basic and basic.get("status") == "0":
        patch["security_status"] = "delisted"
    elif "退" in name:
        patch["security_status"] = "delisting"
    elif re.match(r"^(?:S)?\*?ST", name) or (current and current.get("isST") == "1"):
        patch["security_status"] = "st"
    elif basic and basic.get("type") == "1" and basic.get("status") == "1" and not basic.get("outDate") and current and current.get("isST") == "0" and fresh:
        patch["security_status"] = "normal"
    if current and fresh and patch["security_status"] not in {"delisted", "delisting"}:
        patch["security_trading_status"] = {"1": "trading", "0": "suspended"}.get(current.get("tradestatus", ""), "unknown")
    for key, value in (("security", patch["security_status"]), ("trading", patch["security_trading_status"])):
        ok = value in {"normal", "trading"}
        message = f"最近应有交易日 {expected or '未知'}，数据状态：{value}。"
        if value == "unknown":
            message += "来源缺失、过期或当日数据尚未发布，请稍后重试或人工核验。"
        checks.append({"key": key, "status": "verified" if ok else value, "message": message})
    return result


if __name__ == "__main__":
    args = json.loads(sys.stdin.read())
    data = _query_provider(importlib.import_module("baostock"), *args)
    print("PANWATCH_VERIFICATION=" + json.dumps(data, ensure_ascii=False))
