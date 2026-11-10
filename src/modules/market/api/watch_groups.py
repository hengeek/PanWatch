"""Shared watch groups for the web and desktop clients."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from src.platform.persistence.database import get_db
from src.platform.persistence.models import Stock, WatchGroup, WatchGroupMember
from src.web.errors import api_error

router = APIRouter()


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class GroupPatch(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    version: int = Field(ge=1)


class GroupOrderItem(BaseModel):
    group_id: int
    sort_order: int = Field(ge=0, le=10000)
    version: int = Field(ge=1)


class GroupOrderUpdate(BaseModel):
    items: list[GroupOrderItem] = Field(max_length=50)


class GroupMembersUpdate(BaseModel):
    stock_ids: list[int] = Field(max_length=500)
    version: int = Field(ge=1)


class GroupMembersBatchItem(BaseModel):
    group_id: int
    stock_ids: list[int] = Field(max_length=500)
    version: int = Field(ge=1)


class GroupMembersBatch(BaseModel):
    groups: list[GroupMembersBatchItem] = Field(max_length=50)


def _group_payload(group: WatchGroup) -> dict:
    return {
        "id": group.id,
        "name": group.name,
        "sort_order": group.sort_order,
        "version": group.version,
        "members": [
            {
                "stock_id": member.stock_id,
                "sort_order": member.sort_order,
                "symbol": member.stock.symbol,
                "name": member.stock.name,
                "market": member.stock.market,
            }
            for member in group.members
        ],
    }


def _clean_name(name: str) -> str:
    clean = " ".join(name.split())
    if not clean:
        raise api_error(400, "watch_group_name_required", "分组名称不能为空")
    return clean


def _check_name_available(db: Session, name: str, exclude_id: int | None = None) -> None:
    rows = db.query(WatchGroup.id, WatchGroup.name).all()
    normalized = name.casefold()
    if any(group_id != exclude_id and existing.casefold() == normalized for group_id, existing in rows):
        raise api_error(409, "watch_group_name_conflict", "已经有同名分组")


def _require_group(db: Session, group_id: int) -> WatchGroup:
    group = (
        db.query(WatchGroup)
        .options(selectinload(WatchGroup.members).selectinload(WatchGroupMember.stock))
        .filter(WatchGroup.id == group_id)
        .first()
    )
    if group is None:
        raise api_error(404, "watch_group_not_found", "关注分组不存在")
    return group


def _validate_members(db: Session, stock_ids: list[int]) -> None:
    if len(stock_ids) != len(set(stock_ids)):
        raise api_error(400, "watch_group_duplicate_member", "分组中不能重复添加同一只股票")
    if not stock_ids:
        return
    found = {
        stock_id for (stock_id,) in db.query(Stock.id).filter(Stock.id.in_(stock_ids)).all()
    }
    if found != set(stock_ids):
        raise api_error(404, "watch_group_stock_not_found", "分组中包含不存在的股票")


def _claim_version(db: Session, group_id: int, version: int) -> None:
    result = db.execute(
        update(WatchGroup)
        .where(WatchGroup.id == group_id, WatchGroup.version == version)
        .values(version=WatchGroup.version + 1, updated_at=func.now())
    )
    if result.rowcount != 1:
        db.rollback()
        exists = db.query(WatchGroup.id).filter(WatchGroup.id == group_id).first()
        if not exists:
            raise api_error(404, "watch_group_not_found", "关注分组不存在")
        raise api_error(409, "watch_group_version_conflict", "分组已在另一端更新，请刷新后重试")


@router.get("")
def list_watch_groups(db: Session = Depends(get_db)):
    groups = (
        db.query(WatchGroup)
        .options(selectinload(WatchGroup.members).selectinload(WatchGroupMember.stock))
        .order_by(WatchGroup.sort_order, WatchGroup.id)
        .all()
    )
    return {"items": [_group_payload(group) for group in groups]}


@router.post("")
def create_watch_group(data: GroupCreate, db: Session = Depends(get_db)):
    name = _clean_name(data.name)
    _check_name_available(db, name)
    order = (db.query(func.max(WatchGroup.sort_order)).scalar() or 0) + 1
    group = WatchGroup(name=name, sort_order=order, version=1)
    db.add(group)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise api_error(409, "watch_group_name_conflict", "已经有同名分组") from exc
    return _group_payload(_require_group(db, group.id))


@router.patch("/{group_id}")
def rename_watch_group(group_id: int, data: GroupPatch, db: Session = Depends(get_db)):
    name = _clean_name(data.name)
    _check_name_available(db, name, exclude_id=group_id)
    _claim_version(db, group_id, data.version)
    try:
        db.execute(update(WatchGroup).where(WatchGroup.id == group_id).values(name=name))
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise api_error(409, "watch_group_name_conflict", "已经有同名分组") from exc
    return _group_payload(_require_group(db, group_id))


@router.delete("/{group_id}")
def delete_watch_group(group_id: int, version: int, db: Session = Depends(get_db)):
    _claim_version(db, group_id, version)
    db.query(WatchGroupMember).filter(WatchGroupMember.group_id == group_id).delete(synchronize_session=False)
    db.query(WatchGroup).filter(WatchGroup.id == group_id).delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "id": group_id}


@router.put("/order")
def update_watch_group_order(data: GroupOrderUpdate, db: Session = Depends(get_db)):
    ids = [item.group_id for item in data.items]
    if len(ids) != len(set(ids)) or len({item.sort_order for item in data.items}) != len(data.items):
        raise api_error(400, "watch_group_order_invalid", "分组顺序包含重复项目")
    existing = {
        group.id: group.version for group in db.query(WatchGroup.id, WatchGroup.version).filter(WatchGroup.id.in_(ids)).all()
    } if ids else {}
    if len(existing) != len(ids):
        raise api_error(404, "watch_group_not_found", "关注分组不存在")
    try:
        for item in sorted(data.items, key=lambda value: value.group_id):
            _claim_version(db, item.group_id, item.version)
        for item in data.items:
            db.execute(
                update(WatchGroup).where(WatchGroup.id == item.group_id)
                .values(sort_order=item.sort_order, updated_at=func.now())
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    groups = db.query(WatchGroup).options(selectinload(WatchGroup.members).selectinload(WatchGroupMember.stock)).order_by(WatchGroup.sort_order, WatchGroup.id).all()
    return {"items": [_group_payload(group) for group in groups]}


@router.put("/{group_id}/members")
def update_watch_group_members(group_id: int, data: GroupMembersUpdate, db: Session = Depends(get_db)):
    _validate_members(db, data.stock_ids)
    _claim_version(db, group_id, data.version)
    db.query(WatchGroupMember).filter(WatchGroupMember.group_id == group_id).delete(synchronize_session=False)
    db.add_all(
        WatchGroupMember(group_id=group_id, stock_id=stock_id, sort_order=index)
        for index, stock_id in enumerate(data.stock_ids)
    )
    db.commit()
    return _group_payload(_require_group(db, group_id))


@router.put("/members")
def update_watch_group_members_batch(data: GroupMembersBatch, db: Session = Depends(get_db)):
    ids = [item.group_id for item in data.groups]
    if len(ids) != len(set(ids)):
        raise api_error(400, "watch_group_duplicate_update", "同一分组不能重复提交")
    for item in data.groups:
        _validate_members(db, item.stock_ids)
    existing = {
        group.id for group in db.query(WatchGroup.id).filter(WatchGroup.id.in_(ids)).all()
    } if ids else set()
    if existing != set(ids):
        raise api_error(404, "watch_group_not_found", "关注分组不存在")
    try:
        for item in sorted(data.groups, key=lambda value: value.group_id):
            _claim_version(db, item.group_id, item.version)
        for item in data.groups:
            db.query(WatchGroupMember).filter(WatchGroupMember.group_id == item.group_id).delete(synchronize_session=False)
            db.add_all(
                WatchGroupMember(group_id=item.group_id, stock_id=stock_id, sort_order=index)
                for index, stock_id in enumerate(item.stock_ids)
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    groups = (
        db.query(WatchGroup)
        .options(selectinload(WatchGroup.members).selectinload(WatchGroupMember.stock))
        .filter(WatchGroup.id.in_(ids))
        .order_by(WatchGroup.sort_order, WatchGroup.id)
        .all()
    ) if ids else []
    return {"items": [_group_payload(group) for group in groups]}
