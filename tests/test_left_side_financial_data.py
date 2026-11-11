from __future__ import annotations

from types import SimpleNamespace

from src.modules.strategy.left_side import financial_data


def _rows(periods, fields, notices=None):
    notices = notices or {}
    return [
        {
            "REPORT_DATE": period,
            "NOTICE_DATE": notices.get(period, period),
            **values,
        }
        for period, values in zip(periods, fields)
    ]


class _FakeAKShare:
    def __init__(self, as_of: str = "2026-11-10"):
        quarter_periods = ["2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"]
        notices = {
            "2025-09-30": "2025-10-29",
            "2025-12-31": "2026-04-17",
            "2026-03-31": "2026-04-25",
            "2026-06-30": "2026-08-15",
            "2026-09-30": "2026-10-31",
        }
        profit_values = [
            {"PARENT_NETPROFIT": 7, "NETPROFIT": 8, "DEDUCT_PARENT_NETPROFIT": 6, "OPINION_TYPE": None},
            {"PARENT_NETPROFIT": 10, "NETPROFIT": 12, "DEDUCT_PARENT_NETPROFIT": 9, "OPINION_TYPE": "标准无保留意见"},
            {"PARENT_NETPROFIT": 2, "NETPROFIT": 3, "DEDUCT_PARENT_NETPROFIT": 1, "OPINION_TYPE": None},
            {"PARENT_NETPROFIT": 4, "NETPROFIT": 6, "DEDUCT_PARENT_NETPROFIT": 3, "OPINION_TYPE": None},
            {"PARENT_NETPROFIT": 5, "NETPROFIT": 7, "DEDUCT_PARENT_NETPROFIT": 4, "OPINION_TYPE": None},
        ]
        cash_values = [
            {"NETCASH_OPERATE": 5},
            {"NETCASH_OPERATE": 8},
            {"NETCASH_OPERATE": 9},
            {"NETCASH_OPERATE": 10},
            {"NETCASH_OPERATE": 11},
        ]
        if as_of == "2026-09-01":
            notices["2026-09-30"] = "2026-10-31"
        self.profit = _rows(quarter_periods, profit_values, notices)
        self.cash = _rows(quarter_periods, cash_values, notices)
        self.annual = [
            {"REPORT_DATE": "2025-12-31", "NOTICE_DATE": "2026-04-17", "PARENT_NETPROFIT": 40, "OPINION_TYPE": "标准无保留意见"},
            {"REPORT_DATE": "2024-12-31", "NOTICE_DATE": "2025-04-03", "PARENT_NETPROFIT": 35, "OPINION_TYPE": "标准无保留意见"},
        ]
        self.peer_tables: dict[str, tuple[list[dict], list[dict]]] = {}
        for period in ("20260630", "20260930"):
            debts = [{"股票代码": "600519", "股票简称": "贵州茅台", "资产负债率": 15, "资产-货币资金": 123, "公告日期": "2026-10-31" if period == "20260930" else "2026-08-15"}]
            industries = [{"股票代码": "600519", "股票简称": "贵州茅台", "所处行业": "白酒", "最新公告日期": "2026-10-31" if period == "20260930" else "2026-08-15"}]
            for index in range(10):
                code = f"00000{index}"
                debts.append({"股票代码": code, "股票简称": f"公司{index}", "资产负债率": 10 + index, "公告日期": "2026-08-15"})
                industries.append({"股票代码": code, "股票简称": f"公司{index}", "所处行业": "白酒", "最新公告日期": "2026-08-15"})
            debts.append({"股票代码": "000099", "股票简称": "*ST测试", "资产负债率": 99, "公告日期": "2026-08-15"})
            industries.append({"股票代码": "000099", "股票简称": "*ST测试", "所处行业": "白酒", "最新公告日期": "2026-08-15"})
            self.peer_tables[period] = (debts, industries)

    def stock_profit_sheet_by_quarterly_em(self, *, symbol):
        assert symbol == "SH600519"
        return self.profit

    def stock_cash_flow_sheet_by_quarterly_em(self, *, symbol):
        assert symbol == "SH600519"
        return self.cash

    def stock_profit_sheet_by_yearly_em(self, *, symbol):
        assert symbol == "SH600519"
        return self.annual

    def stock_balance_sheet_by_report_em(self, *, symbol):
        return []

    def stock_zcfz_em(self, *, date):
        return self.peer_tables[date][0]

    def stock_yjbb_em(self, *, date):
        return self.peer_tables[date][1]


