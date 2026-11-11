"""Shared watch groups for the web and desktop clients."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func
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
    rows = db.query(WatchGroup).all()
    normalized = name.casefold()
    if any(group.id != exclude_id and group.name.casefold() == normalized for group in rows):
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
    db.commit()
    return _group_payload(_require_group(db, group.id))


@router.patch("/{group_id}")
def rename_watch_group(group_id: int, data: GroupPatch, db: Session = Depends(get_db)):
    group = _require_group(db, group_id)
    if group.version != data.version:
        raise api_error(409, "watch_group_version_conflict", "分组已在另一端更新，请刷新后重试")
    name = _clean_name(data.name)
    _check_name_available(db, name, exclude_id=group.id)
    group.name = name
    group.version += 1
    db.commit()
    return _group_payload(_require_group(db, group.id))


@router.delete("/{group_id}")
def delete_watch_group(group_id: int, version: int, db: Session = Depends(get_db)):
    group = _require_group(db, group_id)
    if group.version != version:
        raise api_error(409, "watch_group_version_conflict", "分组已在另一端更新，请刷新后重试")
    db.delete(group)
    db.commit()
    return {"ok": True, "id": group_id}


@router.put("/{group_id}/members")
def update_watch_group_members(group_id: int, data: GroupMembersUpdate, db: Session = Depends(get_db)):
    group = _require_group(db, group_id)
    if group.version != data.version:
        raise api_error(409, "watch_group_version_conflict", "分组已在另一端更新，请刷新后重试")
    if len(data.stock_ids) != len(set(data.stock_ids)):
        raise api_error(400, "watch_group_duplicate_member", "分组中不能重复添加同一只股票")
    if data.stock_ids:
        found = {
            stock_id for (stock_id,) in db.query(Stock.id)
            .filter(Stock.id.in_(data.stock_ids)).all()
        }
        missing = sorted(set(data.stock_ids) - found)
        if missing:
            raise api_error(404, "watch_group_stock_not_found", "分组中包含不存在的股票")
    group.members.clear()
    db.flush()
    group.members.extend(
        WatchGroupMember(stock_id=stock_id, sort_order=index)
        for index, stock_id in enumerate(data.stock_ids)
    )
    group.version += 1
    db.commit()
    return _group_payload(_require_group(db, group_id))


@router.put("/members")
def update_watch_group_members_batch(data: GroupMembersBatch, db: Session = Depends(get_db)):
    """Update multiple group memberships atomically for the desktop group picker."""
    group_ids = [item.group_id for item in data.groups]
    if len(group_ids) != len(set(group_ids)):
        raise api_error(400, "watch_group_duplicate_update", "同一分组不能重复提交")
    all_stock_ids = {stock_id for item in data.groups for stock_id in item.stock_ids}
    if any(len(item.stock_ids) != len(set(item.stock_ids)) for item in data.groups):
        raise api_error(400, "watch_group_duplicate_member", "分组中不能重复添加同一只股票")
    if all_stock_ids:
        found = {
            stock_id for (stock_id,) in db.query(Stock.id)
            .filter(Stock.id.in_(all_stock_ids)).all()
        }
        if found != all_stock_ids:
            raise api_error(404, "watch_group_stock_not_found", "分组中包含不存在的股票")
    groups = {
        group.id: group for group in (
            db.query(WatchGroup)
            .options(selectinload(WatchGroup.members).selectinload(WatchGroupMember.stock))
            .filter(WatchGroup.id.in_(group_ids)).all()
        )
    } if group_ids else {}
    if len(groups) != len(group_ids):
        raise api_error(404, "watch_group_not_found", "关注分组不存在")
    for item in data.groups:
        if groups[item.group_id].version != item.version:
            raise api_error(409, "watch_group_version_conflict", "分组已在另一端更新，请刷新后重试")
    for item in data.groups:
        group = groups[item.group_id]
        group.members.clear()
        group.version += 1
        group.members.extend(
            WatchGroupMember(stock_id=stock_id, sort_order=index)
            for index, stock_id in enumerate(item.stock_ids)
        )
    db.commit()
    updated = (
        db.query(WatchGroup)
        .options(selectinload(WatchGroup.members).selectinload(WatchGroupMember.stock))
        .filter(WatchGroup.id.in_(group_ids))
        .order_by(WatchGroup.sort_order, WatchGroup.id).all()
    ) if group_ids else []
    return {"items": [_group_payload(group) for group in updated]}
