"""Free-source, point-in-time financial prefill for left-side candidate reviews.

AKShare is the primary adapter. BaoStock is an optional independent check for
consolidated TTM profit and debt ratio; neither source can approve a review.
"""

from __future__ import annotations

import importlib
import logging
import math
import re
import threading
import time
from datetime import date, datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

_FETCH_LOCK = threading.Lock()
_PEER_CACHE: dict[str, tuple[float, list[dict[str, Any]], list[dict[str, Any]]]] = {}
_PEER_CACHE_TTL_SECONDS = 6 * 60 * 60

_MISSING_FIELD_REASONS = {
    "annual_net_profit": "未取得信号日前已公告的最近年度归母净利润",
    "ttm_net_profit": "最近四个已公告季度的归母净利润不完整",
    "consolidated_ttm_net_profit": "最近四个已公告季度的合并净利润不完整",
    "adjusted_ttm_net_profit": "最近四个已公告季度的扣非归母净利润不完整",
    "operating_cash_flow_ttm": "最近四个已公告季度的经营现金流不完整",
    "debt_ratio": "未取得同一报告期且信号日前已公告的资产负债率",
    "debt_peer_percentile": "未能取得同一行业、同一报告期的有效同行负债率分位",
    "debt_peer_count": "未能计算有效同行样本数",
    "unrestricted_cash": "来源仅提供货币资金，无法区分受限资金，需人工核对附注",
    "short_term_debt": "短期有息债务需核对借款、债券及一年内到期项目，暂不自动估算",
    "industry_group": "未取得同报告期行业分类",
    "report_period": "未取得信号日前已公告的最近报告期",
    "announcement_at": "缺少报告公告日期，无法确认点时有效性",
    "audit_opinion": "未取得信号日前已公告的最近年度审计意见",
}

_FINANCIAL_INDUSTRY_MARKERS = (
    "银行", "保险", "证券", "金融", "信托", "期货", "多元金融", "finance", "bank", "insurance", "broker",
)


class FinancialDataFetchError(RuntimeError):
    """Raised when the primary public financial data source cannot be read."""


def _code(symbol: str) -> str:
    code = re.sub(r"[^0-9]", "", str(symbol or ""))
    if len(code) != 6:
        raise ValueError("股票代码格式无效")
    return code


def _ak_symbol(symbol: str) -> str:
    code = _code(symbol)
    if code.startswith(("6", "5")):
        market = "SH"
    elif code.startswith(("8", "4", "9")):
        market = "BJ"
    else:
        market = "SZ"
    return f"{market}{code}"


def _date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if hasattr(value, "to_pydatetime"):
        try:
            converted = value.to_pydatetime()
            return converted.date() if isinstance(converted, datetime) else None
        except (TypeError, ValueError):
            return None
    raw = str(value).strip()
    if not raw or raw.lower() in {"nan", "nat", "none", "null"}:
        return None
    try:
        return date.fromisoformat(raw[:10].replace("/", "-"))
    except ValueError:
        digits = re.sub(r"\D", "", raw)
        if len(digits) >= 8:
            try:
                return date(int(digits[:4]), int(digits[4:6]), int(digits[6:8]))
            except ValueError:
                return None
    return None


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _records(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, list):
        return [dict(row) for row in value if isinstance(row, dict)]
    if isinstance(value, tuple):
        return [dict(row) for row in value if isinstance(row, dict)]
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        try:
            rows = to_dict("records")
            if isinstance(rows, list):
                return [dict(row) for row in rows if isinstance(row, dict)]
        except (TypeError, ValueError):
            pass
    return []


def _as_of_periods(rows: list[dict[str, Any]], as_of: date) -> dict[date, dict[str, Any]]:
    """Keep only reports with an explicit publication date no later than as_of."""
    result: dict[date, dict[str, Any]] = {}
    notices: dict[date, date] = {}
    for row in rows:
        period = _date(row.get("REPORT_DATE") or row.get("statDate"))
        notice = _date(row.get("NOTICE_DATE") or row.get("pubDate"))
        if period is None or notice is None or period > as_of or notice > as_of:
            continue
        if period not in notices or notice >= notices[period]:
            result[period] = row
            notices[period] = notice
    return result