class _UnavailableBaoStock:
    def login(self):
        return SimpleNamespace(error_code="1")


def test_prefill_sums_only_signal_date_available_quarters_and_keeps_review_pending():
    financial_data._PEER_CACHE.clear()
    result = financial_data.fetch_financial_prefill(
        "600519",
        "2026-11-10",
        akshare_module=_FakeAKShare(),
        baostock_module=_UnavailableBaoStock(),
    )

    values = result["financial_data"]
    assert values["report_period"] == "2026-09-30"
    assert values["ttm_net_profit"] == 21
    assert values["consolidated_ttm_net_profit"] == 28
    assert values["adjusted_ttm_net_profit"] == 17
    assert values["operating_cash_flow_ttm"] == 38
    assert values["annual_net_profit"] == 40
    assert values["debt_ratio"] == 15
    assert values["debt_peer_count"] == 10
    assert values["debt_peer_percentile"] == 55
    assert values["reported_monetary_funds"] == 123
    assert values["unrestricted_cash"] is None
    assert values["short_term_debt"] is None
    assert result["financial_status"] == "needs_review"
    assert "unrestricted_cash" in result["missing_fields"]
    assert "short_term_debt" in result["missing_fields"]
    assert result["cross_check"]["status"] == "unavailable"


def test_prefill_excludes_reports_announced_after_snapshot_signal_date():
    financial_data._PEER_CACHE.clear()
    result = financial_data.fetch_financial_prefill(
        "600519",
        "2026-09-01",
        akshare_module=_FakeAKShare(as_of="2026-09-01"),
        baostock_module=_UnavailableBaoStock(),
    )

    values = result["financial_data"]
    assert values["report_period"] == "2026-06-30"
    assert values["announcement_at"] <= "2026-09-01"
    assert values["ttm_net_profit"] == 23
    assert values["consolidated_ttm_net_profit"] == 29
    assert values["operating_cash_flow_ttm"] == 32
    assert result["signal_date"] == "2026-09-01"


def test_peer_metrics_ignore_st_names_and_financial_sector_names():
    report_period = financial_data._date("2026-09-30")
    assert report_period is not None
    rows = [
        {"股票代码": "600000", "股票简称": "目标", "资产负债率": 30, "公告日期": "2026-10-01"},
        {"股票代码": "000001", "股票简称": "ST样例", "资产负债率": 99, "公告日期": "2026-10-01"},
        {"股票代码": "000002", "股票简称": "银行样例", "资产负债率": 80, "公告日期": "2026-10-01"},
    ]
    industry_rows = [
        {"股票代码": "600000", "所处行业": "制造业", "最新公告日期": "2026-10-01"},
        {"股票代码": "000001", "所处行业": "制造业", "最新公告日期": "2026-10-01"},
        {"股票代码": "000002", "所处行业": "银行", "最新公告日期": "2026-10-01"},
    ]
    result = financial_data._peer_metrics("600000", report_period, financial_data._date("2026-11-01"), rows, industry_rows)
    assert result[1] == 0
    assert result[2] is None
    assert result[4] == "制造业"


def test_debt_details_keep_explicit_zero_but_never_treat_missing_as_zero():
    period = financial_data._date("2026-09-30")
    as_of = financial_data._date("2026-11-10")
    row = {"REPORT_DATE": "2026-09-30", "NOTICE_DATE": "2026-10-31",
           "SHORT_LOAN": 10, "SHORT_BOND_PAYABLE": 0,
           "SHORT_FIN_PAYABLE": 0, "NONCURRENT_LIAB_1YEAR": 3}
    result = financial_data._short_debt_details([row], period, as_of)
    assert result["disclosed_short_debt_reference"] == 13
    assert result["missing_components"] == []
    row["SHORT_BOND_PAYABLE"] = None
    result = financial_data._short_debt_details([row], period, as_of)
    assert result["disclosed_short_debt_reference"] is None
    assert result["missing_components"] == ["SHORT_BOND_PAYABLE"]


def test_debt_details_require_same_period_and_point_in_time_disclosure():
    period = financial_data._date("2026-09-30")
    as_of = financial_data._date("2026-11-10")
    for report, notice in [("2026-06-30", "2026-08-31"), ("2026-09-30", "2026-11-11")]:
        row = {"REPORT_DATE": report, "NOTICE_DATE": notice,
               **{key: 0 for key in financial_data._SHORT_DEBT_FIELDS}}
        result = financial_data._short_debt_details([row], period, as_of)
        assert result["disclosed_short_debt_reference"] is None
        assert len(result["missing_components"]) == 4
