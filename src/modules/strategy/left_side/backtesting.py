"""Point-in-time portfolio replay for manually approved left-side plans."""

from __future__ import annotations

import uuid
import math
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from src.modules.strategy.left_side import workflows
from src.platform.persistence.models import (
    LeftSideBacktestRun,
    LeftSideCandidateReview,
    LeftSideConditionalPlan,
    LeftSideRankingItem,
    LeftSideRankingSnapshot,
)

_CN_TZ = ZoneInfo("Asia/Shanghai")


def _num(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _open_cutoff(day: str) -> datetime:
    return datetime.combine(date.fromisoformat(day), time(9, 25), _CN_TZ).astimezone(timezone.utc).replace(tzinfo=None)


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _review_valid_before_open(review: LeftSideCandidateReview | None, item: LeftSideRankingItem, decision_day: str, entry_day: str) -> bool:
    if not review or review.review_status != "approved":
        return False
    updated = _naive_utc(review.updated_at)
    if updated is None or updated > _open_cutoff(entry_day):
        return False
    checked = workflows._parse_date(review.security_checked_at)
    event_checked = workflows._parse_date(review.event_checked_at)
    event_valid = workflows._parse_date(review.event_valid_until)
    security_valid = workflows._parse_date(review.security_valid_until)
    decision = date.fromisoformat(decision_day)
    entry = date.fromisoformat(entry_day)
    if review.security_status != "normal" or review.security_trading_status != "trading":
        return False
    if not checked or checked > decision or checked < decision - timedelta(days=1) or not security_valid or security_valid < entry:
        return False
    if not (review.security_source and review.security_evidence):
        return False
    if workflows.pe_confirmation_errors(item, review, decision_day):
        return False
    if review.event_status != "clear" or not event_checked or event_checked > decision or event_checked < decision - timedelta(days=90):
        return False
    if not event_valid or event_valid < entry or not (review.event_source and review.event_evidence):
        return False
    if review.financial_status != "passed" or workflows.quality_score(review.financial_data or {})[0] is None:
        return False
    announcement = workflows._parse_date(str((review.financial_data or {}).get("announcement_at") or ""))
    if not announcement or announcement > decision:
        return False
    effective = workflows._parse_date(review.security_effective_at)
    if effective and effective > decision:
        return False
    return True


def _fee(config: dict[str, Any], amount: float, *, sell: bool) -> float:
    commission = max(float(config["minimum_commission"]), amount * float(config["commission_rate"]))
    transfer = amount * float(config["transfer_fee_rate"])
    stamp = amount * float(config["stamp_tax_rate"]) if sell else 0.0
    return round(commission + transfer + stamp, 4)


def _snapshot_rows(db: Session, snapshot: LeftSideRankingSnapshot) -> dict[str, LeftSideRankingItem]:
    return {
        row.symbol: row
        for row in db.query(LeftSideRankingItem).filter_by(snapshot_id=snapshot.id).all()
    }


def _item_payload(row: LeftSideRankingItem) -> dict[str, Any]:
    return {
        "symbol": row.symbol,
        "name": row.name or "",
        "signal_date": row.signal_date or "",
        "open": row.signal_open,
        "high": row.signal_high,
        "low": row.signal_low,
        "close": row.signal_close,
        "pe_ttm": row.pe_ttm,
        "data_source": row.data_source or "",
    }


def run_backtest(
    db: Session,
    snapshot_ids: list[str],
    config: dict[str, Any],
    owner_id: str | None,
) -> dict[str, Any]:
    """Replay only persisted, covered snapshots and approved plans.

    A missing held-position bar makes the run partial and suppresses headline
    return metrics. The engine never fetches today's history to fill a past gap.
    """
    ordered_ids = list(dict.fromkeys(snapshot_ids))
    readiness = workflows.backtest_readiness(db, ordered_ids)
    if not readiness["ready"]:
        raise ValueError("；".join(readiness["issues"]))
    if len(ordered_ids) > 1000:
        raise ValueError("单次回测最多使用1000个交易日快照")

    starting_cash = float(config.get("starting_cash", 0))
    fee_config = {
        key: float(config.get(key, -1))
        for key in ("commission_rate", "minimum_commission", "stamp_tax_rate", "transfer_fee_rate")
    }
    if starting_cash <= 0 or any(value < 0 for value in fee_config.values()):
        raise ValueError("起始资金必须大于0，且所有费用必须显式提供非负值")
    target_positions = int(config.get("target_positions", 25))
    invested_ratio = float(config.get("target_invested_ratio", 0.90))
    single_cap = float(config.get("single_name_cap", 0.05))
    industry_cap = float(config.get("industry_cap", 0.20))
    if target_positions < 1 or not 0 < invested_ratio <= 1 or not 0 < single_cap <= 1 or not 0 < industry_cap <= 1:
        raise ValueError("组合名额和仓位参数超出有效范围")

    snapshots = [db.get(LeftSideRankingSnapshot, identity) for identity in ordered_ids]
    if any(snapshot is None for snapshot in snapshots):
        raise ValueError("部分快照不存在")
    dates = [snapshot.signal_date for snapshot in snapshots]
    plans = db.query(LeftSideConditionalPlan).filter(
        LeftSideConditionalPlan.snapshot_id.in_(ordered_ids),
        LeftSideConditionalPlan.status.in_(("approved", "filled")),
    ).order_by(LeftSideConditionalPlan.approved_at.asc(), LeftSideConditionalPlan.created_at.asc()).all()
    if not plans:
        raise ValueError("这些快照没有人工批准的条件计划，不能生成基于猜测选股的回测")
    plan_snapshot_date = {
        snapshot.id: snapshot.signal_date
        for snapshot in snapshots
    }
    for plan in plans:
        if abs(float(plan.take_profit_rate or 0) - 0.03) > 1e-9:
            raise ValueError("当前回测只支持方案基线的3%固定价格止盈")
        if not plan.approved_at or plan.snapshot_id not in plan_snapshot_date:
            raise ValueError("条件计划缺少有效审批时间或不属于选定快照")

    rows_by_id = {snapshot.id: _snapshot_rows(db, snapshot) for snapshot in snapshots}
    reviews_by_snapshot_symbol = {
        (review.snapshot_id, review.symbol): review
        for review in db.query(LeftSideCandidateReview).filter(
            LeftSideCandidateReview.snapshot_id.in_(ordered_ids)
        ).all()
    }
    plans_by_symbol: dict[str, list[LeftSideConditionalPlan]] = {}
    for plan in plans:
        plans_by_symbol.setdefault(plan.symbol, []).append(plan)

    cash = starting_cash
    positions: dict[str, dict[str, Any]] = {}
    filled_plan_ids: set[str] = set()
    trades: list[dict[str, Any]] = []
    equity_curve: list[dict[str, Any]] = []
    peak_equity = starting_cash
    max_drawdown = 0.0
    total_fees = 0.0
    buy_turnover = 0.0
    sell_turnover = 0.0
    realized_pnl = 0.0
    closed_results: list[float] = []
    data_gap: dict[str, Any] | None = None

    for index, snapshot in enumerate(snapshots):
        day = snapshot.signal_date
        today_rows = rows_by_id[snapshot.id]
        # A held security missing from a later candidate-only snapshot has no
        # trustworthy mark or target-touch record; stop before inventing one.
        missing_holds = [
            symbol for symbol, position in positions.items()
            if symbol not in today_rows
            or today_rows[symbol].signal_close is None
            or today_rows[symbol].signal_open is None
            or today_rows[symbol].signal_high is None
        ]
        if missing_holds:
            data_gap = {"date": day, "symbols": missing_holds, "reason": "持仓日线未保存在该点时快照；停止并隐藏总收益统计"}
            break

        # The daily OHLC cannot order an entry and exit on the same session.
        for symbol, position in list(positions.items()):
            if day <= position["entry_date"]:
                continue
            row = today_rows[symbol]
            high = float(row.signal_high or 0)
            opening = float(row.signal_open or 0)
            target = float(position["target_price"])
            if high < target:
                continue
            exit_price = opening if opening >= target else target
            gross = exit_price * position["quantity"]
            sell_fee = _fee(fee_config, gross, sell=True)
            cash += gross - sell_fee
            pnl = round(gross - sell_fee - (position["entry_price"] * position["quantity"] + position["entry_fee"]), 2)
            realized_pnl += pnl
            closed_results.append(pnl)
            total_fees += sell_fee
            sell_turnover += gross
            trades.append({
                "date": day, "symbol": symbol, "side": "sell", "quantity": position["quantity"],
                "price": round(exit_price, 4), "gross_amount": round(gross, 2), "fees": sell_fee,
                "reason": "fixed_3pct_take_profit", "plan_id": position["plan_id"],
            })
            del positions[symbol]

        if index > 0:
            previous_snapshot = snapshots[index - 1]
            previous_rows = rows_by_id[previous_snapshot.id]
            open_time = _open_cutoff(day)
            for plan in plans:
                plan_id = plan.id
                if plan_id in filled_plan_ids:
                    continue
                signal_day = plan_snapshot_date[plan.snapshot_id]
                if signal_day >= day:
                    continue
                if _naive_utc(plan.approved_at) > open_time:
                    continue
                expiry = workflows._parse_date(plan.valid_until)
                if not expiry or expiry < date.fromisoformat(day):
                    continue
                if plan.symbol in positions or any(t["symbol"] == plan.symbol and t["date"] == day for t in trades):
                    continue
                original = rows_by_id[plan.snapshot_id].get(plan.symbol)
                previous = previous_rows.get(plan.symbol)
                today = today_rows.get(plan.symbol)
                if not original or not previous or not today or not previous.signal_close or not previous.pe_ttm:
                    continue
                opening = float(today.signal_open or 0)
                if opening <= 0 or not float(plan.entry_low) <= opening <= float(plan.entry_high):
                    continue
                review = reviews_by_snapshot_symbol.get((previous_snapshot.id, plan.symbol))
                verified_signal_pe = _num(review.pe_verified_value) if review else None
                pe_provider_source = str(previous.pe_source or "").lower()
                if verified_signal_pe is None or not pe_provider_source:
                    continue
                from src.modules.strategy.left_side.rankings import PARAMETERS
                if pe_provider_source not in PARAMETERS["pe_source_allowlist"]:
                    continue
                entry_pe = verified_signal_pe * opening / float(previous.signal_close)
                if not 0 < entry_pe < 30:
                    continue
                if not _review_valid_before_open(review, previous, previous_snapshot.signal_date, day):
                    continue
                industry = plan.industry or str((review.financial_data or {}).get("industry_group") or "")
                equity_at_open = cash + sum(
                    float(today_rows[symbol].signal_open or position["entry_price"]) * position["quantity"]
                    for symbol, position in positions.items()
                )
                invested_at_open = sum(
                    float(today_rows[symbol].signal_open or position["entry_price"]) * position["quantity"]
                    for symbol, position in positions.items()
                )
                industry_exposure = sum(
                    float(today_rows[symbol].signal_open or position["entry_price"]) * position["quantity"]
                    for symbol, position in positions.items() if position["industry"] == industry
                )
                cap = equity_at_open * single_cap
                max_invested = equity_at_open * invested_ratio
                max_industry = equity_at_open * industry_cap
                available = min(
                    float(plan.budget) if plan.budget and plan.budget > 0 else cap,
                    cap,
                    cash,
                    max_invested - invested_at_open,
                    max_industry - industry_exposure,
                )
                if len(positions) >= target_positions or available <= 0:
                    continue
                lot = 100
                desired = int(plan.quantity) if plan.quantity else int(available / opening)
                quantity = min(desired, int(available / opening)) // lot * lot
                if quantity <= 0:
                    continue
                gross = opening * quantity
                buy_fee = _fee(fee_config, gross, sell=False)
                if gross + buy_fee > cash:
                    continue
                cash -= gross + buy_fee
                total_fees += buy_fee
                buy_turnover += gross
                positions[plan.symbol] = {
                    "symbol": plan.symbol,
                    "name": plan.name or today.name,
                    "industry": industry,
                    "quantity": quantity,
                    "entry_price": opening,
                    "entry_fee": buy_fee,
                    "entry_date": day,
                    "target_price": round(opening * 1.03, 4),
                    "plan_id": plan_id,
                }
                filled_plan_ids.add(plan_id)
                trades.append({
                    "date": day, "symbol": plan.symbol, "side": "buy", "quantity": quantity,
                    "price": round(opening, 4), "gross_amount": round(gross, 2), "fees": buy_fee,
                    "reason": "approved_plan_open_inside_band_and_pe_recheck", "plan_id": plan_id,
                    "estimated_entry_pe_ttm": round(entry_pe, 6),
                })

        market_value = sum(float(today_rows[symbol].signal_close) * position["quantity"] for symbol, position in positions.items())
        equity = round(cash + market_value, 2)
        peak_equity = max(peak_equity, equity)
        drawdown = (equity / peak_equity - 1) if peak_equity else 0.0
        max_drawdown = min(max_drawdown, drawdown)
        unrealized = sum(
            (float(today_rows[symbol].signal_close) - position["entry_price"]) * position["quantity"] - position["entry_fee"]
            for symbol, position in positions.items()
        )
        equity_curve.append({
            "date": day,
            "cash": round(cash, 2),
            "market_value": round(market_value, 2),
            "equity": equity,
            "unrealized_pnl": round(unrealized, 2),
            "open_positions": len(positions),
            "drawdown": round(drawdown * 100, 4),
        })

    valid = data_gap is None and len(equity_curve) == len(snapshots)
    last_equity = equity_curve[-1]["equity"] if equity_curve else starting_cash
    summary = None
    if valid:
        summary = {
            "starting_cash": round(starting_cash, 2),
            "ending_equity": round(last_equity, 2),
            "total_return_pct": round((last_equity / starting_cash - 1) * 100, 4),
            "max_drawdown_pct": round(max_drawdown * 100, 4),
            "realized_pnl": round(realized_pnl, 2),
            "unrealized_pnl": equity_curve[-1]["unrealized_pnl"] if equity_curve else 0,
            "fees": round(total_fees, 2),
            "closed_trades": len(closed_results),
            "win_rate_pct": round(sum(1 for result in closed_results if result > 0) / len(closed_results) * 100, 2) if closed_results else None,
            "buy_turnover": round(buy_turnover, 2),
            "sell_turnover": round(sell_turnover, 2),
            "open_positions_at_end": len(positions),
        }

    result = {
        "performance_valid": valid,
        "summary": summary,
        "equity_curve": equity_curve,
        "trades": trades,
        "open_positions": list(positions.values()) if valid else [],
        "data_gap": data_gap,
        "limitations": [
            "仅回放所选历史快照中人工批准的条件计划，不模拟未保存的候选或AI决策。",
            "入场PE按前一信号日PE乘开盘价/前收盘价重估；假设一夜间没有未记录的利润、股本或公司行动变化。",
            "当前快照只保存PE合格股票的行情；持仓如从后续快照缺失，整次运行标记不完整且隐藏收益汇总。",
            "未接入点时基准指数及多参数滚动样本外对照，结果不构成策略收益验证。",
        ],
        "replay_method": "persisted_snapshots_and_approved_plans_v1",
    }
    run = LeftSideBacktestRun(
        id=str(uuid.uuid4()),
        owner_id=owner_id or "local-user",
        status="succeeded" if valid else "partial",
        snapshot_ids=ordered_ids,
        config={
            **config,
            "target_positions": target_positions,
            "target_invested_ratio": invested_ratio,
            "single_name_cap": single_cap,
            "industry_cap": industry_cap,
            "plan_selection": "historically approved plans only",
            "price_stop_enabled": False,
            "time_exit_enabled": False,
            "take_profit_rate": 0.03,
        },
        result=result,
        error_message="" if valid else str(data_gap or "持仓点时行情缺失，收益汇总不可用"),
        created_at=workflows.now_utc(),
        finished_at=workflows.now_utc(),
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return serialize_run(run)


def serialize_run(run: LeftSideBacktestRun) -> dict[str, Any]:
    return {
        "run_id": run.id,
        "status": run.status,
        "snapshot_ids": run.snapshot_ids or [],
        "config": run.config or {},
        "result": run.result or {},
        "error_message": run.error_message or "",
        "created_at": run.created_at.isoformat() if run.created_at else "",
        "finished_at": run.finished_at.isoformat() if run.finished_at else "",
    }


def list_runs(db: Session, owner_id: str | None, limit: int = 20) -> list[dict[str, Any]]:
    rows = db.query(LeftSideBacktestRun).filter_by(owner_id=owner_id or "local-user").order_by(LeftSideBacktestRun.created_at.desc()).limit(limit).all()
    return [serialize_run(row) for row in rows]


def get_run(db: Session, run_id: str, owner_id: str | None) -> dict[str, Any] | None:
    row = db.get(LeftSideBacktestRun, run_id)
    if not row or row.owner_id != (owner_id or "local-user"):
        return None
    return serialize_run(row)