def _last_four_quarters(latest: date) -> list[date]:
    quarter_months = (3, 6, 9, 12)
    if latest.month not in quarter_months or latest.day != (31 if latest.month in (3, 12) else 30):
        raise ValueError("财务报告期不是有效季度末")
    year = latest.year
    index = quarter_months.index(latest.month)
    periods: list[date] = []
    for _ in range(4):
        month = quarter_months[index]
        periods.append(date(year, month, 31 if month in (3, 12) else 30))
        index -= 1
        if index < 0:
            index = 3
            year -= 1
    return periods


def _sum_periods(rows_by_period: dict[date, dict[str, Any]], periods: list[date], field: str) -> float | None:
    values = [_number(rows_by_period.get(period, {}).get(field)) for period in periods]
    if any(value is None for value in values):
        return None
    return round(sum(value for value in values if value is not None), 2)


def _normalize_code(value: Any) -> str:
    code = re.sub(r"\D", "", str(value or ""))
    return code[-6:].zfill(6) if code else ""


def _is_st(name: Any) -> bool:
    normalized = str(name or "").strip().upper().replace("＊", "*").replace("ＳＴ", "ST")
    return normalized.startswith(("ST", "*ST"))


def _is_financial_industry(industry: Any) -> bool:
    value = str(industry or "").casefold()
    return any(marker.casefold() in value for marker in _FINANCIAL_INDUSTRY_MARKERS)


def _peer_tables(akshare: Any, report_period: date) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    key = report_period.strftime("%Y%m%d")
    cached = _PEER_CACHE.get(key)
    now = time.monotonic()
    if cached and now - cached[0] < _PEER_CACHE_TTL_SECONDS:
        return cached[1], cached[2]
    debt = _records(akshare.stock_zcfz_em(date=key))
    results = _records(akshare.stock_yjbb_em(date=key))
    _PEER_CACHE[key] = (now, debt, results)
    return debt, results


def _peer_metrics(
    symbol: str,
    report_period: date,
    as_of: date,
    debt_rows: list[dict[str, Any]],
    results_rows: list[dict[str, Any]],
) -> tuple[float | None, int | None, float | None, float | None, str | None]:
    code = _code(symbol)
    industries: dict[str, str] = {}
    result_notice: dict[str, date] = {}
    for row in results_rows:
        peer_code = _normalize_code(row.get("股票代码") or row.get("SECURITY_CODE"))
        industry = str(row.get("所处行业") or row.get("行业") or "").strip()
        notice = _date(row.get("最新公告日期") or row.get("公告日期") or row.get("NOTICE_DATE"))
        if peer_code and industry and notice and notice <= as_of:
            if peer_code not in result_notice or notice >= result_notice[peer_code]:
                industries[peer_code] = industry
                result_notice[peer_code] = notice

    debt_by_code: dict[str, dict[str, Any]] = {}
    debt_notice: dict[str, date] = {}
    for row in debt_rows:
        peer_code = _normalize_code(row.get("股票代码") or row.get("SECURITY_CODE"))
        notice = _date(row.get("公告日期") or row.get("NOTICE_DATE"))
        if not peer_code or not notice or notice > as_of:
            continue
        if peer_code not in debt_notice or notice >= debt_notice[peer_code]:
            debt_by_code[peer_code] = row
            debt_notice[peer_code] = notice

    candidate_row = debt_by_code.get(code)
    candidate_ratio = _number((candidate_row or {}).get("资产负债率") or (candidate_row or {}).get("DEBT_ASSET_RATIO"))
    industry = industries.get(code)
    if not industry or not candidate_row or candidate_ratio is None:
        return candidate_ratio, None, None, _number((candidate_row or {}).get("资产-货币资金")), industry
    if _is_financial_industry(industry):
        return candidate_ratio, 0, None, _number(candidate_row.get("资产-货币资金")), industry

    peer_values: list[float] = []
    for peer_code, row in debt_by_code.items():
        if peer_code == code or _is_st(row.get("股票简称") or row.get("SECURITY_NAME_ABBR")):
            continue
        if industries.get(peer_code) != industry:
            continue
        ratio = _number(row.get("资产负债率") or row.get("DEBT_ASSET_RATIO"))
        if ratio is not None and 0 <= ratio <= 100:
            peer_values.append(ratio)
    if not peer_values:
        return candidate_ratio, 0, None, _number(candidate_row.get("资产-货币资金")), industry
    less = sum(value < candidate_ratio for value in peer_values)
    equal = sum(value == candidate_ratio for value in peer_values)
    percentile = round((less + equal * 0.5) / len(peer_values) * 100, 4)
    return candidate_ratio, len(peer_values), percentile, _number(candidate_row.get("资产-货币资金")), industry


