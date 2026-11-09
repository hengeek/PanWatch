"""Build and persist independent left-side observation rankings.

These records are deliberately separate from StrategySignalRun and are never
consumed by the existing paper-trading entry scanner.
"""

from __future__ import annotations

import logging
import math
import re
import threading
import unicodedata
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.exc import IntegrityError

from src.platform.marketdata.collectors.kline_collector import KlineCollector
from src.platform.marketdata.instruments import infer_asset_type
from src.platform.marketdata.marketdata_client import get_market_data
from src.platform.marketdata.models import MarketCode
from src.platform.marketdata.stock_list import get_stock_list, get_stock_list_metadata
from src.platform.persistence.database import SessionLocal
from src.platform.persistence.models import LeftSideRankingItem, LeftSideRankingSnapshot
from src.platform.scheduling import trading_calendar

logger = logging.getLogger(__name__)

PARAMETERS = {
    "version": "left-side-observation-v1",
    "market": "CN",
    "pe_field": "pe_ttm",
    "pe_source_allowlist": ["tencent"],
    "pe_source_field_map": "Tencent qt.gtimg fundamentals index 39; verify against live quote before production use",
    "pe_min_exclusive": 0,
    "pe_max_exclusive": 30,
    "low_weights": {"pe": 0.20, "low_60": 0.40, "low_250": 0.40},
    "history_windows": [60, 250, 1000],
    "drawdown_windows": [10, 30, 90],
    "history_workers": 4,
    "fundamentals_batch_size": 100,
    "universe_freshness": "cache age is recorded; catalog completeness remains unverified",
    "risk_status": "pending_authoritative_verification",
    "admission_status": "observation_only",
}

BOARDS = {
    "low_composite": ("low_composite", "desc"),
    "low_60": ("low_60", "desc"),
    "low_250": ("low_250", "desc"),
    "low_1000": ("low_1000", "desc"),
    "drawdown_10": ("drawdown_10", "desc"),
    "drawdown_30": ("drawdown_30", "desc"),
    "drawdown_90": ("drawdown_90", "desc"),
}

_CN_STOCK_CODE = re.compile(r"^(?:60|68|00|30|4|8|92)\d{4}$")
_REFRESH_LOCK = threading.Lock()
_WORKER: threading.Thread | None = None
_CANCEL_EVENTS: dict[str, threading.Event] = {}
_SNAPSHOT_LEASE_MINUTES = 20


def _now_utc_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _is_name_excluded(name: str) -> bool:
    normalized = re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(name or ""))).upper()
    return normalized.startswith(("ST", "*ST", "SST", "S*ST")) or "退市" in normalized


def _is_cn_stock(item: dict[str, Any]) -> bool:
    symbol = str(item.get("symbol") or "").strip()
    return (
        str(item.get("market") or "").upper() == "CN"
        and infer_asset_type(str(item.get("name") or ""), item.get("asset_type")) == "stock"
        and bool(_CN_STOCK_CODE.fullmatch(symbol))
    )


