from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from src.modules.strategy.left_side import backtesting, rankings, workflows
from src.platform.persistence.database import Base
from src.platform.persistence.models import LeftSideRankingItem, LeftSideRankingSnapshot
from src.platform.persistence.models import LeftSideCandidateReview, LeftSideConditionalPlan, PaperTradingTrade


def test_left_side_name_gate_normalizes_fullwidth_st_without_overmatching():
    assert rankings._is_name_excluded(" ＊ＳＴ 示例")
    assert rankings._is_name_excluded("ST示例")
    assert rankings._is_name_excluded("示例退市整理")
    assert not rankings._is_name_excluded("退出机制科技")


def test_date_only_review_expiry_uses_china_market_day():
    # UTC is still the previous day when the China market date has rolled over.
    instant = datetime(2026, 11, 8, 16, 30, tzinfo=timezone.utc)
    assert workflows.market_today(instant).isoformat() == "2026-11-09"


def test_low_position_uses_prior_sample_and_equal_close_is_not_higher():
    bars = [
        SimpleNamespace(date=f"2026-01-{index:02d}", close=10.0 if index < 60 else 9.0, volume=1.0, open=9.0, high=10.0, low=8.0)
        for index in range(1, 62)
    ]
    metrics = rankings.calculate_observation_metrics(bars, 15.0)
    assert metrics is not None
    assert metrics["low_60"] == pytest.approx(100 * 59 / 60)
    assert metrics["signal_open"] == 9.0
    assert metrics["signal_high"] == 10.0
    assert metrics["signal_low"] == 8.0
    assert metrics["low_250"] is None
    assert metrics["low_composite"] is None


def test_financial_quality_score_requires_complete_and_valid_peer_data():
    data = {
        "annual_net_profit": 80,
        "ttm_net_profit": 100,
        "adjusted_ttm_net_profit": 50,
        "operating_cash_flow_ttm": 60,
        "debt_ratio": 40,
        "debt_peer_percentile": 40,
        "debt_peer_count": 10,
        "unrestricted_cash": 90,
        "short_term_debt": 30,
        "industry_group": "software",
        "report_period": "2025-12-31",
        "announcement_at": "2026-03-30",
        "audit_opinion": "标准无保留意见",
    }
    score, missing = workflows.quality_score(data)
    assert score == 52.5
    assert missing == []
    assert workflows.quality_score({"industry_group": "银行"})[0] is None
    assert workflows.quality_score({})[1]


def test_review_and_plan_gates_are_evidence_backed_and_coverage_strict():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        snapshot = LeftSideRankingSnapshot(
            id="snapshot-review",
            status="partial",
            phase="published",
            signal_date=date.today().isoformat(),
            coverage_status="unverified",
            parameters={"version": "test"},
        )
        item = LeftSideRankingItem(
            snapshot_id=snapshot.id,
            symbol="600000",
            name="示例科技",
            signal_close=10.0,
            pe_ttm=12.0,
            low_60=80,
            low_250=70,
            low_composite=75,
            pe_source="tencent",
            signal_date=date.today().isoformat(),
        )
        db.add_all([snapshot, item])
        db.commit()

        today = date.today().isoformat()
        complete_financials = {
            "annual_net_profit": 80,
            "ttm_net_profit": 100,
            "adjusted_ttm_net_profit": 75,
            "operating_cash_flow_ttm": 100,
            "debt_ratio": 40,
            "debt_peer_percentile": 50,
            "debt_peer_count": 12,
            "unrestricted_cash": 90,
            "short_term_debt": 30,
            "industry_group": "software",
            "report_period": "2025-12-31",
            "announcement_at": today,
            "audit_opinion": "标准无保留意见",
        }
        saved = workflows.update_review(db, snapshot.id, item.symbol, {
            "decision": "approve",
            "security_status": "normal",
            "security_trading_status": "trading",
            "security_checked_at": today,
            "security_valid_until": today,
            "security_source": "official_notice",
            "security_evidence": "risk status checked in test fixture",
            "pe_status": "verified",
            "pe_verified_value": 12.0,
            "pe_checked_at": today,
            "pe_source": "eastmoney quote",
            "pe_evidence_url": "https://quote.eastmoney.com/sh600000.html",
            "pe_evidence": "independent same-date PE evidence fixture",
            "financial_status": "passed",
            "financial_data": complete_financials,
            "financial_source": "reported_financial_statements",
            "financial_evidence": "financial evidence checked in test fixture",
            "event_status": "clear",
            "event_checked_at": today,
            "event_valid_until": today,
            "event_source": "exchange_notices",
            "event_evidence": "no unresolved material event in test fixture",
        }, actor="tester")
        assert saved["review_status"] == "approved"
        assert saved["quality_score"] is not None

        plan = workflows.create_plan(db, {
            "snapshot_id": snapshot.id,
            "symbol": item.symbol,
            "idempotency_key": "test-idempotency-key",
            "entry_band_pct": 0.01,
            "take_profit_rate": 0.03,
            "budget": 5000,
            "valid_until": (date.today() + timedelta(days=3)).isoformat(),
        }, actor="tester")
        assert plan["status"] == "pending_review"
        with pytest.raises(ValueError, match="覆盖未核实"):
            workflows.approve_plan(db, plan["id"], {"expected_version": plan["version"]}, actor="tester")