# Non-overlapping balance-sheet items. Blank disclosure is unknown, never zero.
_SHORT_DEBT_FIELDS = ("SHORT_LOAN", "SHORT_BOND_PAYABLE", "SHORT_FIN_PAYABLE", "NONCURRENT_LIAB_1YEAR")


def _short_debt_details(rows: list[dict[str, Any]], period: date, as_of: date) -> dict[str, Any]:
    row = _as_of_periods(rows, as_of).get(period) or {}
    components = {key: _number(row.get(key)) for key in _SHORT_DEBT_FIELDS}
    missing = [key for key, value in components.items() if value is None or value < 0]
    # One-year maturities include leases and may include non-interest-bearing
    # items. Keep this as a review reference, not verified interest-bearing debt.
    total = round(sum(value for value in components.values() if value is not None), 2) if row and not missing else None
    return {
        "report_period": period.isoformat(),
        "announcement_at": str(row.get("NOTICE_DATE") or "")[:10] or None,
        "components": components,
        "missing_components": missing,
        "disclosed_short_debt_reference": total,
        "method": "短期借款+应付短期债券+应付短期融资款+一年内到期的非流动负债；最后一项须核对附注明细，参考合计不等于已核实的短期有息债务",
    }


def _quarter_parts(period: date) -> tuple[int, int]:
    return period.year, (period.month + 2) // 3


def _baostock_rows(bs: Any, method: str, code: str, year: int, quarter: int) -> list[dict[str, Any]]:
    response = getattr(bs, method)(code=code, year=year, quarter=quarter)
    if getattr(response, "error_code", "0") != "0":
        raise RuntimeError("BaoStock 查询失败")
    fields = list(getattr(response, "fields", []) or [])
    rows: list[dict[str, Any]] = []
    while response.next():
        values = response.get_row_data()
        rows.append(dict(zip(fields, values)))
    return rows


