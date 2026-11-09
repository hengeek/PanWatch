"""Authenticated read and refresh API for the isolated left-side workspace."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from src.modules.strategy.left_side import rankings
from src.modules.strategy.left_side import workflows
from src.modules.strategy.left_side import backtesting
from src.platform.persistence.models import LeftSideAIReport, LeftSideConditionalPlan, LeftSideExperimentAccount, LeftSideRankingSnapshot
from src.platform.persistence.database import get_db
from src.platform.persistence.models import LeftSideRankingItem
from src.modules.administration.api.auth import get_current_user
from src.web.errors import api_error

router = APIRouter()


class ReviewUpdate(BaseModel):
    expected_version: int | None = None
    decision: str = "pending"
    security_status: str | None = None
    security_trading_status: str | None = None
    security_effective_at: str | None = None
    security_version: str | None = None
    security_checked_at: str | None = None
    security_valid_until: str | None = None
    security_source: str | None = None
    security_evidence_url: str | None = None
    security_evidence: str | None = None
    pe_status: str | None = None
    pe_verified_value: float | None = None
    pe_checked_at: str | None = None
    pe_source: str | None = None
    pe_evidence_url: str | None = None
    pe_evidence: str | None = None
    financial_status: str | None = None
    financial_data: dict | None = None
    financial_source: str | None = None
    financial_evidence_url: str | None = None
    financial_evidence: str | None = None
    event_status: str | None = None
    event_category: str | None = None
    event_checked_at: str | None = None
    event_valid_until: str | None = None
    event_source: str | None = None
    event_evidence_url: str | None = None
    event_evidence: str | None = None
    review_note: str | None = None


class PlanCreate(BaseModel):
    snapshot_id: str
    symbol: str
    idempotency_key: str = Field(min_length=8, max_length=160)
    report_id: str | None = None
    entry_band_pct: float = Field(default=0.01, gt=0, le=0.03)
    take_profit_rate: float = 0.03
    budget: float | None = Field(default=None, gt=0)
    quantity: int | None = Field(default=None, gt=0)
    valid_until: str = Field(min_length=10, max_length=10)


class PlanApproval(BaseModel):
    expected_version: int
    approval_note: str = ""


class PlanCancel(BaseModel):
    reason: str = ""


class ExperimentAccountCreate(BaseModel):
    name: str = "左侧策略实验账户"
    starting_cash: float = Field(gt=0)
    commission_rate: float = Field(ge=0)
    minimum_commission: float = Field(ge=0)
    stamp_tax_rate: float = Field(ge=0)
    transfer_fee_rate: float = Field(ge=0)


class ExperimentRunRequest(BaseModel):
    plan_ids: list[str] = Field(default_factory=list, max_length=50)


class ExperimentAccountStatusUpdate(BaseModel):
    status: str


class BacktestReadinessRequest(BaseModel):
    snapshot_ids: list[str] = Field(default_factory=list, max_length=1000)


class BacktestRunRequest(BacktestReadinessRequest):
    starting_cash: float = Field(gt=0)
    commission_rate: float = Field(ge=0)
    minimum_commission: float = Field(ge=0)
    stamp_tax_rate: float = Field(ge=0)
    transfer_fee_rate: float = Field(ge=0)
    target_positions: int = Field(default=25, ge=1, le=100)
    target_invested_ratio: float = Field(default=0.90, gt=0, le=1)
    single_name_cap: float = Field(default=0.05, gt=0, le=1)
    industry_cap: float = Field(default=0.20, gt=0, le=1)


class CoverageVerification(BaseModel):
    expected_total: int = Field(gt=0)
    as_of: str = Field(min_length=10, max_length=10)
    source: str = Field(min_length=2, max_length=200)
    evidence_url: str = Field(min_length=12, max_length=2000)
    evidence: str = Field(min_length=4, max_length=4000)


@router.get("/status")
def get_status(db: Session = Depends(get_db)):
    current = rankings.serialize_snapshot(rankings.get_latest_snapshot(db))
    latest = rankings.serialize_snapshot(rankings.get_latest_completed_snapshot(db))
    return {"current": current, "latest_completed": latest}


@router.get("/snapshots")
def get_snapshots(offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100), db: Session = Depends(get_db)):
    query = db.query(LeftSideRankingSnapshot).order_by(LeftSideRankingSnapshot.created_at.desc())
    total = query.count()
    rows = query.offset(offset).limit(limit).all()
    return {"items": [rankings.serialize_snapshot(row) for row in rows], "total": total, "offset": offset, "limit": limit}


@router.post("/rankings/refresh")
def refresh_rankings():
    """Start one explicit, bounded-concurrency observation-ranking job."""
    return rankings.start_snapshot()


@router.post("/rankings/{snapshot_id}/cancel")
def cancel_rankings(snapshot_id: str):
    try:
        return rankings.cancel_snapshot(snapshot_id)
    except ValueError as exc:
        raise api_error(404, "left_side_snapshot_not_found", str(exc))


@router.put("/snapshots/{snapshot_id}/coverage")
def put_snapshot_coverage(
    snapshot_id: str,
    body: CoverageVerification,
    db: Session = Depends(get_db),
    actor: str | None = Depends(get_current_user),
):
    try:
        return workflows.verify_snapshot_coverage(db, snapshot_id, body.model_dump(), actor)
    except ValueError as exc:
        raise api_error(409, "left_side_coverage_verification_failed", str(exc))


@router.get("/rankings")
def get_rankings(
    board: str = Query("low_composite"),
    snapshot_id: str = Query(""),
    offset: int = Query(0, ge=0),
    limit: int = Query(30, ge=1, le=100),
    db: Session = Depends(get_db),
):
    if board not in rankings.BOARDS:
        raise api_error(400, "left_side_board_unknown", "未知的左侧策略榜单")
    snapshot = None
    if snapshot_id:
        from src.platform.persistence.models import LeftSideRankingSnapshot

        snapshot = db.get(LeftSideRankingSnapshot, snapshot_id)
    else:
        snapshot = rankings.get_latest_completed_snapshot(db)
    if snapshot is None or snapshot.status not in {"succeeded", "partial"}:
        return {
            "snapshot_id": snapshot.id if snapshot else "",
            "board": board,
            "items": [],
            "total": 0,
            "offset": offset,
            "limit": limit,
        }

    metric, direction = rankings.BOARDS[board]
    column = getattr(LeftSideRankingItem, metric)
    query = db.query(LeftSideRankingItem).filter(
        LeftSideRankingItem.snapshot_id == snapshot.id,
        column.is_not(None),
    )
    total = query.count()
    ordered = query.order_by(
        column.desc() if direction == "desc" else column.asc(),
        LeftSideRankingItem.pe_ttm.asc(),
        LeftSideRankingItem.symbol.asc(),
    ).offset(offset).limit(limit).all()
    return {
        "snapshot_id": snapshot.id,
        "signal_date": snapshot.signal_date or "",
        "snapshot": rankings.serialize_snapshot(snapshot),
        "board": board,
        "items": [
            {
                "rank": offset + index,
                "symbol": row.symbol,
                "name": row.name,
                "signal_date": row.signal_date,
                "signal_close": row.signal_close,
                "pe_ttm": row.pe_ttm,
                "low_60": row.low_60,
                "low_250": row.low_250,
                "low_1000": row.low_1000,
                "low_composite": row.low_composite,
                "drawdown_10": row.drawdown_10,
                "drawdown_30": row.drawdown_30,
                "drawdown_90": row.drawdown_90,
                "risk_status": row.risk_status,
                "admission_status": row.admission_status,
                "pe_observed_at": row.pe_observed_at,
                "pe_source": row.pe_source or "",
                "sample_start": row.sample_start,
                "sample_end": row.sample_end,
                "data_source": row.data_source,
            }
            for index, row in enumerate(ordered, start=1)
        ],
        "total": total,
        "offset": offset,
        "limit": limit,
    }


@router.get("/reviews")
def get_reviews(
    snapshot_id: str = Query(..., min_length=1),
    status: str = Query("", max_length=32),
    offset: int = Query(0, ge=0),
    limit: int = Query(30, ge=1, le=100),
    db: Session = Depends(get_db),
):
    if not db.get(LeftSideRankingSnapshot, snapshot_id):
        raise api_error(404, "left_side_snapshot_not_found", "榜单快照不存在")
    return workflows.list_reviews(db, snapshot_id, offset, limit, status)


@router.get("/reviews/{snapshot_id}/{symbol}")
def get_review(snapshot_id: str, symbol: str, db: Session = Depends(get_db)):
    try:
        row = workflows.get_or_create_review(db, snapshot_id, symbol)
        db.commit()
        return workflows.serialize_review(row, db)
    except ValueError as exc:
        raise api_error(404, "left_side_candidate_not_found", str(exc))


@router.put("/reviews/{snapshot_id}/{symbol}")
def put_review(snapshot_id: str, symbol: str, body: ReviewUpdate, db: Session = Depends(get_db), actor: str | None = Depends(get_current_user)):
    if body.decision not in {"pending", "approve", "hold", "reject"}:
        raise api_error(400, "left_side_review_decision_invalid", "复核决定无效")
    allowed_values = {
        "security_status": {"pending", "normal", "st", "delisting", "delisted", "conflict", "unknown"},
        "security_trading_status": {"pending", "trading", "suspended", "halted", "unknown"},
        "pe_status": {"pending", "verified", "conflict", "unknown"},
        "financial_status": {"pending", "passed", "needs_review", "rejected"},
        "event_status": {"pending", "clear", "risk", "unknown"},
    }
    for field_name, options in allowed_values.items():
        value = getattr(body, field_name)
        if value is not None and value not in options:
            raise api_error(400, "left_side_review_status_invalid", f"{field_name} 状态值无效")
    values = body.model_dump(exclude_unset=True)
    try:
        return workflows.update_review(db, snapshot_id, symbol, values, actor)
    except ValueError as exc:
        raise api_error(409, "left_side_review_conflict", str(exc))


@router.get("/reports")
def get_reports(snapshot_id: str = Query(..., min_length=1), db: Session = Depends(get_db)):
    if not db.get(LeftSideRankingSnapshot, snapshot_id):
        raise api_error(404, "left_side_snapshot_not_found", "榜单快照不存在")
    return {"items": workflows.list_reports(db, snapshot_id)}


@router.post("/reports/generate")
def generate_report(snapshot_id: str = Query(..., min_length=1), db: Session = Depends(get_db)):
    try:
        return workflows.generate_ai_report(snapshot_id)
    except ValueError as exc:
        raise api_error(409, "left_side_report_input_invalid", str(exc))


@router.get("/reports/{report_id}")
def get_report(report_id: str, db: Session = Depends(get_db)):
    report = workflows.get_report(db, report_id)
    if not report:
        raise api_error(404, "left_side_report_not_found", "AI 报告不存在")
    return report


@router.get("/plans")
def get_plans(status: str = Query("", max_length=32), db: Session = Depends(get_db)):
    return {"items": workflows.list_plans(db, status)}


@router.post("/plans")
def post_plan(body: PlanCreate, db: Session = Depends(get_db), actor: str | None = Depends(get_current_user)):
    values = body.model_dump()
    try:
        return workflows.create_plan(db, values, actor)
    except ValueError as exc:
        raise api_error(409, "left_side_plan_blocked", str(exc))
    except Exception as exc:
        db.rollback()
        if "uq_left_side_plan_idempotency" in str(exc):
            existing = db.query(LeftSideConditionalPlan).filter_by(idempotency_key=body.idempotency_key).first()
            if existing:
                return workflows.serialize_plan(existing)
        raise


@router.post("/plans/{plan_id}/approve")
def post_plan_approval(plan_id: str, body: PlanApproval, db: Session = Depends(get_db), actor: str | None = Depends(get_current_user)):
    try:
        return workflows.approve_plan(db, plan_id, body.model_dump(), actor)
    except ValueError as exc:
        raise api_error(409, "left_side_plan_not_approvable", str(exc))


@router.post("/plans/{plan_id}/cancel")
def post_plan_cancellation(plan_id: str, body: PlanCancel, db: Session = Depends(get_db), actor: str | None = Depends(get_current_user)):
    try:
        return workflows.cancel_plan(db, plan_id, actor, body.reason)
    except ValueError as exc:
        raise api_error(409, "left_side_plan_cancel_failed", str(exc))


@router.get("/simulation/accounts")
def get_experiment_accounts(db: Session = Depends(get_db), actor: str | None = Depends(get_current_user)):
    return {"items": workflows.list_accounts(db, actor)}


@router.post("/simulation/accounts")
def post_experiment_account(body: ExperimentAccountCreate, db: Session = Depends(get_db), actor: str | None = Depends(get_current_user)):
    return workflows.create_experiment_account(db, body.model_dump(), actor)


@router.get("/simulation/accounts/{account_id}")
def get_experiment_account(account_id: str, db: Session = Depends(get_db), actor: str | None = Depends(get_current_user)):
    try:
        return workflows.account_trades(db, account_id, actor)
    except ValueError as exc:
        raise api_error(404, "left_side_experiment_account_not_found", str(exc))


@router.patch("/simulation/accounts/{account_id}")
def patch_experiment_account(account_id: str, body: ExperimentAccountStatusUpdate, db: Session = Depends(get_db), actor: str | None = Depends(get_current_user)):
    try:
        return workflows.set_account_status(db, account_id, actor, body.status)
    except ValueError as exc:
        raise api_error(409, "left_side_experiment_account_update_failed", str(exc))


@router.post("/simulation/accounts/{account_id}/run")
def run_experiment_day(account_id: str, body: ExperimentRunRequest, db: Session = Depends(get_db), actor: str | None = Depends(get_current_user)):
    try:
        return workflows.run_experiment_day(db, account_id, actor, body.plan_ids)
    except ValueError as exc:
        raise api_error(409, "left_side_experiment_run_blocked", str(exc))


@router.post("/backtests/readiness")
def get_backtest_readiness(body: BacktestReadinessRequest, db: Session = Depends(get_db)):
    return workflows.backtest_readiness(db, body.snapshot_ids)


@router.post("/backtests/run")
def post_backtest(body: BacktestRunRequest, db: Session = Depends(get_db), actor: str | None = Depends(get_current_user)):
    values = body.model_dump()
    snapshot_ids = values.pop("snapshot_ids")
    try:
        return backtesting.run_backtest(db, snapshot_ids, values, actor)
    except ValueError as exc:
        raise api_error(409, "left_side_backtest_blocked", str(exc))


@router.get("/backtests")
def get_backtests(limit: int = Query(20, ge=1, le=100), db: Session = Depends(get_db), actor: str | None = Depends(get_current_user)):
    return {"items": backtesting.list_runs(db, actor, limit)}


@router.get("/backtests/{run_id}")
def get_backtest(run_id: str, db: Session = Depends(get_db), actor: str | None = Depends(get_current_user)):
    run = backtesting.get_run(db, run_id, actor)
    if not run:
        raise api_error(404, "left_side_backtest_not_found", "组合回测记录不存在")
    return run