def test_coverage_verification_requires_matching_point_in_time_count_and_preserves_attestation():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        snapshot = LeftSideRankingSnapshot(
            id="snapshot-coverage",
            status="partial",
            phase="published",
            signal_date="2026-11-06",
            universe_total=3,
            excluded_st_count=1,
            fundamentals_checked=2,
            fundamentals_errors=0,
            pe_passed=1,
            history_checked=1,
            history_passed=1,
            history_errors=0,
            universe_stale=False,
            universe_catalogs={"CN": {"available": True}, "BJ": {"available": True}},
            coverage_status="unverified",
        )
        db.add(snapshot)
        db.commit()

        with pytest.raises(ValueError, match="数量不匹配"):
            workflows.verify_snapshot_coverage(db, snapshot.id, {
                "expected_total": 2,
                "as_of": "2026-11-06",
                "source": "交易所证券名录",
                "evidence_url": "https://www.example.com/official-list",
                "evidence": "fixture official count",
            }, actor="tester")
        assert snapshot.coverage_status == "unverified"

        result = workflows.verify_snapshot_coverage(db, snapshot.id, {
            "expected_total": 3,
            "as_of": "2026-11-06",
            "source": "交易所证券名录",
            "evidence_url": "https://www.example.com/official-list",
            "evidence": "fixture official count",
        }, actor="tester")
        assert result["operator_attested"] is True
        assert result["automatically_fetched_or_verified"] is False
        assert result["snapshot"]["status"] == "succeeded"
        assert result["snapshot"]["coverage_status"] == "verified"
        assert result["snapshot"]["coverage_checked_by"] == "tester"
        with pytest.raises(ValueError, match="不能覆盖"):
            workflows.verify_snapshot_coverage(db, snapshot.id, {
                "expected_total": 3,
                "as_of": "2026-11-06",
                "source": "another source",
                "evidence_url": "https://www.example.com/another-list",
                "evidence": "another fixture",
            }, actor="tester")


def test_pe_hard_gate_cannot_be_overridden_by_manual_decision():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        snapshot = LeftSideRankingSnapshot(id="snapshot-pe", status="partial", phase="published", coverage_status="unverified")
        item = LeftSideRankingItem(snapshot_id=snapshot.id, symbol="600001", name="样例公司", signal_close=10, pe_ttm=30, pe_source="tencent")
        db.add_all([snapshot, item])
        db.commit()
        result = workflows.update_review(db, snapshot.id, item.symbol, {"decision": "approve"}, actor="tester")
        assert result["review_status"] == "needs_review"
        assert "PE_TTM未通过硬条件" in result["review_note"]


def test_ai_report_validator_rejects_out_of_set_and_gate_bypass():
    candidate = {"symbol": "600000", "review_status": "pending"}
    report = {
        "market_judgment": {},
        "candidate_scores": [{
            "symbol": "999999",
            "low_position_score": 10,
            "earnings_score": 10,
            "trend_flow_score": 10,
            "risk_safety_score": 5,
            "total_score": 35,
            "action": "buy",
            "evidence": "fixture",
        }],
        "today_buy_list": ["600000"],
        "holdings_and_additions": {},
        "risks_and_discipline": {},
        "tomorrow_watch": {},
    }
    errors = workflows.validate_ai_report(report, {"600000"}, [candidate])
    assert any("输入集之外" in error for error in errors)
    assert any("不能进入买入清单" in error for error in errors)


