"""Evidence review, AI report, conditional plans and isolated paper simulation."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import re
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.exc import IntegrityError

from src.platform.ai.ai_failover import get_configured_failover_client
from src.platform.ai.errors import diagnostic_ai_error_message
from src.platform.marketdata.collectors.kline_collector import KlineCollector
from src.platform.marketdata.marketdata_client import get_market_data
from src.platform.marketdata.models import MarketCode
from src.platform.persistence.database import SessionLocal
from src.platform.persistence.models import (
    LeftSideAIReport,
    LeftSideCandidateReview,
    LeftSideConditionalPlan,
    LeftSideExperimentAccount,
    LeftSideExperimentPosition,
    LeftSideExperimentTrade,
    LeftSideRankingItem,
    LeftSideRankingSnapshot,
    LeftSideReviewEvent,
)

logger = logging.getLogger(__name__)
_CN_TZ = ZoneInfo("Asia/Shanghai")
_REPORT_LOCK = threading.Lock()
_REPORT_THREADS: dict[str, threading.Thread] = {}

_RISK_SECURITY = {"st", "delisting", "delisted", "conflict", "unknown", "pending"}
_TRADING_BLOCKED = {"suspended", "halted", "unknown", "pending"}
_FINANCIAL_REQUIRED = (
    "annual_net_profit",
    "ttm_net_profit",
    "adjusted_ttm_net_profit",
    "operating_cash_flow_ttm",
    "debt_ratio",
    "debt_peer_percentile",
    "debt_peer_count",
    "unrestricted_cash",
    "short_term_debt",
    "industry_group",
    "report_period",
    "announcement_at",
    "audit_opinion",
)


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def market_today(now: datetime | None = None) -> date:
    """Return the current China market date for date-only evidence and plans."""
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(_CN_TZ).date()


def _num(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def quality_score(data: dict[str, Any]) -> tuple[float | None, list[str]]:
    """Return the documented Q score only when all source fields are present."""
    missing = [key for key in _FINANCIAL_REQUIRED if data.get(key) in (None, "")]
    numeric_keys = (
        "annual_net_profit", "ttm_net_profit", "adjusted_ttm_net_profit", "operating_cash_flow_ttm",
        "debt_ratio", "debt_peer_percentile", "debt_peer_count", "unrestricted_cash", "short_term_debt",
    )
    numeric = {key: _num(data.get(key)) for key in numeric_keys}
    missing.extend(key for key, value in numeric.items() if value is None and key not in missing)
    if missing:
        return None, missing
    industry = str(data.get("industry_group") or "").lower()
    if any(token in industry for token in ("bank", "insurance", "broker", "financial", "银行", "保险", "证券")):
        return None, ["金融行业需专项财务模型"]
    annual = numeric["annual_net_profit"]
    ttm = numeric["ttm_net_profit"]
    adjusted = numeric["adjusted_ttm_net_profit"]
    operating_cash = numeric["operating_cash_flow_ttm"]
    debt_percentile = numeric["debt_peer_percentile"]
    peer_count = numeric["debt_peer_count"]
    debt_ratio = numeric["debt_ratio"]
    if annual is None or ttm is None or adjusted is None or operating_cash is None or debt_percentile is None or peer_count is None or debt_ratio is None:
        return None, ["财务数值字段缺失"]
    if annual <= 0 or ttm <= 0:
        return None, ["年度及TTM归母净利润须为正"]
    if peer_count < 10:
        return None, ["同行有效样本不足10家"]
    if not 0 <= debt_percentile <= 100 or not 0 <= debt_ratio <= 100:
        return None, ["负债率或同行分位不在有效范围"]
    adjusted_quality = min(1.0, max(0.0, adjusted / ttm))
    cash_quality = min(1.0, max(0.0, (operating_cash / ttm) / 1.2))
    debt_quality = 1.0 - debt_percentile / 100.0
    score = 40 * adjusted_quality + 35 * cash_quality + 25 * debt_quality
    return round(score, 4), []


def _candidate(db, snapshot_id: str, symbol: str) -> tuple[LeftSideRankingSnapshot, LeftSideRankingItem]:
    snapshot = db.get(LeftSideRankingSnapshot, snapshot_id)
    if not snapshot or snapshot.status not in {"succeeded", "partial"}:
        raise ValueError("榜单快照不存在或尚未发布")
    item = db.query(LeftSideRankingItem).filter_by(snapshot_id=snapshot_id, symbol=symbol).first()
    if not item:
        raise ValueError("股票不属于指定榜单快照")
    return snapshot, item


def get_or_create_review(db, snapshot_id: str, symbol: str) -> LeftSideCandidateReview:
    _, item = _candidate(db, snapshot_id, symbol)
    review = db.query(LeftSideCandidateReview).filter_by(snapshot_id=snapshot_id, symbol=symbol).first()
    if review:
        return review
    review = LeftSideCandidateReview(snapshot_id=snapshot_id, symbol=symbol, name=item.name)
    db.add(review)
    db.flush()
    return review


def serialize_review(row: LeftSideCandidateReview, db=None) -> dict[str, Any]:
    score, missing = quality_score(row.financial_data or {})
    result = {
        "id": row.id,
        "snapshot_id": row.snapshot_id,
        "symbol": row.symbol,
        "name": row.name,
        "security_status": row.security_status,
        "security_trading_status": row.security_trading_status,
        "security_effective_at": row.security_effective_at or "",
        "security_version": row.security_version or "",
        "security_checked_at": row.security_checked_at or "",
        "security_valid_until": row.security_valid_until or "",
        "security_source": row.security_source or "",
        "security_evidence_url": row.security_evidence_url or "",
        "security_evidence": row.security_evidence or "",
        "pe_status": row.pe_status or "pending",
        "pe_verified_value": row.pe_verified_value,
        "pe_checked_at": row.pe_checked_at or "",
        "pe_source": row.pe_source or "",
        "pe_evidence_url": row.pe_evidence_url or "",
        "pe_evidence": row.pe_evidence or "",
        "financial_status": row.financial_status,
        "financial_data": row.financial_data or {},
        "financial_source": row.financial_source or "",
        "financial_evidence_url": row.financial_evidence_url or "",
        "financial_evidence": row.financial_evidence or "",
        "quality_score": score,
        "financial_missing": missing,
        "event_status": row.event_status,
        "event_category": row.event_category or "",
        "event_checked_at": row.event_checked_at or "",
        "event_valid_until": row.event_valid_until or "",
        "event_source": row.event_source or "",
        "event_evidence_url": row.event_evidence_url or "",
        "event_evidence": row.event_evidence or "",
        "review_status": row.review_status,
        "review_note": row.review_note or "",
        "reviewer_name": row.reviewer_name or "",
        "version": row.version,
        "updated_at": row.updated_at.isoformat() if row.updated_at else "",
    }
    if db:
        result["history"] = [
            {
                "action": event.action,
                "reason": event.reason or "",
                "created_at": event.created_at.isoformat() if event.created_at else "",
                "actor_name": event.actor_name or "",
                "next_state": event.next_state or {},
            }
            for event in db.query(LeftSideReviewEvent)
            .filter_by(review_id=row.id)
            .order_by(LeftSideReviewEvent.id.desc())
            .limit(30)
        ]
    return result


def update_review(db, snapshot_id: str, symbol: str, payload: dict[str, Any], actor: str | None) -> dict[str, Any]:
    snapshot, item = _candidate(db, snapshot_id, symbol)
    review = get_or_create_review(db, snapshot_id, symbol)
    previous = serialize_review(review)
    expected = payload.get("expected_version")
    if expected is not None and int(expected) != review.version:
        raise ValueError("复核记录已被更新，请刷新后重试")
    allowed = {
        "security_status", "security_trading_status", "security_effective_at", "security_version",
        "security_checked_at", "security_valid_until", "security_source", "security_evidence_url", "security_evidence",
        "pe_status", "pe_verified_value", "pe_checked_at", "pe_source", "pe_evidence_url", "pe_evidence",
        "financial_status", "financial_data", "financial_source", "financial_evidence_url", "financial_evidence",
        "event_status", "event_category", "event_checked_at", "event_valid_until", "event_source", "event_evidence_url", "event_evidence",
        "review_note",
    }
    for key in allowed & payload.keys():
        setattr(review, key, payload[key])
    review.name = item.name
    review.reviewer_id = actor or "local-user"
    review.reviewer_name = actor or "本地用户"
    review.version += 1

    security_checked = _parse_date(review.security_checked_at)
    valid_until = _parse_date(review.security_valid_until)
    today_market = market_today()
    security_current = (
        review.security_status == "normal"
        and review.security_trading_status == "trading"
        and bool(review.security_source and review.security_evidence)
        and security_checked is not None
        and security_checked <= today_market
        and security_checked >= today_market - timedelta(days=1)
        and valid_until is not None
        and valid_until >= today_market
    )
    financial_q, financial_missing = quality_score(review.financial_data or {})
    financial_complete = (
        review.financial_status == "passed"
        and financial_q is not None
        and bool(review.financial_source and review.financial_evidence)
    )
    event_clear = (
        review.event_status == "clear"
        and bool(review.event_source and review.event_evidence)
        and (event_checked := _parse_date(review.event_checked_at)) is not None
        and event_checked <= today_market
        and event_checked >= today_market - timedelta(days=90)
        and (event_valid_until := _parse_date(review.event_valid_until)) is not None
        and event_valid_until >= today_market
    )
    decision = str(payload.get("decision") or "pending")
    reasons: list[str] = []
    if not 0 < item.pe_ttm < 30:
        reasons.append("PE_TTM未通过硬条件")
    reasons.extend(pe_confirmation_errors(item, review, snapshot.signal_date))
    if review.security_status != "normal":
        reasons.append("证券风险状态未确认为正常")
    if review.security_trading_status != "trading":
        reasons.append("证券当前交易状态不可确认")
    if not security_current:
        reasons.append("证券状态证据缺失或已过期")
    if not financial_complete:
        reasons.extend(["财务质量尚未完整通过", *financial_missing])
    financial_data = review.financial_data or {}
    adjusted_ttm = _num(financial_data.get("adjusted_ttm_net_profit"))
    ttm_profit = _num(financial_data.get("ttm_net_profit"))
    cashflow = _num(financial_data.get("operating_cash_flow_ttm"))
    short_debt = _num(financial_data.get("short_term_debt"))
    unrestricted_cash = _num(financial_data.get("unrestricted_cash"))
    debt_peer = _num(financial_data.get("debt_peer_percentile"))
    explanation = str(financial_data.get("review_explanation") or "").strip()
    if ttm_profit and adjusted_ttm is not None and adjusted_ttm / ttm_profit < 0.5 and not explanation:
        reasons.append("扣非利润占比低于50%，需要记录人工解释")
    if ttm_profit and cashflow is not None and cashflow / ttm_profit < 0.5 and not explanation:
        reasons.append("经营现金流支持偏弱，需要记录人工解释")
    if debt_peer is not None and debt_peer >= 80 and short_debt is not None and short_debt > 0 and unrestricted_cash is not None and unrestricted_cash / short_debt < 1 and not explanation:
        reasons.append("同行负债率处于高位且现金覆盖不足，需要记录人工解释")
    audit_opinion = str(financial_data.get("audit_opinion") or "")
    if any(token in audit_opinion for token in ("否定", "无法表示")):
        reasons.append("审计意见存在重大风险")
    if not event_clear:
        reasons.append("重大事件检查尚未确认无未解决风险")
    if decision == "reject":
        review.review_status = "rejected"
    elif decision == "hold":
        review.review_status = "needs_review"
    elif decision == "approve" and not reasons:
        review.review_status = "approved"
    else:
        review.review_status = "needs_review" if any((review.security_status, review.financial_status, review.event_status)) else "pending"
    if decision == "approve" and reasons:
        review.review_note = "；".join(filter(None, [review.review_note, "系统未批准：" + "；".join(dict.fromkeys(reasons))]))

    next_state = serialize_review(review)
    db.add(LeftSideReviewEvent(
        review_id=review.id,
        snapshot_id=snapshot_id,
        symbol=symbol,
        action=f"review_{decision}",
        previous_state=previous,
        next_state=next_state,
        actor_id=actor or "local-user",
        actor_name=actor or "本地用户",
        reason=review.review_note or "",
    ))
    db.commit()
    db.refresh(review)
    return serialize_review(review, db)


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
        except ValueError:
            return None


def pe_confirmation_errors(item: LeftSideRankingItem, review: LeftSideCandidateReview | None, as_of: str) -> list[str]:
    """Validate the strict PE gate and independently recorded point-in-time evidence."""
    from src.modules.strategy.left_side.rankings import PARAMETERS

    errors: list[str] = []
    observed = _num(item.pe_ttm)
    if observed is None or not 0 < observed < 30:
        errors.append("PE_TTM未通过硬条件")
    if str(item.pe_source or "").lower() not in PARAMETERS["pe_source_allowlist"]:
        errors.append("PE_TTM供应商未在允许来源中")
    if not review or review.pe_status != "verified":
        errors.append("PE_TTM尚未由独立来源核验")
        return errors
    verified = _num(review.pe_verified_value)
    if verified is None or not 0 < verified < 30:
        errors.append("独立核验的PE_TTM未通过0 < PE < 30硬条件")
    checked = _parse_date(review.pe_checked_at)
    if not checked or checked.isoformat() != str(as_of or "")[:10]:
        errors.append("PE_TTM证据日期必须与榜单信号日一致")
    source = str(review.pe_source or "").strip()
    if not source or source.lower() == str(item.pe_source or "").strip().lower():
        errors.append("PE_TTM人工核验来源必须独立于榜单供应商")
    if not str(review.pe_evidence_url or "").startswith("https://") or not review.pe_evidence:
        errors.append("PE_TTM核验需要HTTPS证据链接及说明")
    if observed is not None and verified is not None and abs(verified - observed) > max(0.05, abs(observed) * 0.01):
        errors.append("独立PE_TTM与榜单值偏差超过1%，需先解决数据源冲突")
    return errors


def list_reviews(db, snapshot_id: str, offset: int = 0, limit: int = 30, status: str = "") -> dict[str, Any]:
    query = db.query(LeftSideCandidateReview).filter_by(snapshot_id=snapshot_id)
    if status:
        query = query.filter_by(review_status=status)
    total = query.count()
    rows = query.order_by(LeftSideCandidateReview.updated_at.desc(), LeftSideCandidateReview.symbol.asc()).offset(offset).limit(limit).all()
    return {"items": [serialize_review(row, db) for row in rows], "total": total, "offset": offset, "limit": limit}


def _boards_payload(db, snapshot: LeftSideRankingSnapshot) -> tuple[list[dict[str, Any]], list[str]]:
    from src.modules.strategy.left_side.rankings import BOARDS, visible_ranking_query

    eligible_query, _ = visible_ranking_query(db, snapshot.id)
    merged: dict[str, dict[str, Any]] = {}
    for board, (field, _) in BOARDS.items():
        col = getattr(LeftSideRankingItem, field)
        rows = (
            eligible_query.filter(col.is_not(None))
            .order_by(col.desc(), LeftSideRankingItem.pe_ttm.asc(), LeftSideRankingItem.symbol.asc())
            .limit(30)
            .all()
        )
        for rank, row in enumerate(rows, start=1):
            entry = merged.setdefault(row.symbol, {
                "symbol": row.symbol,
                "name": row.name,
                "signal_close": row.signal_close,
                "pe_ttm": row.pe_ttm,
                "pe_source": row.pe_source or "",
                "pe_observed_at": row.pe_observed_at or "",
                "low_composite": row.low_composite,
                "low_60": row.low_60,
                "low_250": row.low_250,
                "low_1000": row.low_1000,
                "drawdown_10": row.drawdown_10,
                "drawdown_30": row.drawdown_30,
                "drawdown_90": row.drawdown_90,
                "signal_date": row.signal_date,
                "sample_start": row.sample_start,
                "sample_end": row.sample_end,
                "sources": [],
                "ranks": {},
            })
            entry["sources"].append(board)
            entry["ranks"][board] = rank
    symbols = sorted(merged)
    reviews = {
        r.symbol: r
        for r in db.query(LeftSideCandidateReview).filter(
            LeftSideCandidateReview.snapshot_id == snapshot.id,
            LeftSideCandidateReview.symbol.in_(symbols or ["__none__"]),
        )
    }
    for symbol, entry in merged.items():
        review = reviews.get(symbol)
        entry["review_status"] = review.review_status if review else "pending"
        entry["pe_status"] = review.pe_status if review else "pending"
        entry["pe_verified_value"] = review.pe_verified_value if review else None
        entry["security_status"] = review.security_status if review else "pending"
        entry["financial_status"] = review.financial_status if review else "pending"
        entry["event_status"] = review.event_status if review else "pending"
    return list(merged.values()), symbols


def generate_ai_report(snapshot_id: str) -> dict[str, Any]:
    db = SessionLocal()
    try:
        snapshot = db.get(LeftSideRankingSnapshot, snapshot_id)
        if not snapshot or snapshot.status not in {"succeeded", "partial"}:
            raise ValueError("已發布的榜单快照不存在")
        candidates, symbols = _boards_payload(db, snapshot)
        frozen_input = {
            "snapshot_id": snapshot.id,
            "signal_date": snapshot.signal_date,
            "parameters": snapshot.parameters or {},
            "coverage_status": snapshot.coverage_status or "unverified",
            "admission_allowed": snapshot.status == "succeeded" and snapshot.coverage_status == "verified",
            "candidates": candidates,
            "data_boundary": "仅输入本快照中可见的行情与复核状态，不包含个人持仓、账户、现金或私人数据。",
        }
        encoded = json.dumps(frozen_input, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        fingerprint = hashlib.sha256(encoded.encode()).hexdigest()
        existing = db.query(LeftSideAIReport).filter_by(snapshot_id=snapshot_id, input_fingerprint=fingerprint).first()
        if existing and existing.status in {"queued", "running", "succeeded"}:
            return serialize_report(existing)
        if existing:
            report_id = existing.id
            previous_attempts = list((existing.usage or {}).get("attempt_history") or [])
            previous_attempts.append({"status": existing.status, "error": existing.error_message or "", "finished_at": existing.finished_at.isoformat() if existing.finished_at else ""})
            existing.status = "queued"
            existing.error_message = ""
            existing.report = {"snapshot_date": snapshot.signal_date, "candidate_count": len(symbols)}
            existing.usage = {"attempt_history": previous_attempts}
            existing.validation_errors = []
            existing.validation_status = "pending"
        else:
            report_id = str(uuid.uuid4())
            report = LeftSideAIReport(
                id=report_id,
                snapshot_id=snapshot_id,
                status="queued",
                input_fingerprint=fingerprint,
                input_symbols=symbols,
                report={"snapshot_date": snapshot.signal_date, "candidate_count": len(symbols)},
            )
            db.add(report)
        db.commit()
    finally:
        db.close()
    with _REPORT_LOCK:
        running = _REPORT_THREADS.get(report_id)
        if running and running.is_alive():
            return {"report_id": report_id, "status": "running", "reused": True}
        worker = threading.Thread(target=_run_ai_report, args=(report_id, frozen_input), daemon=True, name="left-side-ai-report")
        _REPORT_THREADS[report_id] = worker
        worker.start()
    return {"report_id": report_id, "status": "queued", "reused": False}


def _extract_json(raw: str) -> dict[str, Any]:
    text_value = raw.strip()
    if text_value.startswith("```"):
        text_value = re.sub(r"^```(?:json)?\s*|\s*```$", "", text_value, flags=re.I)
    start, end = text_value.find("{"), text_value.rfind("}")
    if start < 0 or end < start:
        raise ValueError("模型输出中没有 JSON 对象")
    parsed = json.loads(text_value[start:end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("报告根节点必须是对象")
    return parsed


def validate_ai_report(report: dict[str, Any], allowed_symbols: set[str], candidate_rows: list[dict[str, Any]], *, admission_allowed: bool = False) -> list[str]:
    required = ("market_judgment", "candidate_scores", "today_buy_list", "holdings_and_additions", "risks_and_discipline", "tomorrow_watch")
    errors = [f"缺少报告部分：{key}" for key in required if key not in report]
    scores = report.get("candidate_scores")
    if not isinstance(scores, list):
        return [*errors, "candidate_scores 必须是数组"]
    caps = {"low_position_score": 40, "earnings_score": 30, "trend_flow_score": 20, "risk_safety_score": 10}
    review_by_symbol = {row["symbol"]: row for row in candidate_rows}
    seen: set[str] = set()
    for entry in scores:
        if not isinstance(entry, dict):
            errors.append("候选评分项必须是对象")
            continue
        symbol = str(entry.get("symbol") or "")
        if symbol not in allowed_symbols:
            errors.append(f"模型引用输入集之外的股票：{symbol or '(empty)'}")
            continue
        if symbol in seen:
            errors.append(f"候选重复评分：{symbol}")
        seen.add(symbol)
        parts = []
        for key, cap in caps.items():
            value = _num(entry.get(key))
            if value is None or not 0 <= value <= cap:
                errors.append(f"{symbol} 的 {key} 缺失或越界")
            else:
                parts.append(value)
        total = _num(entry.get("total_score"))
        if len(parts) == 4 and (total is None or abs(total - sum(parts)) > 0.05):
            errors.append(f"{symbol} 的总分与四项分数不一致")
        if entry.get("action") == "buy" and review_by_symbol.get(symbol, {}).get("review_status") != "approved":
            errors.append(f"{symbol} 尚未完成准入复核，不能标为可买")
        if entry.get("action") == "buy" and not admission_allowed:
            errors.append(f"{symbol} 所属快照覆盖未核实或非完整结果，不能标为可买")
        if entry.get("action") not in {"watch", "review", "buy", "avoid"}:
            errors.append(f"{symbol} 的 action 值无效")
        if not entry.get("evidence"):
            errors.append(f"{symbol} 缺少数据证据摘要")
    missing_scores = allowed_symbols - seen
    if missing_scores:
        errors.append(f"模型未对全部去重候选评分，缺少 {len(missing_scores)} 只")
    buy_list = report.get("today_buy_list") or []
    if not isinstance(buy_list, list):
        errors.append("today_buy_list 必须是数组")
        buy_list = []
    for decision in buy_list:
        symbol = decision.get("symbol") if isinstance(decision, dict) else decision
        if symbol not in allowed_symbols:
            errors.append(f"买入清单引用输入集之外的股票：{symbol}")
            continue
        if review_by_symbol.get(symbol, {}).get("review_status") != "approved":
            errors.append(f"{symbol} 未通过完整准入，不能进入买入清单")
        if not admission_allowed:
            errors.append(f"{symbol} 所属快照覆盖未核实或非完整结果，不能进入买入清单")
    return errors


def _run_ai_report(report_id: str, frozen_input: dict[str, Any]) -> None:
    db = SessionLocal()
    try:
        row = db.get(LeftSideAIReport, report_id)
        if not row:
            return
        row.status = "running"
        row.updated_at = now_utc()
        db.commit()
        client = get_configured_failover_client(db)
        system_prompt = (
            "你是 PanWatch 的股票研究助手。只能解释用户冻结的行情快照，不能补造数据或引用输入之外的个股事实。"
            "你不负责证券状态、财务硬门槛、人工批准或下单；不输出虚构的账户持仓/资金。"
            "严格返回 JSON，不要 Markdown。六部分字段必须完整：market_judgment、candidate_scores、today_buy_list、"
            "holdings_and_additions、risks_and_discipline、tomorrow_watch。candidate_scores 每项字段为 symbol、"
            "low_position_score(0-40)、earnings_score(0-30)、trend_flow_score(0-20)、risk_safety_score(0-10)、"
            "total_score(四项之和)、action(watch/review/buy/avoid)、rationale、evidence。"
            "风险分越高代表越安全。任何 review_status 不是 approved 的股票 action 必须为 review 或 watch，"
            "且不得放入 today_buy_list。PE/证券风险/财务/事件/股票池覆盖缺失时，必须写明限制。"
            "其它四个文本部分可以用对象或数组，但需有 summary 或 items 字段。"
        )
        content = json.dumps(frozen_input, ensure_ascii=False, separators=(",", ":"))
        raw = asyncio.run(client.chat_multi(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": content},
            ],
            temperature=0.1,
            max_tokens=16000,
        ))
        parsed = _extract_json(raw)
        errors = validate_ai_report(
            parsed,
            set(row.input_symbols or []),
            frozen_input["candidates"],
            admission_allowed=bool(frozen_input.get("admission_allowed")),
        )
        row.report = parsed
        row.model_label = str(getattr(client, "used_model_label", "unknown"))
        usage = getattr(client, "last_usage", None)
        row.usage = usage if isinstance(usage, dict) else {"total_tokens_used": getattr(client, "total_tokens_used", None)}
        row.validation_errors = errors
        row.validation_status = "passed" if not errors else "failed"
        row.status = "succeeded" if not errors else "invalid"
        row.error_message = "" if not errors else "模型报告未通过结构或策略边界校验"
        row.finished_at = now_utc()
        row.updated_at = row.finished_at
        db.commit()
    except Exception as exc:
        db.rollback()
        row = db.get(LeftSideAIReport, report_id)
        if row:
            row.status = "failed"
            row.validation_status = "failed"
            row.error_message = diagnostic_ai_error_message(exc)
            row.finished_at = now_utc()
            db.commit()
        logger.warning("左侧策略 AI 报告生成失败：%s", exc)
    finally:
        db.close()
        _REPORT_THREADS.pop(report_id, None)


def serialize_report(row: LeftSideAIReport) -> dict[str, Any]:
    return {
        "report_id": row.id,
        "snapshot_id": row.snapshot_id,
        "status": row.status,
        "report_version": row.report_version,
        "prompt_version": row.prompt_version,
        "input_fingerprint": row.input_fingerprint,
        "input_symbols": row.input_symbols or [],
        "model_label": row.model_label or "",
        "report": row.report or {},
        "usage": row.usage or {},
        "validation_status": row.validation_status or "pending",
        "validation_errors": row.validation_errors or [],
        "error_message": row.error_message or "",
        "created_at": row.created_at.isoformat() if row.created_at else "",
        "finished_at": row.finished_at.isoformat() if row.finished_at else "",
    }


def _report_with_current_risks(db, row, candidate_names=None):
    from src.modules.strategy.left_side.rankings import visible_ranking_query

    import copy
    result = copy.deepcopy(serialize_report(row))
    if candidate_names is None:
        candidate_names = dict(db.query(LeftSideRankingItem.symbol, LeftSideRankingItem.name).filter_by(snapshot_id=row.snapshot_id).all())
    for score in result["report"].get("candidate_scores", []):
        if isinstance(score, dict):
            score["name"] = candidate_names.get(str(score.get("symbol"))) or score.get("name") or ""
    _, exclusions = visible_ranking_query(db, row.snapshot_id)
    symbols = set(row.input_symbols or [])
    scores = result["report"].get("candidate_scores") or []
    symbols.update(str(score.get("symbol")) for score in scores if isinstance(score, dict))
    affected = [entry for entry in exclusions if entry["symbol"] in symbols]
    if affected:
        blocked = {entry["symbol"] for entry in affected}
        result["validation_status"] = "stale_risk"
        result["validation_errors"] = [*result["validation_errors"], "候选新增已知风险，旧报告建议已失效，请重新生成：" + "、".join(sorted(blocked))]
        result["report"]["candidate_scores"] = [score for score in scores if not isinstance(score, dict) or str(score.get("symbol")) not in blocked]
        result["report"]["today_buy_list"] = []
        result["report"]["tomorrow_watch"] = []
        result["report"]["risk_exclusions"] = affected
    return result


def list_reports(db, snapshot_id: str) -> list[dict[str, Any]]:
    return [_report_with_current_risks(db, row) for row in db.query(LeftSideAIReport).filter_by(snapshot_id=snapshot_id).order_by(LeftSideAIReport.created_at.desc()).limit(50)]


def get_report(db, report_id: str) -> dict[str, Any] | None:
    row = db.get(LeftSideAIReport, report_id)
    return _report_with_current_risks(db, row) if row else None


def _review_gate(db, snapshot_id: str, symbol: str) -> tuple[LeftSideCandidateReview, LeftSideRankingItem]:
    snapshot, item = _candidate(db, snapshot_id, symbol)
    from src.modules.strategy.left_side.rankings import visible_ranking_query
    _, exclusions = visible_ranking_query(db, snapshot_id)
    if any(entry["symbol"] == symbol for entry in exclusions):
        raise ValueError("该证券存在未解除的已知风险，不能建立计划")
    review = db.query(LeftSideCandidateReview).filter_by(snapshot_id=snapshot_id, symbol=symbol).first()
    if not review:
        raise ValueError("该股票尚未建立人工复核记录")
    pe_errors = pe_confirmation_errors(item, review, snapshot.signal_date)
    if pe_errors:
        raise ValueError("；".join(pe_errors))
    if review.review_status != "approved":
        raise ValueError("人工复核尚未通过")
    if review.security_status != "normal" or review.security_trading_status != "trading":
        raise ValueError("证券风险或交易状态不允许建立计划")
    today = market_today()
    security_valid = _parse_date(review.security_valid_until)
    security_checked = _parse_date(review.security_checked_at)
    if not security_valid or security_valid < today:
        raise ValueError("证券状态核验已过期")
    if not security_checked or security_checked < today - timedelta(days=1) or security_checked > today:
        raise ValueError("证券状态核验超过一个自然日，需要重新核验")
    if not (review.security_source and review.security_evidence):
        raise ValueError("证券状态缺少可追溯来源和证据")
    event_valid = _parse_date(review.event_valid_until)
    event_checked = _parse_date(review.event_checked_at)
    if not event_valid or event_valid < today:
        raise ValueError("重大事件检查已过期")
    if not event_checked or event_checked < today - timedelta(days=90) or event_checked > today or not (review.event_source and review.event_evidence):
        raise ValueError("重大事件证据缺失或超过90天")
    if review.financial_status != "passed" or review.event_status != "clear" or quality_score(review.financial_data or {})[0] is None:
        raise ValueError("财务质量或重大事件核验未完整通过")
    from src.modules.strategy.left_side.rankings import _is_name_excluded
    if _is_name_excluded(item.name):
        raise ValueError("ST/退市名称硬过滤不能被人工复核豁免")
    return review, item


def create_plan(db, payload: dict[str, Any], actor: str | None) -> dict[str, Any]:
    key = str(payload.get("idempotency_key") or "").strip()
    if not key:
        raise ValueError("缺少幂等键")
    old = db.query(LeftSideConditionalPlan).filter_by(idempotency_key=key).first()
    if old:
        return serialize_plan(old)
    snapshot_id, symbol = str(payload["snapshot_id"]), str(payload["symbol"])
    review, item = _review_gate(db, snapshot_id, symbol)
    snapshot = db.get(LeftSideRankingSnapshot, snapshot_id)
    entry_pct = float(payload.get("entry_band_pct", 0.01))
    take_profit = float(payload.get("take_profit_rate", 0.03))
    if not 0 < entry_pct <= 0.03:
        raise ValueError("入场区间偏差只能在0至3%之间")
    if abs(take_profit - 0.03) > 1e-9:
        raise ValueError("基线策略固定使用3%价格止盈")
    budget = _num(payload.get("budget"))
    if budget is not None and budget <= 0:
        raise ValueError("预算必须大于0")
    valid_until = str(payload.get("valid_until") or "")
    expires = _parse_date(valid_until)
    if not expires or expires < market_today():
        raise ValueError("必须设置计划有效期，避免旧计划长期有效")
    quantity = payload.get("quantity")
    if quantity is not None and int(quantity) % 100 != 0:
        raise ValueError("A股计划股数必须是100股的整数倍")
    report_id = payload.get("report_id")
    if report_id:
        report_row = db.get(LeftSideAIReport, str(report_id))
        if not report_row or report_row.snapshot_id != snapshot_id or report_row.status != "succeeded" or report_row.validation_status != "passed":
            raise ValueError("关联的 AI 报告不存在、校验失败或不属于该快照")
    ref = float(item.signal_close)
    plan = LeftSideConditionalPlan(
        id=str(uuid.uuid4()),
        idempotency_key=key,
        snapshot_id=snapshot_id,
        report_id=report_id,
        symbol=symbol,
        name=item.name,
        industry=str((review.financial_data or {}).get("industry_group") or ""),
        status="pending_review",
        entry_low=round(ref * (1 - entry_pct), 4),
        entry_high=round(ref * (1 + entry_pct), 4),
        budget=budget,
        quantity=payload.get("quantity"),
        take_profit_rate=take_profit,
        target_price=round(ref * (1 + take_profit), 4),
        valid_until=valid_until,
        parameters={
            "entry_band_pct": entry_pct,
            "take_profit_rate": take_profit,
            "take_profit_basis": "price_return",
            "price_stop_enabled": False,
            "trailing_stop_enabled": False,
            "signal_exit_enabled": False,
            "time_exit_enabled": False,
            "averaging_down_enabled": False,
            "t_trading_enabled": False,
        },
        reviewer_id=actor or "local-user",
        reviewer_name=actor or "本地用户",
    )
    db.add(plan)
    db.commit()
    db.refresh(plan)
    return serialize_plan(plan)


def approve_plan(db, plan_id: str, payload: dict[str, Any], actor: str | None) -> dict[str, Any]:
    plan = db.get(LeftSideConditionalPlan, plan_id)
    if not plan:
        raise ValueError("條件計畫不存在")
    if plan.status not in {"pending_review", "approved"}:
        raise ValueError("計畫目前狀態不能批准")
    if int(payload.get("expected_version", plan.version)) != plan.version:
        raise ValueError("計畫已被更新，請刷新後再操作")
    _review_gate(db, plan.snapshot_id, plan.symbol)
    snapshot = db.get(LeftSideRankingSnapshot, plan.snapshot_id)
    if not snapshot or snapshot.status != "succeeded" or snapshot.coverage_status != "verified":
        raise ValueError("股票池覆盖未核实或榜单为部分结果，当前不允许批准待买计划")
    valid_until = _parse_date(plan.valid_until)
    if not valid_until or valid_until < market_today():
        raise ValueError("計畫有效期缺失或已過期")
    if (plan.budget is None or plan.budget <= 0) and (plan.quantity is None or plan.quantity <= 0):
        raise ValueError("需先填寫預算或股數")
    plan.status = "approved"
    plan.approval_note = str(payload.get("approval_note") or "")
    plan.reviewer_id = actor or "local-user"
    plan.reviewer_name = actor or "本地用户"
    plan.approved_at = now_utc()
    plan.version += 1
    db.commit()
    db.refresh(plan)
    return serialize_plan(plan)


def cancel_plan(db, plan_id: str, actor: str | None, reason: str = "") -> dict[str, Any]:
    plan = db.get(LeftSideConditionalPlan, plan_id)
    if not plan:
        raise ValueError("條件計畫不存在")
    if plan.status == "filled":
        raise ValueError("已成交模拟计划不能取消")
    plan.status = "cancelled"
    plan.approval_note = str(reason or "")
    plan.reviewer_id = actor or "local-user"
    plan.reviewer_name = actor or "本地用户"
    plan.version += 1
    db.commit()
    db.refresh(plan)
    return serialize_plan(plan)


def serialize_plan(plan: LeftSideConditionalPlan) -> dict[str, Any]:
    return {
        "id": plan.id,
        "snapshot_id": plan.snapshot_id,
        "report_id": plan.report_id or "",
        "symbol": plan.symbol,
        "name": plan.name,
        "industry": plan.industry or "",
        "status": plan.status,
        "entry_low": plan.entry_low,
        "entry_high": plan.entry_high,
        "budget": plan.budget,
        "quantity": plan.quantity,
        "take_profit_rate": plan.take_profit_rate,
        "target_price": plan.target_price,
        "valid_until": plan.valid_until or "",
        "parameters": plan.parameters or {},
        "approval_note": plan.approval_note or "",
        "version": plan.version,
        "created_at": plan.created_at.isoformat() if plan.created_at else "",
        "approved_at": plan.approved_at.isoformat() if plan.approved_at else "",
    }


def list_plans(db, status: str = "") -> list[dict[str, Any]]:
    query = db.query(LeftSideConditionalPlan)
    if status:
        query = query.filter_by(status=status)
    return [serialize_plan(p) for p in query.order_by(LeftSideConditionalPlan.created_at.desc()).limit(200)]


def create_experiment_account(db, payload: dict[str, Any], owner_id: str | None) -> dict[str, Any]:
    starting_cash = _num(payload.get("starting_cash"))
    if starting_cash is None or starting_cash <= 0:
        raise ValueError("模拟账户起始资金必须大于0")
    fee_fields = ("commission_rate", "minimum_commission", "stamp_tax_rate", "transfer_fee_rate")
    fees = {key: _num(payload.get(key)) for key in fee_fields}
    if any(value is None or value < 0 for value in fees.values()):
        raise ValueError("请逐项确认手续费参数；费率必须是非负数")
    account = LeftSideExperimentAccount(
        id=str(uuid.uuid4()),
        owner_id=owner_id or "local-user",
        name=str(payload.get("name") or "左侧策略实验账户")[:80],
        starting_cash=starting_cash,
        cash=starting_cash,
        status="active",
        config={
            **fees,
            "target_positions": 25,
            "target_invested_ratio": 0.90,
            "single_name_cap": 0.05,
            "sector_cap": 0.20,
            "entry_lot_size": 100,
            "fee_source": "user_configured_research_parameters",
        },
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return serialize_account(db, account)


def _fee(config: dict[str, Any], amount: float, *, sell: bool) -> float:
    commission = max(float(config["minimum_commission"]), amount * float(config["commission_rate"]))
    transfer = amount * float(config["transfer_fee_rate"])
    stamp = amount * float(config["stamp_tax_rate"]) if sell else 0.0
    return round(commission + transfer + stamp, 4)


def serialize_account(db, account: LeftSideExperimentAccount) -> dict[str, Any]:
    positions = db.query(LeftSideExperimentPosition).filter_by(account_id=account.id).all()
    open_positions = [p for p in positions if p.status == "open"]
    held_cost = sum(p.entry_price * p.quantity for p in open_positions)
    realized = sum(float(p.realized_pnl or 0) for p in positions if p.status == "closed")
    return {
        "id": account.id,
        "name": account.name,
        "status": account.status,
        "starting_cash": account.starting_cash,
        "cash": round(account.cash, 2),
        "held_cost": round(held_cost, 2),
        "realized_pnl": round(realized, 2),
        "open_positions": len(open_positions),
        "config": account.config or {},
        "created_at": account.created_at.isoformat() if account.created_at else "",
    }


def list_accounts(db, owner_id: str | None) -> list[dict[str, Any]]:
    rows = db.query(LeftSideExperimentAccount).filter_by(owner_id=owner_id or "local-user").order_by(LeftSideExperimentAccount.created_at.desc()).all()
    return [serialize_account(db, row) for row in rows]


def set_account_status(db, account_id: str, owner_id: str | None, status: str) -> dict[str, Any]:
    if status not in {"active", "paused"}:
        raise ValueError("模拟账户状态无效")
    account = db.get(LeftSideExperimentAccount, account_id)
    if not account or account.owner_id != (owner_id or "local-user"):
        raise ValueError("模拟账户不存在")
    account.status = status
    account.updated_at = now_utc()
    db.commit()
    db.refresh(account)
    return serialize_account(db, account)


def _latest_bars(symbol: str) -> list[Any]:
    return KlineCollector(MarketCode.CN).get_klines(symbol, 1001) or []


def run_experiment_day(db, account_id: str, owner_id: str | None, plan_ids: list[str]) -> dict[str, Any]:
    account = db.get(LeftSideExperimentAccount, account_id)
    if not account or account.owner_id != (owner_id or "local-user"):
        raise ValueError("模拟账户不存在")
    if account.status != "active":
        raise ValueError("模拟账户已暂停")
    cfg = account.config or {}
    selected_ids = list(dict.fromkeys(plan_ids or []))
    plans = (
        db.query(LeftSideConditionalPlan)
        .filter(LeftSideConditionalPlan.status == "approved", LeftSideConditionalPlan.id.in_(selected_ids or ["__none__"]))
        .order_by(LeftSideConditionalPlan.created_at.asc())
        .limit(50)
        .all()
    )
    positions = db.query(LeftSideExperimentPosition).filter_by(account_id=account.id, status="open").all()
    symbols = sorted({*(p.symbol for p in plans), *(p.symbol for p in positions)})
    bars_by_symbol: dict[str, list[Any]] = {}
    for symbol in symbols:
        try:
            bars_by_symbol[symbol] = _latest_bars(symbol)
        except Exception as exc:
            logger.warning("模拟账户读取日线失败 %s: %s", symbol, exc)
            bars_by_symbol[symbol] = []
    trades_created = 0
    skipped: list[dict[str, str]] = []
    exited: list[str] = []
    today = market_today()

    # First process existing positions. Price stop, trailing stop, time and signal exits stay disabled.
    for position in positions:
        bars = sorted(bars_by_symbol.get(position.symbol, []), key=lambda bar: str(getattr(bar, "date", "")))
        bars = [bar for bar in bars if str(getattr(bar, "date", "")) > position.opened_at.date().isoformat()]
        for bar in bars:
            high = _num(getattr(bar, "high", None))
            bar_day = str(getattr(bar, "date", ""))[:10]
            if high is None or high < position.take_profit_price:
                continue
            amount = position.take_profit_price * position.quantity
            sell_fee = _fee(cfg, amount, sell=True)
            account.cash += amount - sell_fee
            position.status = "closed"
            position.closed_at = datetime.combine(date.fromisoformat(bar_day), datetime.min.time())
            position.exit_price = position.take_profit_price
            position.exit_fee = sell_fee
            position.realized_pnl = round((amount - sell_fee) - (position.entry_price * position.quantity + position.entry_fee), 2)
            db.add(LeftSideExperimentTrade(
                account_id=account.id,
                position_id=position.id,
                plan_id=position.entry_plan_id,
                snapshot_id="",
                symbol=position.symbol,
                side="sell",
                quantity=position.quantity,
                price=position.take_profit_price,
                gross_amount=amount,
                fees=sell_fee,
                reason="fixed_price_take_profit_3pct",
                idempotency_key=f"{account.id}:{position.id}:{bar_day}:take-profit",
                quote_source=str(getattr(bar, "source", "KlineCollector")),
                quote_time=bar_day,
            ))
            exited.append(position.symbol)
            trades_created += 1
            break

    # Entry uses only the first later daily bar whose open lies inside the configured band.
    for plan in plans:
        if plan.valid_until and _parse_date(plan.valid_until) and _parse_date(plan.valid_until) < today:
            plan.status = "expired"
            continue
        if db.query(LeftSideExperimentPosition).filter_by(account_id=account.id, symbol=plan.symbol, status="open").first():
            skipped.append({"symbol": plan.symbol, "reason": "账户已持有该标的，不自动补仓"})
            continue
        try:
            review, item = _review_gate(db, plan.snapshot_id, plan.symbol)
        except ValueError as exc:
            skipped.append({"symbol": plan.symbol, "reason": str(exc)})
            continue
        try:
            fundamentals = get_market_data().fundamentals([plan.symbol], market="CN")
            latest_pe = _num(getattr(fundamentals[0], "pe_ttm", None)) if fundamentals else None
            latest_pe_source = str(getattr(fundamentals[0], "source", "") or "").lower() if fundamentals else ""
        except Exception:
            latest_pe = None
            latest_pe_source = ""
        from src.modules.strategy.left_side.rankings import PARAMETERS
        if latest_pe is None or not 0 < latest_pe < 30 or latest_pe_source not in PARAMETERS["pe_source_allowlist"]:
            skipped.append({"symbol": plan.symbol, "reason": "入场前最新PE_TTM无法核验或不满足硬条件"})
            continue
        if len([p for p in db.query(LeftSideExperimentPosition).filter_by(account_id=account.id, status="open")]) >= int(cfg["target_positions"]):
            skipped.append({"symbol": plan.symbol, "reason": "已达到持仓名额上限"})
            continue
        industry_value = plan.industry or str((review.financial_data or {}).get("industry_group") or "")
        open_positions = db.query(LeftSideExperimentPosition).filter_by(account_id=account.id, status="open").all()
        invested = sum(p.entry_price * p.quantity for p in open_positions)
        sector_exposure = sum(p.entry_price * p.quantity for p in open_positions if p.industry == industry_value)
        cap = account.starting_cash * float(cfg["single_name_cap"])
        total_cap = account.starting_cash * float(cfg["target_invested_ratio"])
        sector_cap = account.starting_cash * float(cfg["sector_cap"])
        available = min(float(plan.budget or cap), cap, account.cash, total_cap - invested, sector_cap - sector_exposure)
        bars = sorted(bars_by_symbol.get(plan.symbol, []), key=lambda bar: str(getattr(bar, "date", "")))
        signal_date = str(item.signal_date or "")[:10]
        account_start_date = account.created_at.date().isoformat() if account.created_at else today.isoformat()
        eligible_bar = None
        for bar in bars:
            bar_day = str(getattr(bar, "date", ""))[:10]
            if bar_day <= max(signal_date, account_start_date) or (plan.valid_until and bar_day > plan.valid_until):
                continue
            opening = _num(getattr(bar, "open", None))
            if opening is not None and plan.entry_low <= opening <= plan.entry_high:
                eligible_bar = bar
                break
        if not eligible_bar:
            skipped.append({"symbol": plan.symbol, "reason": "尚无有效期内且开盘位于入场区间的后续日线"})
            continue
        opening = float(eligible_bar.open)
        lot = int(cfg.get("entry_lot_size", 100))
        requested_qty = int(plan.quantity or (available / opening))
        quantity = min(requested_qty, int(available / opening))
        quantity = quantity // lot * lot
        if quantity <= 0:
            skipped.append({"symbol": plan.symbol, "reason": "资金或组合上限不足一个买入单位"})
            continue
        gross = opening * quantity
        buy_fee = _fee(cfg, gross, sell=False)
        if gross + buy_fee > account.cash or invested + gross > total_cap or sector_exposure + gross > sector_cap:
            skipped.append({"symbol": plan.symbol, "reason": "含费用后超出现金、总仓位或行业上限"})
            continue
        bar_day = str(eligible_bar.date)[:10]
        position = LeftSideExperimentPosition(
            account_id=account.id,
            symbol=plan.symbol,
            name=plan.name,
            industry=industry_value,
            status="open",
            quantity=quantity,
            entry_price=opening,
            entry_fee=buy_fee,
            take_profit_price=round(opening * (1 + plan.take_profit_rate), 4),
            entry_plan_id=plan.id,
            opened_at=datetime.combine(date.fromisoformat(bar_day), datetime.min.time()),
        )
        db.add(position)
        db.flush()
        account.cash -= gross + buy_fee
        plan.status = "filled"
        db.add(LeftSideExperimentTrade(
            account_id=account.id,
            position_id=position.id,
            plan_id=plan.id,
            snapshot_id=plan.snapshot_id,
            symbol=plan.symbol,
            side="buy",
            quantity=quantity,
            price=opening,
            gross_amount=gross,
            fees=buy_fee,
            reason="next_daily_open_inside_entry_band",
            idempotency_key=f"{account.id}:{plan.id}:{bar_day}:buy",
            quote_source=str(getattr(eligible_bar, "source", "KlineCollector")),
            quote_time=bar_day,
        ))
        trades_created += 1

    account.updated_at = now_utc()
    db.commit()
    db.refresh(account)
    return {
        "account": serialize_account(db, account),
        "trades_created": trades_created,
        "take_profit_exits": exited,
        "skipped": skipped,
        "old_paper_trading_untouched": True,
    }


def account_trades(db, account_id: str, owner_id: str | None) -> dict[str, Any]:
    account = db.get(LeftSideExperimentAccount, account_id)
    if not account or account.owner_id != (owner_id or "local-user"):
        raise ValueError("模拟账户不存在")
    trades = db.query(LeftSideExperimentTrade).filter_by(account_id=account.id).order_by(LeftSideExperimentTrade.created_at.desc()).limit(500).all()
    positions = db.query(LeftSideExperimentPosition).filter_by(account_id=account.id).order_by(LeftSideExperimentPosition.opened_at.desc()).all()
    marks: dict[str, dict[str, Any]] = {}
    for position in (item for item in positions if item.status == "open"):
        try:
            bars = sorted(_latest_bars(position.symbol), key=lambda bar: str(getattr(bar, "date", "")))
            latest = bars[-1] if bars else None
            close = _num(getattr(latest, "close", None)) if latest else None
            marks[position.symbol] = {
                "price": close,
                "date": str(getattr(latest, "date", ""))[:10] if latest else "",
                "source": str(getattr(latest, "source", "KlineCollector")) if latest else "",
            }
        except Exception as exc:
            logger.warning("左侧模拟账户估值读取失败 %s: %s", position.symbol, exc)
            marks[position.symbol] = {"price": None, "date": "", "source": ""}
    marks_complete = all(marks.get(position.symbol, {}).get("price") is not None for position in positions if position.status == "open")
    market_value = sum(float(marks[position.symbol]["price"]) * position.quantity for position in positions if position.status == "open" and marks.get(position.symbol, {}).get("price") is not None)
    total_equity = round(account.cash + market_value, 2) if marks_complete else None
    unrealized = round(sum((float(marks[p.symbol]["price"]) - p.entry_price) * p.quantity - p.entry_fee for p in positions if p.status == "open"), 2) if marks_complete else None
    return {
        "account": serialize_account(db, account),
        "valuation": {
            "market_value": round(market_value, 2) if marks_complete else None,
            "total_equity": total_equity,
            "unrealized_pnl": unrealized,
            "total_pnl": round(total_equity - account.starting_cash, 2) if total_equity is not None else None,
            "valuation_complete": marks_complete,
            "as_of": max((value["date"] for value in marks.values() if value["date"]), default=""),
            "missing_symbols": [symbol for symbol, value in marks.items() if value["price"] is None],
        },
        "positions": [
            {
                "id": p.id,
                "symbol": p.symbol,
                "name": p.name,
                "industry": p.industry or "",
                "status": p.status,
                "quantity": p.quantity,
                "entry_price": p.entry_price,
                "entry_fee": p.entry_fee,
                "take_profit_price": p.take_profit_price,
                "mark_price": marks.get(p.symbol, {}).get("price"),
                "mark_date": marks.get(p.symbol, {}).get("date", ""),
                "market_value": round(float(marks[p.symbol]["price"]) * p.quantity, 2) if marks.get(p.symbol, {}).get("price") is not None else None,
                "unrealized_pnl": round((float(marks[p.symbol]["price"]) - p.entry_price) * p.quantity - p.entry_fee, 2) if marks.get(p.symbol, {}).get("price") is not None else None,
                "holding_days": max(0, (market_today() - p.opened_at.date()).days),
                "opened_at": p.opened_at.isoformat(),
                "realized_pnl": p.realized_pnl,
            }
            for p in positions
        ],
        "trades": [
            {
                "id": t.id,
                "symbol": t.symbol,
                "side": t.side,
                "quantity": t.quantity,
                "price": t.price,
                "gross_amount": t.gross_amount,
                "fees": t.fees,
                "reason": t.reason,
                "quote_source": t.quote_source or "",
                "quote_time": t.quote_time or "",
                "created_at": t.created_at.isoformat() if t.created_at else "",
            }
            for t in trades
        ],
    }


def backtest_readiness(db, snapshot_ids: list[str]) -> dict[str, Any]:
    ids = list(dict.fromkeys(snapshot_ids))
    snapshots = db.query(LeftSideRankingSnapshot).filter(LeftSideRankingSnapshot.id.in_(ids or ["__none__"])).all()
    by_id = {row.id: row for row in snapshots}
    ordered = [by_id[identity] for identity in ids if identity in by_id]
    issues: list[str] = []
    if len(ids) < 30:
        issues.append("至少需要30个不同交易日的点时快照，才能进行最低限度的组合回放")
    if len(ordered) != len(ids):
        issues.append("部分快照不存在")
    if any(row.status != "succeeded" for row in ordered):
        issues.append("回测只接受完整成功的快照")
    if any(row.coverage_status != "verified" for row in ordered):
        issues.append("历史股票池覆盖未经过权威验证，拒绝输出可能有幸存者偏差的回测收益")
    dates = [row.signal_date for row in ordered]
    if any(not d for d in dates) or dates != sorted(dates) or len(set(dates)) != len(dates):
        issues.append("快照日期缺失、重复或未按时间顺序排列")
    if ordered and not any(not d for d in dates) and dates == sorted(dates) and len(set(dates)) == len(dates):
        from src.platform.scheduling.trading_calendar import calendar_known, is_trading_day

        missing_sessions = []
        current = date.fromisoformat(dates[0]) + timedelta(days=1)
        last = date.fromisoformat(dates[-1])
        while current < last:
            if not calendar_known("CN", current):
                issues.append("所选区间超出本地已发布交易日历覆盖，无法确认是否缺少交易日")
                break
            if is_trading_day("CN", current) and current.isoformat() not in set(dates):
                missing_sessions.append(current.isoformat())
            current += timedelta(days=1)
        if missing_sessions:
            issues.append(f"点时快照缺少交易日：{', '.join(missing_sessions[:5])}")
    if any(
        row.coverage_as_of != row.signal_date
        or not row.coverage_checked_by
        or not row.coverage_source
        or not row.coverage_evidence_url
        or not row.coverage_evidence
        or row.coverage_expected_total != row.universe_total
        for row in ordered
    ):
        issues.append("部分覆盖核验没有完整的同日官方证据与操作人记录")
    return {"ready": not issues, "snapshot_count": len(ordered), "dates": dates, "issues": issues}


def verify_snapshot_coverage(db, snapshot_id: str, payload: dict[str, Any], actor: str | None) -> dict[str, Any]:
    """Record an operator's point-in-time check against an official source.

    The application can validate the evidence fields and counts supplied by the
    operator, but does not fetch/attest the remote source itself.
    """
    snapshot = db.get(LeftSideRankingSnapshot, snapshot_id)
    if not snapshot or snapshot.status not in {"partial", "succeeded"} or snapshot.phase != "published":
        raise ValueError("只有已发布的观察榜快照可以核验股票池覆盖")
    if snapshot.coverage_status == "verified":
        raise ValueError("该快照的覆盖证据已核验，不能覆盖原始审计记录；请用新快照重新核验")
    expected_total = payload.get("expected_total")
    as_of = str(payload.get("as_of") or "")[:10]
    source = str(payload.get("source") or "").strip()
    evidence_url = str(payload.get("evidence_url") or "").strip()
    evidence = str(payload.get("evidence") or "").strip()
    if not isinstance(expected_total, int) or expected_total <= 0:
        raise ValueError("官方股票数必须为正整数")
    if not snapshot.signal_date or as_of != snapshot.signal_date:
        raise ValueError("证据日期必须与榜单信号日一致")
    if not source or not evidence or not evidence_url.startswith("https://"):
        raise ValueError("必须填写官方来源、HTTPS证据链接和核验说明")
    if snapshot.universe_stale:
        raise ValueError("股票池缓存已过期，不能核验覆盖")
    catalogs = snapshot.universe_catalogs or {}
    if not all(isinstance(catalogs.get(key), dict) and catalogs[key].get("available") is True for key in ("CN", "BJ")):
        raise ValueError("沪深与北交所证券名录未全部成功读取")
    if expected_total != int(snapshot.universe_total or 0):
        raise ValueError(f"股票池数量不匹配：官方证据 {expected_total}，本次采集 {snapshot.universe_total or 0}")

    snapshot.coverage_expected_total = expected_total
    snapshot.coverage_source = source[:200]
    snapshot.coverage_evidence_url = evidence_url[:2000]
    snapshot.coverage_evidence = evidence[:4000]
    snapshot.coverage_as_of = as_of
    snapshot.coverage_checked_at = datetime.now(timezone.utc).isoformat()
    snapshot.coverage_checked_by = actor or "local-user"
    snapshot.coverage_status = "verified"

    all_fundamentals_checked = int(snapshot.fundamentals_checked or 0) == max(0, int(snapshot.universe_total or 0) - int(snapshot.excluded_st_count or 0))
    all_history_checked = int(snapshot.history_checked or 0) == int(snapshot.pe_passed or 0)
    all_history_passed = int(snapshot.history_passed or 0) == int(snapshot.pe_passed or 0)
    if (
        snapshot.fundamentals_errors == 0
        and snapshot.history_errors == 0
        and all_fundamentals_checked
        and all_history_checked
        and all_history_passed
    ):
        snapshot.status = "succeeded"
        snapshot.message = "股票池覆盖已由操作人按官方证据核验；数据采集完整。证券风险及财务审查仍按候选逐只执行。"
    else:
        snapshot.status = "partial"
        snapshot.message = "股票池覆盖证据已由操作人核验，但部分财务或行情采集仍不完整；不得用于回测或待买计划审批。"
    snapshot.updated_at = now_utc()
    db.commit()
    db.refresh(snapshot)
    from src.modules.strategy.left_side.rankings import serialize_snapshot

    return {
        "snapshot": serialize_snapshot(snapshot),
        "operator_attested": True,
        "automatically_fetched_or_verified": False,
    }


def recover_interrupted_reports() -> None:
    """A thread-local model call cannot continue after restart; preserve that fact."""
    db = SessionLocal()
    try:
        rows = db.query(LeftSideAIReport).filter(LeftSideAIReport.status.in_(("queued", "running"))).all()
        for row in rows:
            row.status = "failed"
            row.validation_status = "failed"
            row.error_message = "应用重启导致本地模型任务中断；可以在同一冻结输入上重试"
            row.finished_at = now_utc()
            row.updated_at = row.finished_at
        if rows:
            db.commit()
    except Exception:
        db.rollback()
        logger.exception("恢复左侧策略 AI 报告任务失败")
    finally:
        db.close()
