from datetime import date
from types import SimpleNamespace
import subprocess

import pytest

from src.modules.strategy.left_side import verification as v


class Rows:
    def __init__(self, rows):
        self.error_code = '0'
        self.fields = list(rows[0]) if rows else []
        self.iterator = iter(rows)
    def next(self):
        self.current = next(self.iterator, None)
        return self.current is not None
    def get_row_data(self):
        return [self.current[k] for k in self.fields]


class Provider:
    def __init__(self, *, pe='20', st='0', trading='1', status='1', daily=True):
        self.pe, self.st, self.trading, self.status, self.daily = pe, st, trading, status, daily
        self.logged_out = False
    def login(self):
        return SimpleNamespace(error_code='0')
    def logout(self):
        self.logged_out = True
    def query_history_k_data_plus(self, code, fields, **kw):
        return Rows([{'code': code, 'date': kw['start_date'], 'peTTM': self.pe, 'isST': self.st, 'tradestatus': self.trading}] if self.daily else [])
    def query_stock_basic(self, code):
        return Rows([{'code': code, 'code_name': '测试', 'type': '1', 'status': self.status, 'outDate': ''}])
    def query_trade_dates(self, **kw):
        return Rows([{'calendar_date': '2026-11-10', 'is_trading_day': '1'}])


def verify(provider, pe=20, source='tencent', symbol='600519'):
    return v.verify_candidate(symbol, '2026-11-09', pe, source, today=date(2026, 11, 10), provider=provider)


def test_independent_pe_and_current_security_dates_are_kept_separate():
    bs = Provider()
    result = verify(bs)
    p = result['patch']
    assert p['pe_status'] == 'verified'
    assert p['pe_checked_at'] == '2026-11-09'
    assert p['security_effective_at'] == '2026-11-10'
    assert p['security_checked_at'] == '2026-11-10'
    assert p['security_valid_until'] == '2026-11-10'
    assert p['security_status'] == 'normal'
    assert p['security_trading_status'] == 'trading'
    assert 'financial_status' not in p and 'review_status' not in p and 'event_status' not in p
    assert bs.logged_out


@pytest.mark.parametrize('pe', ['30', '-1', '0', '25'])
def test_pe_boundaries_and_difference_block_verified_status(pe):
    assert verify(Provider(pe=pe))['patch']['pe_status'] == 'conflict'


@pytest.mark.parametrize('pe', ['', 'nan', 'inf'])
def test_invalid_pe_never_verifies(pe):
    p = verify(Provider(pe=pe))['patch']
    assert p['pe_status'] == 'unknown'
    assert p['pe_verified_value'] is None


def test_same_source_is_not_independent():
    assert verify(Provider(), source='BaoStock historical')['patch']['pe_status'] == 'conflict'


@pytest.mark.parametrize('kwargs, status, trading', [
    ({'st': '1'}, 'st', 'trading'),
    ({'trading': '0'}, 'normal', 'suspended'),
    ({'status': '0'}, 'delisted', 'unknown'),
    ({'daily': False}, 'unknown', 'unknown'),
])
def test_adverse_or_missing_status_is_never_marked_normal(kwargs, status, trading):
    p = verify(Provider(**kwargs))['patch']
    assert p['security_status'] == status
    assert p['security_trading_status'] == trading


def test_partial_failure_keeps_independent_pe_result():
    bs = Provider()
    bs.query_stock_basic = lambda **kw: (_ for _ in ()).throw(RuntimeError())
    p = verify(bs)['patch']
    assert p['pe_status'] == 'verified'
    assert p['security_status'] == 'unknown'


def test_unsupported_market_and_timeout_have_explanations(monkeypatch):
    assert verify(Provider(), symbol='920001')['checks'][0]['status'] == 'unavailable'
    def timeout(*args):
        raise subprocess.TimeoutExpired('worker', 45)
    monkeypatch.setattr(v, '_query_isolated', timeout)
    r = v.verify_candidate('600519', '2026-11-09', 20, 'tencent', today=date(2026, 11, 10))
    assert r['patch']['pe_status'] == 'unknown'
    assert '45' in r['checks'][0]['message']


def test_api_requires_auth_and_candidate_membership_without_saving(monkeypatch):
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from sqlalchemy.pool import StaticPool
    from src.modules.strategy.left_side.api import router, get_current_user, get_db
    from src.platform.persistence.database import Base
    from src.platform.persistence.models import LeftSideRankingSnapshot, LeftSideRankingItem, LeftSideCandidateReview

    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(LeftSideRankingSnapshot(id='verify-api', status='partial', phase='published', signal_date='2026-11-09'))
        db.add(LeftSideRankingItem(snapshot_id='verify-api', symbol='600519', name='示例', signal_date='2026-11-09', signal_close=100, pe_ttm=20, pe_source='tencent'))
        db.commit()
        app = FastAPI()
        app.include_router(router, prefix='/strategy-lab')
        app.dependency_overrides[get_db] = lambda: db
        def denied():
            raise HTTPException(401, 'login required')
        app.dependency_overrides[get_current_user] = denied
        called = []
        original_verify = v.verify_candidate
        def run(*args):
            called.append(args)
            return original_verify(*args, today=date(2026, 11, 10), provider=Provider())
        monkeypatch.setattr(v, 'verify_candidate', run)
        with TestClient(app) as client:
            url = '/strategy-lab/reviews/verify-api/600519/auto-verification'
            assert client.post(url).status_code == 401
            assert not called
            app.dependency_overrides[get_current_user] = lambda: 'qa'
            assert client.post(url.replace('600519', '600000')).status_code == 404
            assert not called
            response = client.post(url)
            assert response.status_code == 200
            assert response.json()['patch']['pe_status'] == 'verified'
            assert called == [('600519', '2026-11-09', 20.0, 'tencent')]
            assert db.query(LeftSideCandidateReview).count() == 0
    engine.dispose()