def test_independent_simulation_replays_entry_and_fixed_target_without_old_paper_trades(monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        snapshot = LeftSideRankingSnapshot(
            id="snapshot-sim",
            status="succeeded",
            phase="published",
            signal_date="2026-01-01",
            coverage_status="verified",
        )
        item = LeftSideRankingItem(
            snapshot_id=snapshot.id,
            symbol="600000",
            name="示例科技",
            signal_date="2026-01-01",
            signal_close=10.0,
            pe_ttm=12.0,
            low_60=80,
            low_250=70,
            low_composite=75,
            pe_source="tencent",
        )
        review = LeftSideCandidateReview(
            snapshot_id=snapshot.id,
            symbol=item.symbol,
            name=item.name,
            security_status="normal",
            security_trading_status="trading",
            security_checked_at=date.today().isoformat(),
            security_valid_until=date.today().isoformat(),
            security_source="fixture",
            security_evidence="fixture evidence",
            pe_status="verified",
            pe_verified_value=12.0,
            pe_checked_at="2026-01-01",
            pe_source="eastmoney quote",
            pe_evidence_url="https://quote.eastmoney.com/sh600000.html",
            pe_evidence="same-date independent PE evidence fixture",
            financial_status="passed",
            financial_source="fixture",
            financial_evidence="fixture evidence",
            financial_data={
                "annual_net_profit": 80,
                "ttm_net_profit": 100,
                "adjusted_ttm_net_profit": 75,
                "operating_cash_flow_ttm": 100,
                "debt_ratio": 40,
                "debt_peer_percentile": 50,
                "debt_peer_count": 12,
                "unrestricted_cash": 90,
                "short_term_debt": 30,
                "industry_group": "software",
                "report_period": "2025-12-31",
                "announcement_at": "2026-03-30",
                "audit_opinion": "standard",
            },
            event_status="clear",
            event_checked_at=date.today().isoformat(),
            event_valid_until=date.today().isoformat(),
            event_source="fixture",
            event_evidence="no unresolved event",
            review_status="approved",
        )
        db.add_all([snapshot, item, review])
        db.commit()
        plan = workflows.create_plan(db, {
            "snapshot_id": snapshot.id,
            "symbol": item.symbol,
            "idempotency_key": "sim-test-plan-key",
            "budget": 5000,
            "valid_until": "2026-12-31",
        }, "tester")
        plan = workflows.approve_plan(db, plan["id"], {"expected_version": plan["version"]}, "tester")
        account = workflows.create_experiment_account(db, {
            "name": "fixture account",
            "starting_cash": 100000,
            "commission_rate": 0,
            "minimum_commission": 0,
            "stamp_tax_rate": 0,
            "transfer_fee_rate": 0,
        }, "tester")

        monkeypatch.setattr(workflows, "_latest_bars", lambda symbol: [
            SimpleNamespace(date="2026-01-02", open=10.0, high=10.2, low=9.9, close=10.1),
            SimpleNamespace(date="2026-01-05", open=10.1, high=10.4, low=10.0, close=10.3),
        ])
        class Provider:
            def fundamentals(self, symbols, market):
                return [SimpleNamespace(pe_ttm=12.0, source="tencent")]
        monkeypatch.setattr(workflows, "get_market_data", lambda: Provider())

        live_account = workflows.run_experiment_day(db, account["id"], "tester", [plan["id"]])
        assert live_account["trades_created"] == 0
        db_account = db.get(workflows.LeftSideExperimentAccount, account["id"])
        db_account.created_at = datetime(2026, 1, 1)
        db.commit()
        entry = workflows.run_experiment_day(db, account["id"], "tester", [plan["id"]])
        assert entry["trades_created"] == 1
        assert entry["take_profit_exits"] == []
        exit_result = workflows.run_experiment_day(db, account["id"], "tester", [plan["id"]])
        assert exit_result["trades_created"] == 1
        assert exit_result["take_profit_exits"] == [item.symbol]
        ledger = workflows.account_trades(db, account["id"], "tester")
        assert [trade["side"] for trade in reversed(ledger["trades"])] == ["buy", "sell"]
        assert ledger["account"]["cash"] == pytest.approx(100150)
        assert db.query(PaperTradingTrade).count() == 0


def _seed_backtest(db, *, hold_past_target: bool = False):
    from src.platform.scheduling.trading_calendar import is_trading_day

    dates = []
    current = date(2026, 1, 5)
    while len(dates) < 30:
        if is_trading_day("CN", current):
            dates.append(current.isoformat())
        current += timedelta(days=1)
    snapshots = []
    for index, signal_day in enumerate(dates):
        snapshot = LeftSideRankingSnapshot(
            id=f"snapshot-bt-{index:02d}",
            status="succeeded",
            phase="published",
            signal_date=signal_day,
            universe_total=1,
            excluded_st_count=0,
            fundamentals_checked=1,
            fundamentals_errors=0,
            pe_passed=1,
            history_checked=1,
            history_passed=1,
            history_errors=0,
            universe_stale=False,
            universe_catalogs={"CN": {"available": True}, "BJ": {"available": True}},
            coverage_status="verified",
            coverage_expected_total=1,
            coverage_source="fixture exchange catalog",
            coverage_evidence_url="https://www.example.com/official-list",
            coverage_evidence="synthetic point-in-time coverage fixture",
            coverage_as_of=signal_day,
            coverage_checked_at=f"{signal_day}T02:00:00+00:00",
            coverage_checked_by="tester",
        )
        snapshots.append(snapshot)
        db.add(snapshot)
        opening, high, close = 10.0, 10.2, 10.0
        if index == 2 and not hold_past_target:
            opening, high, close = 10.1, 10.4, 10.3
        if index == 2 and hold_past_target:
            opening, high, close = 10.1, 10.2, 10.1
        db.add(LeftSideRankingItem(
            snapshot_id=snapshot.id,
            symbol="600000",
            name="示例科技",
            signal_date=signal_day,
            signal_open=opening,
            signal_high=high,
            signal_low=9.8,
            signal_close=close,
            pe_ttm=12.0,
            low_60=80,
            low_250=70,
            low_composite=75,
            pe_source="tencent",
        ))

    signal_day = dates[0]
    review = LeftSideCandidateReview(
        snapshot_id=snapshots[0].id,
        symbol="600000",
        name="示例科技",
        security_status="normal",
        security_trading_status="trading",
        security_checked_at=signal_day,
        security_valid_until=dates[-1],
        security_source="fixture official source",
        security_evidence="normal status fixture",
        pe_status="verified",
        pe_verified_value=12.0,
        pe_checked_at=signal_day,
        pe_source="eastmoney quote",
        pe_evidence_url="https://quote.eastmoney.com/sh600000.html",
        pe_evidence="independent same-date PE fixture",
        financial_status="passed",
        financial_source="fixture financial statements",
        financial_evidence="financial quality fixture",
        financial_data={
            "annual_net_profit": 80,
            "ttm_net_profit": 100,
            "adjusted_ttm_net_profit": 75,
            "operating_cash_flow_ttm": 100,
            "debt_ratio": 40,
            "debt_peer_percentile": 50,
            "debt_peer_count": 12,
            "unrestricted_cash": 90,
            "short_term_debt": 30,
            "industry_group": "software",
            "report_period": "2025-12-31",
            "announcement_at": signal_day,
            "audit_opinion": "standard",
        },
        event_status="clear",
        event_checked_at=signal_day,
        event_valid_until=dates[-1],
        event_source="fixture exchange notices",
        event_evidence="no unresolved event fixture",
        review_status="approved",
        version=1,
        created_at=datetime.combine(date.fromisoformat(signal_day), datetime.min.time()) + timedelta(hours=5),
        updated_at=datetime.combine(date.fromisoformat(signal_day), datetime.min.time()) + timedelta(hours=5),
    )
    db.add(review)
    db.add(LeftSideConditionalPlan(
        id="plan-bt-1",
        idempotency_key="backtest-fixture-plan-key",
        snapshot_id=snapshots[0].id,
        symbol="600000",
        name="示例科技",
        industry="software",
        status="approved",
        entry_low=9.9,
        entry_high=10.1,
        budget=5000,
        quantity=None,
        take_profit_rate=0.03,
        target_price=10.3,
        valid_until=dates[-1],
        approved_at=datetime.combine(date.fromisoformat(signal_day), datetime.min.time()) + timedelta(hours=5),
        created_at=datetime.combine(date.fromisoformat(signal_day), datetime.min.time()) + timedelta(hours=4),
    ))
    db.commit()
    return snapshots


def test_portfolio_backtest_replays_only_persisted_approved_plans_and_suppresses_missing_marks():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        snapshots = _seed_backtest(db)
        config = {
            "starting_cash": 100000,
            "commission_rate": 0,
            "minimum_commission": 0,
            "stamp_tax_rate": 0,
            "transfer_fee_rate": 0,
        }
        result = backtesting.run_backtest(db, [row.id for row in snapshots], config, "tester")
        assert result["status"] == "succeeded"
        assert result["result"]["performance_valid"] is True
        assert result["result"]["summary"]["closed_trades"] == 1
        assert result["result"]["summary"]["realized_pnl"] == 150
        assert result["result"]["summary"]["total_return_pct"] == pytest.approx(0.15)

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        snapshots = _seed_backtest(db, hold_past_target=True)
        db.query(LeftSideRankingItem).filter_by(snapshot_id=snapshots[3].id, symbol="600000").delete()
        db.commit()
        result = backtesting.run_backtest(db, [row.id for row in snapshots], config, "tester")
        assert result["status"] == "partial"
        assert result["result"]["performance_valid"] is False
        assert result["result"]["summary"] is None
        assert result["result"]["data_gap"]["symbols"] == ["600000"]
