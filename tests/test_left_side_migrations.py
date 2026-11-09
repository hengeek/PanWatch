"""Regression coverage for databases created before the latest left-side fields."""

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session

from src.modules.strategy.left_side import rankings
from src.platform.persistence.database import Base
from src.platform.persistence.migrations import _m147_left_side_snapshot_counters_and_pe_observation
from src.platform.persistence.models import LeftSideRankingItem, LeftSideRankingSnapshot


def test_m147_repairs_existing_left_side_tables_and_preserves_rows():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    try:
        with Session(engine) as db:
            db.add_all([
                LeftSideRankingSnapshot(
                    id="legacy-snapshot",
                    status="partial",
                    phase="published",
                    message="preserve this snapshot",
                    signal_date="2026-11-09",
                ),
                LeftSideRankingItem(
                    snapshot_id="legacy-snapshot",
                    symbol="600000",
                    name="legacy candidate",
                    signal_close=10,
                    pe_ttm=12,
                    pe_source="fixture",
                ),
            ])
            db.commit()

        # Recreate the real pre-v147 schema: populated tables without these fields.
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE left_side_ranking_snapshots DROP COLUMN fundamentals_errors"))
            conn.execute(text("ALTER TABLE left_side_ranking_snapshots DROP COLUMN history_errors"))
            conn.execute(text("ALTER TABLE left_side_ranking_items DROP COLUMN pe_observed_at"))
            _m147_left_side_snapshot_counters_and_pe_observation(conn)
            _m147_left_side_snapshot_counters_and_pe_observation(conn)

        inspector = inspect(engine)
        assert {"fundamentals_errors", "history_errors"} <= {
            column["name"] for column in inspector.get_columns("left_side_ranking_snapshots")
        }
        assert "pe_observed_at" in {
            column["name"] for column in inspector.get_columns("left_side_ranking_items")
        }

        with Session(engine) as db:
            snapshot = db.query(LeftSideRankingSnapshot).filter_by(id="legacy-snapshot").one()
            item = db.query(LeftSideRankingItem).filter_by(snapshot_id="legacy-snapshot").one()
            serialized = rankings.serialize_snapshot(snapshot)
            assert snapshot.message == "preserve this snapshot"
            assert snapshot.fundamentals_errors == 0
            assert snapshot.history_errors == 0
            assert item.symbol == "600000"
            assert item.pe_observed_at == ""
            assert serialized["snapshot_id"] == "legacy-snapshot"
    finally:
        engine.dispose()
