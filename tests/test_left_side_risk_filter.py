from datetime import datetime
from types import SimpleNamespace

import pytest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from src.modules.strategy.left_side import rankings, workflows
from src.modules.strategy.left_side.api import get_rankings
from src.platform.persistence.database import Base
from src.platform.persistence.models import LeftSideRankingSnapshot, LeftSideRankingItem, LeftSideCandidateReview


def test_delisting_suffix_normalization():
    for name in ('萃华退', '退市整理', '*ST萃华', ' ＊ＳＴ 测试 ', 'S*ST测试'):
        assert rankings._is_name_excluded(name)
    for name in ('金科股份', '退出机制科技', '退税科技'):
        assert not rankings._is_name_excluded(name)


def test_filter_applies_before_top30_and_pagination_across_boards_and_snapshots():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add_all([LeftSideRankingSnapshot(id='old',status='partial',signal_date='2026-11-09'),LeftSideRankingSnapshot(id='new',status='partial',signal_date='2026-11-10')]);db.flush()
        for index in range(34):
            symbol = f'{index:06}'
            name = '萃华退' if index == 0 else '金科股份' if index == 1 else f'普通{index}'
            data = {field:100-index for field, _ in rankings.BOARDS.values()}
            db.add(LeftSideRankingItem(snapshot_id='new',symbol=symbol,name=name,signal_date='2026-11-10',signal_close=10,pe_ttm=10,pe_source='tencent',**data))
        db.add(LeftSideCandidateReview(snapshot_id='old',symbol='000001',name='金科股份',event_status='risk',updated_at=datetime(2026,11,9)))
        # A new blank review must not silently clear a known unresolved risk.
        db.add(LeftSideCandidateReview(snapshot_id='new',symbol='000001',name='金科股份',updated_at=datetime(2026,11,10)))
        db.commit()
        for board in rankings.BOARDS:
            result=get_rankings(board=board,snapshot_id='new',offset=0,limit=30,db=db)
            assert result['total']==32
            assert len(result['items'])==30
            assert result['items'][0]['symbol']=='000002'
            assert result['items'][-1]['symbol']=='000031'
            assert result['risk_excluded_count']==2
        payload,symbols=workflows._boards_payload(db,db.get(LeftSideRankingSnapshot,'new'))
        assert '000000' not in symbols and '000001' not in symbols
        assert len(symbols)==30
        with pytest.raises(ValueError, match="未解除"):
            workflows._review_gate(db, 'new', '000001')
        raw = {"candidate_scores": [{"symbol": "000001", "total_score": 99}, {"symbol": "000002", "total_score": 60}], "today_buy_list": [{"symbol": "000001"}], "tomorrow_watch": [{"symbol": "000001"}]}
        report = SimpleNamespace(id='report',snapshot_id='new',input_symbols=['000001','000002'],report=raw,prompt_version=getattr(workflows,"_AI_REPORT_PROMPT_VERSION","test"),report_version='test',status='succeeded',input_fingerprint='',model_label='',usage={},validation_status='passed',validation_errors=[],error_message='',created_at=None,finished_at=None)
        serialized=workflows._report_with_current_risks(db,report,{})
        assert serialized['validation_status']=='stale_risk'
        assert serialized['report']['candidate_scores']==[{'symbol':'000002','name':'','total_score':60}]
        assert serialized['report']['today_buy_list']==[]
        assert raw['today_buy_list']==[{'symbol':'000001'}]
        last=get_rankings(board='low_60',snapshot_id='new',offset=30,limit=30,db=db)
        assert [x['symbol'] for x in last['items']]==['000032','000033']
        row=db.query(LeftSideCandidateReview).filter_by(snapshot_id='new',symbol='000001').one()
        row.event_status='clear';row.updated_at=datetime(2026,11,11);db.commit()
        query, excluded=rankings.visible_ranking_query(db,'new')
        assert query.count()==33
        assert len(excluded)==1
        assert db.query(LeftSideRankingItem).filter_by(snapshot_id='new').count()==34
    engine.dispose()


def test_financial_candidate_rules_cover_loss_quality_cash_and_debt_without_assuming_missing_is_zero():
    assert rankings.financial_candidate_risks({}) == []  # unknown, not financial approval
    reasons = rankings.financial_candidate_risks({"annual_net_profit": -1, "ttm_net_profit": 100, "adjusted_ttm_net_profit": -10, "consolidated_ttm_net_profit": 100, "operating_cash_flow_ttm": 20, "debt_peer_percentile": 90, "short_term_debt": 100, "unrestricted_cash": 20, "audit_opinion": "无法表示意见"})
    assert len(reasons) == 6
    assert rankings.financial_candidate_risks({"ttm_net_profit":100,"adjusted_ttm_net_profit":50,"consolidated_ttm_net_profit":100,"operating_cash_flow_ttm":50}) == []
    # An approved explanation can resolve a soft ratio warning, not a loss.
    assert rankings.financial_candidate_risks({"adjusted_ttm_net_profit":-1}, explained=True)==['扣非TTM利润非正']


def test_sourced_financial_loss_filters_pending_review_without_manual_rejection():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(LeftSideRankingSnapshot(id='financial',status='partial',signal_date='2026-11-09'));db.flush()
        db.add(LeftSideRankingItem(snapshot_id='financial',symbol='600001',name='普通公司',signal_date='2026-11-09',signal_close=10,pe_ttm=1,pe_source='tencent',low_60=100))
        review=LeftSideCandidateReview(snapshot_id='financial',symbol='600001',financial_status='needs_review',financial_source='public filing',financial_evidence='filing record',financial_data={'report_period':'2025-12-31','announcement_at':'2026-04-30','adjusted_ttm_net_profit':-1})
        db.add(review);db.commit()
        query,details=rankings.visible_ranking_query(db,'financial')
        assert query.count()==0
        assert '扣非TTM利润非正' in details[0]['reasons']
        review.financial_data={**review.financial_data,'announcement_at':'2099-04-30'};db.commit()
        assert rankings.visible_ranking_query(db,'financial')[0].count()==1
    engine.dispose()