def _baostock_check(
    bs: Any,
    symbol: str,
    report_period: date,
    as_of: date,
    ak_consolidated_ttm: float | None,
    ak_debt_ratio: float | None,
) -> dict[str, Any]:
    code = _code(symbol)
    if code.startswith(("4", "8", "9")):
        return {"provider": "BaoStock", "status": "unsupported_market", "message": "BaoStock 公开财务接口仅覆盖沪深 A 股"}
    market_code = ("sh." if code.startswith(("6", "5")) else "sz.") + code
    year, quarter = _quarter_parts(report_period)
    query_periods = {(year, quarter)}
    if quarter < 4:
        query_periods.update({(year - 1, 4), (year - 1, quarter)})
    financial_rows: dict[tuple[int, int], dict[str, Any]] = {}
    debt_row: dict[str, Any] | None = None
    login = bs.login()
    if getattr(login, "error_code", "1") != "0":
        raise RuntimeError("BaoStock 登录失败")
    try:
        for query_year, query_quarter in sorted(query_periods):
            rows = _baostock_rows(bs, "query_profit_data", market_code, query_year, query_quarter)
            row = next((item for item in rows if _date(item.get("statDate")) == _period_for(query_year, query_quarter)), None)
            if row:
                financial_rows[(query_year, query_quarter)] = row
        debt_rows = _baostock_rows(bs, "query_balance_data", market_code, year, quarter)
        debt_row = next((item for item in debt_rows if _date(item.get("statDate")) == report_period), None)
    finally:
        try:
            bs.logout()
        except Exception:
            logger.debug("BaoStock logout failed", exc_info=True)

    ttm_value: float | None = None
    pub_dates: list[date] = []
    if quarter == 4:
        current = financial_rows.get((year, quarter))
        value = _number((current or {}).get("netProfit"))
        pub_date = _date((current or {}).get("pubDate"))
        if value is not None and pub_date and pub_date <= as_of:
            ttm_value = value
            pub_dates.append(pub_date)
    else:
        current = financial_rows.get((year, quarter))
        previous_fy = financial_rows.get((year - 1, 4))
        previous_ytd = financial_rows.get((year - 1, quarter))
        rows = (current, previous_fy, previous_ytd)
        values = [_number((row or {}).get("netProfit")) for row in rows]
        dates = [_date((row or {}).get("pubDate")) for row in rows]
        if all(value is not None for value in values) and all(item is not None and item <= as_of for item in dates):
            ttm_value = round(values[0] + values[1] - values[2], 2)  # type: ignore[operator]
            pub_dates.extend(item for item in dates if item is not None)

    ratio: float | None = None
    if debt_row:
        pub_date = _date(debt_row.get("pubDate"))
        raw_ratio = _number(debt_row.get("liabilityToAsset"))
        if pub_date and pub_date <= as_of and raw_ratio is not None:
            ratio = round(raw_ratio * 100, 4)
            pub_dates.append(pub_date)

    metrics: dict[str, Any] = {}
    mismatches: list[str] = []
    if ttm_value is not None:
        metrics["consolidated_ttm_net_profit"] = ttm_value
        if ak_consolidated_ttm is not None:
            difference = abs(ttm_value - ak_consolidated_ttm) / max(abs(ttm_value), abs(ak_consolidated_ttm), 1) * 100
            metrics["profit_difference_pct"] = round(difference, 4)
            if difference > 5:
                mismatches.append("BaoStock 与 AKShare 合并 TTM 净利润差异超过5%")
    if ratio is not None:
        metrics["debt_ratio"] = ratio
        if ak_debt_ratio is not None:
            difference = abs(ratio - ak_debt_ratio)
            metrics["debt_ratio_difference_pp"] = round(difference, 4)
            if difference > 5:
                mismatches.append("BaoStock 与 AKShare 资产负债率差异超过5个百分点")
    if not metrics:
        return {"provider": "BaoStock", "status": "unavailable", "message": "未返回可用于交叉核对的同报告期数据"}
    status = "conflict" if mismatches else ("matched" if len(metrics) >= 2 else "partial")
    return {
        "provider": "BaoStock",
        "status": status,
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "report_period": report_period.isoformat(),
        "announcement_dates": sorted({item.isoformat() for item in pub_dates}),
        "metrics": metrics,
        "warnings": mismatches,
        "tolerance": {"profit_difference_pct": 5, "debt_ratio_difference_pp": 5},
    }


def _period_for(year: int, quarter: int) -> date:
    return date(year, (quarter - 1) * 3 + 3, (31 if quarter in (1, 4) else 30))