def _numeric(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _timestamp_text(value: Any) -> str:
    if value is None:
        return ""
    formatter = getattr(value, "isoformat", None)
    return formatter() if callable(formatter) else str(value)


def calculate_observation_metrics(
    bars: list[Any],
    pe_ttm: float,
    *,
    discard_signal_date: str = "",
    expected_signal_date: str = "",
) -> dict[str, Any] | None:
    """Calculate the documented 20/40/40 and drawdown metrics from valid bars."""
    by_date: dict[str, Any] = {}
    for bar in bars or []:
        close = _numeric(getattr(bar, "close", None))
        volume = _numeric(getattr(bar, "volume", None))
        day = str(getattr(bar, "date", "") or "")
        if day and close is not None and close > 0 and volume is not None and volume > 0:
            by_date[day] = bar
    series = [by_date[day] for day in sorted(by_date)]
    if discard_signal_date and series and str(series[-1].date) == discard_signal_date:
        series = series[:-1]
    if expected_signal_date and (not series or str(series[-1].date) != expected_signal_date):
        return None
    if not series:
        return None

    closes = [_numeric(getattr(bar, "close", None)) for bar in series]
    if not closes or any(close is None for close in closes):
        return None
    current = float(closes[-1])
    low_scores: dict[int, float | None] = {}
    for window in (60, 250, 1000):
        if len(closes) >= window + 1:
            previous = closes[-window - 1:-1]
            low_scores[window] = 100.0 * sum(float(value) > current for value in previous) / window
        else:
            low_scores[window] = None

    drawdowns: dict[int, float | None] = {}
    for window in (10, 30, 90):
        if len(closes) >= window:
            sample = [float(value) for value in closes[-window:]]
            peak = max(sample)
            drawdowns[window] = 100.0 * (1.0 - current / peak) if peak > 0 else None
        else:
            drawdowns[window] = None

    value_score = 100.0 * (30.0 - pe_ttm) / 30.0
    low_60, low_250 = low_scores[60], low_scores[250]
    composite = 0.20 * value_score + 0.40 * low_60 + 0.40 * low_250 if low_60 is not None and low_250 is not None else None
    return {
        "signal_date": str(series[-1].date),
        "signal_close": current,
        "signal_open": _numeric(getattr(series[-1], "open", None)),
        "signal_high": _numeric(getattr(series[-1], "high", None)),
        "signal_low": _numeric(getattr(series[-1], "low", None)),
        "pe_ttm": pe_ttm,
        "low_60": low_60,
        "low_250": low_250,
        "low_1000": low_scores[1000],
        "low_composite": composite,
        "drawdown_10": drawdowns[10],
        "drawdown_30": drawdowns[30],
        "drawdown_90": drawdowns[90],
        "sample_start": str(series[0].date),
        "sample_end": str(series[-1].date),
    }


def get_latest_snapshot(db) -> LeftSideRankingSnapshot | None:
    return db.query(LeftSideRankingSnapshot).order_by(LeftSideRankingSnapshot.created_at.desc()).first()


def get_latest_completed_snapshot(db) -> LeftSideRankingSnapshot | None:
    return (
        db.query(LeftSideRankingSnapshot)
        .filter(LeftSideRankingSnapshot.status.in_(("succeeded", "partial")))
        .order_by(LeftSideRankingSnapshot.created_at.desc())
        .first()
    )


def _update_snapshot(snapshot_id: str, **changes: Any) -> None:
    db = SessionLocal()
    try:
        snapshot = db.get(LeftSideRankingSnapshot, snapshot_id)
        if not snapshot:
            return
        for key, value in changes.items():
            setattr(snapshot, key, value)
        if snapshot.status in {"queued", "running"}:
            snapshot.lease_expires_at = _now_utc_naive() + timedelta(minutes=_SNAPSHOT_LEASE_MINUTES)
        elif changes.get("status") in {"succeeded", "partial", "failed", "cancelled"}:
            snapshot.lease_expires_at = None
        snapshot.updated_at = _now_utc_naive()
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _collect_snapshot(snapshot_id: str, cancel_event: threading.Event | None = None) -> None:
    try:
        if cancel_event and cancel_event.is_set():
            raise InterruptedError("榜单计算已取消")
        _update_snapshot(snapshot_id, status="running", phase="universe", message="读取 A 股股票池")
        universe = [item for item in get_stock_list() if _is_cn_stock(item)]
        catalog = get_stock_list_metadata()
        catalog_age = catalog.get("age_seconds")
        catalog_stale = not bool(catalog.get("fresh"))
        catalog_observed = (
            datetime.fromtimestamp(catalog["generated_at"], timezone.utc)
            .replace(tzinfo=None)
            .isoformat()
            if catalog.get("generated_at") else ""
        )
        if not universe:
            raise RuntimeError("股票池为空，无法计算观察榜")
        excluded_names = [item for item in universe if _is_name_excluded(str(item.get("name") or ""))]
        candidates = [item for item in universe if not _is_name_excluded(str(item.get("name") or ""))]
        _update_snapshot(
            snapshot_id,
            universe_total=len(universe),
            excluded_st_count=len(excluded_names),
            universe_observed_at=catalog_observed,
            universe_source=str(catalog.get("source") or "unknown"),
            universe_age_seconds=catalog_age,
            universe_stale=catalog_stale,
            universe_catalogs=catalog.get("catalogs") or {},
            coverage_status="unverified",
            phase="fundamentals",
            message="核对最新 TTM 市盈率",
        )

        fundamentals_by_symbol: dict[str, Any] = {}
        fundamentals_errors = 0
        batch_size = int(PARAMETERS["fundamentals_batch_size"])
        provider = get_market_data()
        batches = [candidates[start:start + batch_size] for start in range(0, len(candidates), batch_size)]
        for index, batch in enumerate(batches, start=1):
            if cancel_event and cancel_event.is_set():
                raise InterruptedError("榜单计算已取消")
            try:
                rows = provider.fundamentals([str(item["symbol"]) for item in batch], market="CN")
                for row in rows:
                    symbol = str(getattr(row, "symbol", "") or "")
                    if symbol:
                        fundamentals_by_symbol[symbol] = row
            except Exception as exc:
                fundamentals_errors += len(batch)
                logger.warning("左侧榜基本面批次失败 (%s/%s): %s", index, len(batches), exc)
            if index % 5 == 0 or index == len(batches):
                _update_snapshot(
                    snapshot_id,
                    fundamentals_checked=min(index * batch_size, len(candidates)),
                    fundamentals_errors=fundamentals_errors,
                    phase="fundamentals",
                    message=f"基本面批次 {index}/{len(batches)}",
                )

        eligible: list[dict[str, Any]] = []
        for item in candidates:
            fundamental = fundamentals_by_symbol.get(str(item.get("symbol") or ""))
            pe_ttm = _numeric(getattr(fundamental, "pe_ttm", None)) if fundamental else None
            pe_source = str(getattr(fundamental, "source", "") or "").lower() if fundamental else ""
            if pe_ttm is not None and 0 < pe_ttm < 30 and pe_source in PARAMETERS["pe_source_allowlist"]:
                eligible.append({**item, "pe_ttm": pe_ttm, "pe_source": pe_source})
        _update_snapshot(
            snapshot_id,
            fundamentals_checked=len(candidates),
            fundamentals_errors=fundamentals_errors,
            pe_passed=len(eligible),
            phase="history",
            message="获取复权日线并计算七榜",
        )

        from zoneinfo import ZoneInfo
        from src.platform.scheduling.trading_calendar import is_trading_day, market_status

        now_local = datetime.now(ZoneInfo("Asia/Shanghai"))
        today = now_local.date().isoformat()
        session_state = market_status(MarketCode.CN, now_local)
        expected_signal_date = today if session_state == "after_hours" and is_trading_day("CN", now_local.date()) else ""
        if not expected_signal_date:
            for day_offset in range(1, 16):
                candidate_day = now_local.date() - timedelta(days=day_offset)
                if is_trading_day("CN", candidate_day):
                    expected_signal_date = candidate_day.isoformat()
                    break
        if not expected_signal_date:
            raise RuntimeError("交易日历无法确认最近一个完整交易日，暂不发布观察榜")
        discard_today = today if expected_signal_date != today else ""
        collector = KlineCollector(MarketCode.CN)
        results: list[dict[str, Any]] = []
        history_errors = 0
        with ThreadPoolExecutor(max_workers=int(PARAMETERS["history_workers"])) as pool:
            futures = {
                pool.submit(collector.get_klines, str(item["symbol"]), 1001): item
                for item in eligible
            }
            for index, future in enumerate(as_completed(futures), start=1):
                if cancel_event and cancel_event.is_set():
                    for pending in futures:
                        pending.cancel()
                    raise InterruptedError("榜单计算已取消")
                stock = futures[future]
                try:
                    metrics = calculate_observation_metrics(
                        future.result(),
                        float(stock["pe_ttm"]),
                        discard_signal_date=discard_today,
                        expected_signal_date=expected_signal_date,
                    )
                    if metrics:
                        results.append({
                            **metrics,
                            "symbol": str(stock["symbol"]),
                            "name": str(stock.get("name") or ""),
                            "risk_status": "pending",
                            "admission_status": "observation_only",
                            "pe_observed_at": _timestamp_text(
                                getattr(fundamentals_by_symbol.get(str(stock["symbol"])), "timestamp", None)
                            ),
                            "pe_source": str(getattr(fundamentals_by_symbol.get(str(stock["symbol"])), "source", "") or ""),
                            "data_source": "PanWatch marketdata fundamentals and adjusted daily bars",
                        })
                except Exception as exc:
                    history_errors += 1
                    logger.debug("左侧榜日线失败 %s: %s", stock.get("symbol"), exc)
                if index % 100 == 0 or index == len(eligible):
                    _update_snapshot(
                        snapshot_id,
                        history_checked=index,
                        history_passed=len(results),
                        history_errors=history_errors,
                        phase="history",
                        message=f"日线处理 {index}/{len(eligible)}",
                    )

        if not results:
            raise RuntimeError("未取得可计算的复权日线，未发布空白榜单")

        signal_dates = sorted({item["signal_date"] for item in results})
        signal_date = signal_dates[-1] if signal_dates else ""
        db = SessionLocal()
        try:
            snapshot = db.get(LeftSideRankingSnapshot, snapshot_id)
            if not snapshot:
                raise RuntimeError("观察榜任务记录已丢失")
            if cancel_event and cancel_event.is_set() or snapshot.status == "cancelled":
                raise InterruptedError("榜单计算已取消")
            db.add_all([
                LeftSideRankingItem(snapshot_id=snapshot_id, **item)
                for item in results
            ])
            snapshot.signal_date = signal_date
            snapshot.history_checked = len(eligible)
            snapshot.history_passed = len(results)
            snapshot.history_errors = history_errors
            snapshot.risk_pending_count = len(results)
            partial = (
                catalog_stale
                or not catalog.get("cn_catalogs_available")
                or not catalog.get("catalog_coverage_verified")
                or fundamentals_errors > 0
                or history_errors > 0
                or len(results) < len(eligible)
            )
            snapshot.status = "partial" if partial else "succeeded"
            snapshot.phase = "published"
            snapshot.coverage_status = "unverified"
            snapshot.message = "观察榜已发布；股票池覆盖、证券风险状态和完整财务质量仍待核验"
            snapshot.lease_expires_at = None
            snapshot.finished_at = _now_utc_naive()
            snapshot.updated_at = snapshot.finished_at
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()
    except Exception as exc:
        logger.exception("左侧策略观察榜计算失败: %s", exc)
        try:
            if isinstance(exc, InterruptedError):
                _update_snapshot(
                    snapshot_id,
                    status="cancelled",
                    phase="cancelled",
                    message="榜单计算已取消",
                    error_message="用户取消任务",
                    finished_at=_now_utc_naive(),
                )
                return
            _update_snapshot(
                snapshot_id,
                status="failed",
                phase="failed",
                message="观察榜计算失败",
                error_message=str(exc)[:1000],
                finished_at=_now_utc_naive(),
            )
        except Exception:
            logger.exception("无法保存左侧观察榜失败状态")
    finally:
        _CANCEL_EVENTS.pop(snapshot_id, None)


def start_snapshot() -> dict[str, Any]:
    global _WORKER
    with _REFRESH_LOCK:
        db = SessionLocal()
        try:
            current = get_latest_snapshot(db)
            if current and current.status in {"queued", "running"}:
                if current.lease_expires_at and current.lease_expires_at > _now_utc_naive():
                    return {"snapshot_id": current.id, "status": current.status, "reused": True}
                current.status = "failed"
                current.phase = "failed"
                current.message = "上次任务中断或超时，允许重新发起"
                current.error_message = current.error_message or "任务没有活动中的本地工作线程，或超过20分钟未更新进度"
                current.finished_at = _now_utc_naive()
                db.commit()

            snapshot_id = str(uuid.uuid4())
            snapshot = LeftSideRankingSnapshot(
                id=snapshot_id,
                status="queued",
                phase="queued",
                message="等待后台计算",
                parameters=dict(PARAMETERS),
                created_at=_now_utc_naive(),
                updated_at=_now_utc_naive(),
                lease_expires_at=_now_utc_naive() + timedelta(minutes=_SNAPSHOT_LEASE_MINUTES),
            )
            db.add(snapshot)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                active = db.query(LeftSideRankingSnapshot).filter(
                    LeftSideRankingSnapshot.status.in_(("queued", "running"))
                ).order_by(LeftSideRankingSnapshot.created_at.desc()).first()
                if active:
                    return {"snapshot_id": active.id, "status": active.status, "reused": True}
                raise
        finally:
            db.close()

        _WORKER = threading.Thread(
            target=_collect_snapshot,
            args=(snapshot_id, _CANCEL_EVENTS.setdefault(snapshot_id, threading.Event())),
            daemon=True,
            name="left-side-ranking-snapshot",
        )
        _WORKER.start()
        return {"snapshot_id": snapshot_id, "status": "queued", "reused": False}


def cancel_snapshot(snapshot_id: str) -> dict[str, Any]:
    db = SessionLocal()
    try:
        snapshot = db.get(LeftSideRankingSnapshot, snapshot_id)
        if not snapshot:
            raise ValueError("榜单任务不存在")
        if snapshot.status not in {"queued", "running"}:
            return {"snapshot_id": snapshot_id, "status": snapshot.status, "cancelled": False}
        cancel_event = _CANCEL_EVENTS.get(snapshot_id)
        if not cancel_event:
            raise ValueError("当前进程无法控制该任务，请等待租约结束或重试")
        cancel_event.set()
        snapshot.message = "已请求停止；正在等待当前行情请求结束"
        snapshot.updated_at = _now_utc_naive()
        db.commit()
        return {"snapshot_id": snapshot_id, "status": snapshot.status, "cancelled": True, "cancellation_requested": True}
    finally:
        db.close()


def recover_interrupted_snapshots() -> None:
    """Mark persisted local-thread work as interrupted after an application restart."""
    db = SessionLocal()
    try:
        active = db.query(LeftSideRankingSnapshot).filter(
            LeftSideRankingSnapshot.status.in_(("queued", "running"))
        ).all()
        if not active:
            return
        now = _now_utc_naive()
        for snapshot in active:
            snapshot.status = "failed"
            snapshot.phase = "failed"
            snapshot.message = "应用重启后发现本地任务未完成，已结束并可重新刷新"
            snapshot.error_message = "本地后台任务不能跨进程恢复；重启时已将旧租约对应任务标记中断"
            snapshot.finished_at = now
            snapshot.updated_at = now
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("恢复左侧策略中断任务失败")
    finally:
        db.close()


def serialize_snapshot(snapshot: LeftSideRankingSnapshot | None) -> dict[str, Any] | None:
    if snapshot is None:
        return None
    return {
        "snapshot_id": snapshot.id,
        "status": snapshot.status,
        "phase": snapshot.phase,
        "message": snapshot.message or "",
        "signal_date": snapshot.signal_date or "",
        "universe_total": snapshot.universe_total or 0,
        "excluded_st_count": snapshot.excluded_st_count or 0,
        "fundamentals_checked": snapshot.fundamentals_checked or 0,
        "fundamentals_errors": snapshot.fundamentals_errors or 0,
        "pe_passed": snapshot.pe_passed or 0,
        "history_checked": snapshot.history_checked or 0,
        "history_passed": snapshot.history_passed or 0,
        "history_errors": snapshot.history_errors or 0,
        "risk_pending_count": snapshot.risk_pending_count or 0,
        "universe_observed_at": snapshot.universe_observed_at or "",
        "universe_source": snapshot.universe_source or "",
        "universe_age_seconds": snapshot.universe_age_seconds,
        "universe_stale": bool(snapshot.universe_stale),
        "universe_catalogs": snapshot.universe_catalogs or {},
        "coverage_status": snapshot.coverage_status or "unverified",
        "coverage_expected_total": snapshot.coverage_expected_total,
        "coverage_source": snapshot.coverage_source or "",
        "coverage_evidence_url": snapshot.coverage_evidence_url or "",
        "coverage_evidence": snapshot.coverage_evidence or "",
        "coverage_as_of": snapshot.coverage_as_of or "",
        "coverage_checked_at": snapshot.coverage_checked_at or "",
        "coverage_checked_by": snapshot.coverage_checked_by or "",
        "lease_expires_at": snapshot.lease_expires_at.isoformat() if snapshot.lease_expires_at else "",
        "error_message": snapshot.error_message or "",
        "parameters": snapshot.parameters or PARAMETERS,
        "created_at": snapshot.created_at.isoformat() if snapshot.created_at else "",
        "updated_at": snapshot.updated_at.isoformat() if snapshot.updated_at else "",
        "finished_at": snapshot.finished_at.isoformat() if snapshot.finished_at else "",
    }
