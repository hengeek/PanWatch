from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from fastapi import HTTPException

from src.modules.market.api.watch_groups import (
    GroupCreate,
    GroupMembersBatch,
    GroupMembersBatchItem,
    GroupMembersUpdate,
    GroupOrderItem,
    GroupOrderUpdate,
    GroupPatch,
    create_watch_group,
    delete_watch_group,
    list_watch_groups,
    rename_watch_group,
    update_watch_group_members,
    update_watch_group_members_batch,
    update_watch_group_order,
)
from src.platform.persistence.database import Base
from src.platform.persistence.migrations import _m148_watch_groups
from src.platform.persistence.models import Stock, WatchGroup, WatchGroupMember


def make_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return engine, Session(engine)


def test_groups_crud_members_order_and_name_conflict():
    engine, db = make_session()
    try:
        stock_a = Stock(symbol="600001", name="示例甲", market="CN")
        stock_b = Stock(symbol="00700", name="示例乙", market="HK")
        db.add_all([stock_a, stock_b]); db.commit()
        first = create_watch_group(GroupCreate(name="长期观察"), db)
        second = create_watch_group(GroupCreate(name="短线观察"), db)
        try:
            create_watch_group(GroupCreate(name=" 长期观察 "), db)
            assert False, "case-insensitive duplicate group name must fail"
        except HTTPException as exc:
            assert exc.status_code == 409

        update_watch_group_members(first["id"], GroupMembersUpdate(stock_ids=[stock_a.id, stock_b.id], version=1), db)
        update_watch_group_members(second["id"], GroupMembersUpdate(stock_ids=[stock_a.id], version=1), db)
        update_watch_group_order(GroupOrderUpdate(items=[
            GroupOrderItem(group_id=second["id"], sort_order=0, version=2),
            GroupOrderItem(group_id=first["id"], sort_order=1, version=2),
        ]), db)
        ordered = list_watch_groups(db)["items"]
        assert [group["id"] for group in ordered] == [second["id"], first["id"]]
        assert [member["stock_id"] for member in ordered[1]["members"]] == [stock_a.id, stock_b.id]

        renamed = rename_watch_group(first["id"], GroupPatch(name="核心观察", version=3), db)
        assert renamed["name"] == "核心观察"
        delete_watch_group(first["id"], version=4, db=db)
        assert db.query(Stock).count() == 2
        assert db.query(WatchGroupMember).filter_by(group_id=first["id"]).count() == 0
    finally:
        db.close(); engine.dispose()


def test_batch_membership_rejects_stale_version_without_partial_update():
    engine, db = make_session()
    try:
        stock = Stock(symbol="600002", name="示例股", market="CN")
        db.add(stock); db.commit()
        first = create_watch_group(GroupCreate(name="甲组"), db)
        second = create_watch_group(GroupCreate(name="乙组"), db)
        update_watch_group_members(first["id"], GroupMembersUpdate(stock_ids=[stock.id], version=1), db)
        try:
            update_watch_group_members_batch(GroupMembersBatch(groups=[
                GroupMembersBatchItem(group_id=first["id"], stock_ids=[], version=1),
                GroupMembersBatchItem(group_id=second["id"], stock_ids=[stock.id], version=1),
            ]), db)
            assert False, "stale optimistic version must fail"
        except HTTPException as exc:
            assert exc.status_code == 409
        db.expire_all()
        current_second = db.query(WatchGroup).filter_by(id=second["id"]).one()
        assert current_second.version == 1
        assert db.query(WatchGroupMember).filter_by(group_id=second["id"]).count() == 0
    finally:
        db.close(); engine.dispose()


def test_watch_group_migration_is_idempotent_and_enforces_casefold_name_index():
    engine, db = make_session()
    try:
        with engine.begin() as conn:
            _m148_watch_groups(conn)
            _m148_watch_groups(conn)
        inspector = inspect(engine)
        assert "watch_groups" in inspector.get_table_names()
        assert "watch_group_members" in inspector.get_table_names()
        with engine.connect() as conn:
            name_index = conn.execute(text(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='ux_watch_groups_name_ci'"
            )).scalar_one_or_none()
        assert name_index == "ux_watch_groups_name_ci"
        db.add_all([WatchGroup(name="Group A"), WatchGroup(name="group a")])
        try:
            db.commit()
            assert False, "case insensitive name index must reject duplicates"
        except IntegrityError:
            db.rollback()
    finally:
        db.close(); engine.dispose()