def fetch_financial_prefill(
    symbol: str,
    signal_date: str,
    *,
    akshare_module: Any | None = None,
    baostock_module: Any | None = None,
) -> dict[str, Any]:
    """Fetch public statements as of the snapshot date and return an unsaved review draft."""
    code = _code(symbol)
    ak_symbol = _ak_symbol(code)
    as_of = _date(signal_date)
    if as_of is None:
        raise ValueError("榜单信号日期无效")
    if akshare_module is None:
        try:
            akshare_module = importlib.import_module("akshare")
        except ImportError as exc:
            raise FinancialDataFetchError("未安装 AKShare，暂时无法获取免费财务数据") from exc

    try:
        with _FETCH_LOCK:
            profit_rows = _records(akshare_module.stock_profit_sheet_by_quarterly_em(symbol=ak_symbol))
            cash_rows = _records(akshare_module.stock_cash_flow_sheet_by_quarterly_em(symbol=ak_symbol))
            annual_rows = _records(akshare_module.stock_profit_sheet_by_yearly_em(symbol=ak_symbol))
            profit_by_period = _as_of_periods(profit_rows, as_of)
            cash_by_period = _as_of_periods(cash_rows, as_of)
            common_periods = sorted(set(profit_by_period).intersection(cash_by_period))
            if not common_periods:
                raise FinancialDataFetchError("没有找到信号日前已公告的同期间利润表和现金流量表")
            report_period = common_periods[-1]
            quarters = _last_four_quarters(report_period)
            annual_by_period = _as_of_periods(annual_rows, as_of)
            annual_periods = [period for period in annual_by_period if period.month == 12 and period.day == 31]
            annual_period = max(annual_periods) if annual_periods else None
            annual_row = annual_by_period.get(annual_period) if annual_period else None
            profit_row = profit_by_period.get(report_period) or {}
            notices = [
                _date((profit_by_period.get(period) or {}).get("NOTICE_DATE"))
                for period in quarters
            ] + [
                _date((cash_by_period.get(period) or {}).get("NOTICE_DATE"))
                for period in quarters
            ]
            announcement_at = max((item for item in notices if item), default=None)

            try:
                debt_rows, results_rows = _peer_tables(akshare_module, report_period)
                debt_ratio, peer_count, debt_percentile, reported_cash, industry = _peer_metrics(
                    code, report_period, as_of, debt_rows, results_rows
                )
            except Exception:
                logger.warning("Left-side same-period debt peer data unavailable for %s", code, exc_info=True)
                debt_ratio, peer_count, debt_percentile, reported_cash, industry = None, None, None, None, None

            try:
                balance_rows = _records(akshare_module.stock_balance_sheet_by_report_em(symbol=ak_symbol))
                debt_details = _short_debt_details(balance_rows, report_period, as_of)
            except Exception:
                logger.warning("Left-side balance detail data unavailable for %s", code, exc_info=True)
                debt_details = _short_debt_details([], report_period, as_of)

            financial_data: dict[str, Any] = {
                "annual_net_profit": _number((annual_row or {}).get("PARENT_NETPROFIT")),
                "ttm_net_profit": _sum_periods(profit_by_period, quarters, "PARENT_NETPROFIT"),
                "consolidated_ttm_net_profit": _sum_periods(profit_by_period, quarters, "NETPROFIT"),
                "adjusted_ttm_net_profit": _sum_periods(profit_by_period, quarters, "DEDUCT_PARENT_NETPROFIT"),
                "operating_cash_flow_ttm": _sum_periods(cash_by_period, quarters, "NETCASH_OPERATE"),
                "debt_ratio": debt_ratio,
                "debt_peer_percentile": debt_percentile,
                "debt_peer_count": peer_count,
                "unrestricted_cash": None,
                "short_term_debt": None,
                "short_term_debt_details": debt_details,
                "industry_group": industry,
                "report_period": report_period.isoformat(),
                "announcement_at": announcement_at.isoformat() if announcement_at else None,
                "audit_opinion": str((annual_row or {}).get("OPINION_TYPE") or "").strip() or None,
                "reported_monetary_funds": reported_cash,
                "currency": "CNY",
                "ttm_method": "最近四个已公告单季度值直接求和；不使用信号日之后公告的数据",
            }

            warnings: list[str] = []
            missing_fields = [key for key, reason in _MISSING_FIELD_REASONS.items() if financial_data.get(key) in (None, "")]
            if "unrestricted_cash" in missing_fields:
                warnings.append(_MISSING_FIELD_REASONS["unrestricted_cash"])
            if "short_term_debt" in missing_fields:
                if debt_details["disclosed_short_debt_reference"] is not None:
                    warnings.append("已取得短债项目参考合计，需核对一年内到期项目附注后填写 short_term_debt")
                else:
                    warnings.append("短债明细缺失或未披露：" + "、".join(debt_details["missing_components"]) + "；不能按零处理")
            if industry and _is_financial_industry(industry):
                warnings.append("金融行业需专项财务模型；本次不生成同行负债分位")
            elif peer_count is None or peer_count < 10:
                warnings.append("同业可比有效样本不足10家时，负债质量评分保持未完成")

            cross_check: dict[str, Any]
            if baostock_module is None:
                try:
                    baostock_module = importlib.import_module("baostock")
                except ImportError:
                    baostock_module = None
            if baostock_module is None:
                cross_check = {"provider": "BaoStock", "status": "not_installed", "message": "当前环境未安装 BaoStock，未完成第二数据源交叉核对"}
            else:
                try:
                    cross_check = _baostock_check(
                        baostock_module,
                        code,
                        report_period,
                        as_of,
                        financial_data["consolidated_ttm_net_profit"],
                        financial_data["debt_ratio"],
                    )
                except Exception:
                    logger.warning("BaoStock cross-check failed for %s", code, exc_info=True)
                    cross_check = {"provider": "BaoStock", "status": "unavailable", "message": "BaoStock 暂不可用或返回结构变化，主数据仍需人工核对"}
            if cross_check.get("status") == "conflict":
                warnings.extend(cross_check.get("warnings") or ["两个免费来源数据存在差异，请人工核对原始公告"])
            elif cross_check.get("status") not in {"matched"}:
                warnings.append(str(cross_check.get("message") or "第二数据源交叉核对未完成"))

            equity_source_url = f"https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index?type=web&code={ak_symbol.lower()}#lrb-0"
            peer_source_urls = [
                f"https://data.eastmoney.com/bbsj/{report_period:%Y%m%d}/zcfz.html",
                f"https://data.eastmoney.com/bbsj/{report_period:%Y%m%d}/yjbb.html",
            ]
            source = "AKShare / 东方财富公开财报"
            if cross_check.get("status") in {"matched", "partial", "conflict"}:
                source += "；BaoStock 辅助交叉核对"
            evidence_lines = [
                f"信号日：{as_of.isoformat()}；采用最近已公告报告期：{report_period.isoformat()}，披露日：{announcement_at.isoformat() if announcement_at else '缺失'}。",
                "TTM 为最近四个已公告单季度值求和；每个报告公告日期均限制在信号日当日或之前。",
                f"同行负债分位按同报告期、同一所处行业计算，排除目标股票及 ST 名称；有效同行数：{peer_count if peer_count is not None else '不可用'}。",
                "货币资金原值只放入 reported_monetary_funds；短债原始明细保存在 short_term_debt_details，参考合计仍需核对附注。",
                f"第二来源状态：{cross_check.get('status', 'unavailable')}。",
                "第三方源可能更新历史报表内容；回溯历史快照请对照当时公告原文，自动预填不会自动通过财务复核。",
            ]
            evidence = " ".join(evidence_lines + warnings)
            financial_data["source_metadata"] = {
                "primary_provider": "AKShare / 东方财富公开财报",
                "secondary_provider": cross_check,
                "signal_date": as_of.isoformat(),
                "report_period": report_period.isoformat(),
                "announcement_at": announcement_at.isoformat() if announcement_at else None,
                "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "source_urls": [equity_source_url, *peer_source_urls],
                "ttm_quarters": [item.isoformat() for item in quarters],
                "ttm_method": financial_data["ttm_method"],
                "debt_peer_method": "同报告期与同所处行业；剔除目标股、ST 名称和金融行业；同行数量不含目标股",
                "warnings": warnings,
                "missing_fields": {key: _MISSING_FIELD_REASONS[key] for key in missing_fields},
            }
            return {
                "symbol": code,
                "signal_date": as_of.isoformat(),
                "financial_status": "needs_review",
                "financial_data": financial_data,
                "financial_source": source,
                "financial_evidence_url": equity_source_url,
                "financial_evidence": evidence,
                "missing_fields": missing_fields,
                "field_reasons": {key: _MISSING_FIELD_REASONS[key] for key in missing_fields},
                "warnings": warnings,
                "cross_check": cross_check,
            }
    except FinancialDataFetchError:
        raise
    except Exception as exc:
        logger.warning("AKShare financial prefill failed for %s", code, exc_info=True)
        raise FinancialDataFetchError("AKShare 免费财务数据源暂不可用或返回结构变化，请稍后重试") from exc
