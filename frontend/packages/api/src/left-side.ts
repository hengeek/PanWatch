import { fetchAPI } from './client'

export type LeftSideBoard =
  | 'low_composite'
  | 'low_60'
  | 'low_250'
  | 'low_1000'
  | 'drawdown_10'
  | 'drawdown_30'
  | 'drawdown_90'

export interface LeftSideSnapshot {
  snapshot_id: string
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
  phase: string
  message: string
  signal_date: string
  universe_total: number
  excluded_st_count: number
  fundamentals_checked: number
  fundamentals_errors: number
  pe_passed: number
  history_checked: number
  history_passed: number
  history_errors: number
  risk_pending_count: number
  universe_observed_at: string
  universe_source: string
  universe_age_seconds: number | null
  universe_stale: boolean
  universe_catalogs: Record<string, unknown>
  coverage_status: string
  coverage_expected_total: number | null
  coverage_source: string
  coverage_evidence_url: string
  coverage_evidence: string
  coverage_as_of: string
  coverage_checked_at: string
  coverage_checked_by: string
  lease_expires_at: string
  error_message: string
  parameters: Record<string, unknown>
  created_at: string
  updated_at: string
  finished_at: string
}

export interface LeftSideRankingItem {
  rank: number
  symbol: string
  name: string
  signal_date: string
  signal_close: number
  pe_ttm: number
  low_60: number | null
  low_250: number | null
  low_1000: number | null
  low_composite: number | null
  drawdown_10: number | null
  drawdown_30: number | null
  drawdown_90: number | null
  risk_status: string
  admission_status: string
  pe_observed_at: string
  pe_source: string
  sample_start: string
  sample_end: string
  data_source: string
}

export interface LeftSideStatusResponse {
  current: LeftSideSnapshot | null
  latest_completed: LeftSideSnapshot | null
}

export interface LeftSideReview {
  id: number
  snapshot_id: string
  symbol: string
  name: string
  security_status: string
  security_trading_status: string
  security_effective_at: string
  security_version: string
  security_checked_at: string
  security_valid_until: string
  security_source: string
  security_evidence_url: string
  security_evidence: string
  pe_status: string
  pe_verified_value: number | null
  pe_checked_at: string
  pe_source: string
  pe_evidence_url: string
  pe_evidence: string
  financial_status: string
  financial_data: Record<string, unknown>
  financial_source: string
  financial_evidence_url: string
  financial_evidence: string
  quality_score: number | null
  provisional_quality_score: number | null
  provisional_earnings_score: number | null
  provisional_quality_status: string
  provisional_quality_missing: string[]
  financial_missing: string[]
  event_status: string
  event_category: string
  event_checked_at: string
  event_valid_until: string
  event_source: string
  event_evidence_url: string
  event_evidence: string
  review_status: string
  review_note: string
  reviewer_name: string
  version: number
  history?: Array<Record<string, unknown>>
}

export interface LeftSideAutoVerification {
  symbol: string
  signal_date: string
  checked_at: string
  source: string
  evidence_url: string
  patch: Partial<LeftSideReview>
  checks: Array<{ key: string; status: string; message: string }>
}

export interface LeftSideFinancialPrefill {
  symbol: string
  signal_date: string
  financial_status: 'needs_review'
  financial_data: Record<string, unknown>
  financial_source: string
  financial_evidence_url: string
  financial_evidence: string
  missing_fields: string[]
  field_reasons: Record<string, string>
  warnings: string[]
  cross_check: Record<string, unknown>
}

export interface LeftSideAIReport {
  report_id: string
  snapshot_id: string
  status: string
  report_version: string
  prompt_version: string
  input_fingerprint: string
  input_symbols: string[]
  model_label: string
  report: Record<string, unknown>
  usage: Record<string, unknown>
  validation_status: string
  validation_errors: string[]
  error_message: string
  created_at: string
  finished_at: string
}

export interface LeftSidePlan {
  id: string
  snapshot_id: string
  report_id: string
  symbol: string
  name: string
  industry: string
  status: string
  entry_low: number
  entry_high: number
  budget: number | null
  quantity: number | null
  take_profit_rate: number
  target_price: number | null
  valid_until: string
  parameters: Record<string, unknown>
  approval_note: string
  version: number
}

export interface LeftSideExperimentAccount {
  id: string
  name: string
  status: string
  starting_cash: number
  cash: number
  held_cost: number
  realized_pnl: number
  open_positions: number
  config: Record<string, unknown>
}

export interface LeftSideBacktestRun {
  run_id: string
  status: string
  snapshot_ids: string[]
  config: Record<string, unknown>
  result: Record<string, unknown>
  error_message: string
  created_at: string
  finished_at: string
}

export interface LeftSideRankingResponse {
  risk_excluded_count?: number
  risk_exclusions?: Array<{ symbol: string; name: string; reasons: string[] }>
  snapshot_id: string
  signal_date?: string
  board: LeftSideBoard
  items: LeftSideRankingItem[]
  total: number
  offset: number
  limit: number
}

export const leftSideApi = {
  status: () => fetchAPI<LeftSideStatusResponse>('/strategy-lab/status'),
  snapshots: (offset = 0, limit = 100) => fetchAPI<{ items: LeftSideSnapshot[]; total: number; offset: number; limit: number }>(`/strategy-lab/snapshots?offset=${offset}&limit=${limit}`),
  refresh: () => fetchAPI<{ snapshot_id: string; status: string; reused: boolean }>('/strategy-lab/rankings/refresh', { method: 'POST' }),
  rankings: (board: LeftSideBoard, snapshotId: string, offset = 0, limit = 30) => {
    const query = new URLSearchParams({ board, offset: String(offset), limit: String(limit) })
    if (snapshotId) query.set('snapshot_id', snapshotId)
    return fetchAPI<LeftSideRankingResponse>(`/strategy-lab/rankings?${query.toString()}`)
  },
  cancel: (snapshotId: string) => fetchAPI<{ snapshot_id: string; status: string; cancelled: boolean }>(`/strategy-lab/rankings/${encodeURIComponent(snapshotId)}/cancel`, { method: 'POST' }),
  verifyCoverage: (snapshotId: string, payload: Record<string, unknown>) => fetchAPI<{ snapshot: LeftSideSnapshot; operator_attested: boolean; automatically_fetched_or_verified: boolean }>(`/strategy-lab/snapshots/${encodeURIComponent(snapshotId)}/coverage`, { method: 'PUT', body: JSON.stringify(payload) }),
  review: (snapshotId: string, symbol: string) => fetchAPI<LeftSideReview>(`/strategy-lab/reviews/${encodeURIComponent(snapshotId)}/${encodeURIComponent(symbol)}`),
  autoVerify: (snapshotId: string, symbol: string) => fetchAPI<LeftSideAutoVerification>(`/strategy-lab/reviews/${encodeURIComponent(snapshotId)}/${encodeURIComponent(symbol)}/auto-verification`, { method: 'POST', timeoutMs: 60_000 }),
  fetchFinancialPrefill: (snapshotId: string, symbol: string) => fetchAPI<LeftSideFinancialPrefill>(`/strategy-lab/reviews/${encodeURIComponent(snapshotId)}/${encodeURIComponent(symbol)}/financial-prefill`, { method: 'POST', timeoutMs: 120_000 }),
  updateReview: (snapshotId: string, symbol: string, payload: Record<string, unknown>) => fetchAPI<LeftSideReview>(`/strategy-lab/reviews/${encodeURIComponent(snapshotId)}/${encodeURIComponent(symbol)}`, { method: 'PUT', body: JSON.stringify(payload) }),
  reports: (snapshotId: string) => fetchAPI<{ items: LeftSideAIReport[] }>(`/strategy-lab/reports?snapshot_id=${encodeURIComponent(snapshotId)}`),
  generateReport: (snapshotId: string, symbols: string[]) => fetchAPI<{ report_id: string; status: string; reused: boolean }>(`/strategy-lab/reports/generate?snapshot_id=${encodeURIComponent(snapshotId)}`, { method: 'POST', body: JSON.stringify({ symbols }) }),
  report: (reportId: string) => fetchAPI<LeftSideAIReport>(`/strategy-lab/reports/${encodeURIComponent(reportId)}`),
  plans: (status = '') => fetchAPI<{ items: LeftSidePlan[] }>(`/strategy-lab/plans${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  createPlan: (payload: Record<string, unknown>) => fetchAPI<LeftSidePlan>('/strategy-lab/plans', { method: 'POST', body: JSON.stringify(payload) }),
  approvePlan: (planId: string, payload: Record<string, unknown>) => fetchAPI<LeftSidePlan>(`/strategy-lab/plans/${encodeURIComponent(planId)}/approve`, { method: 'POST', body: JSON.stringify(payload) }),
  cancelPlan: (planId: string, reason = '') => fetchAPI<LeftSidePlan>(`/strategy-lab/plans/${encodeURIComponent(planId)}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  accounts: () => fetchAPI<{ items: LeftSideExperimentAccount[] }>('/strategy-lab/simulation/accounts'),
  createAccount: (payload: Record<string, unknown>) => fetchAPI<LeftSideExperimentAccount>('/strategy-lab/simulation/accounts', { method: 'POST', body: JSON.stringify(payload) }),
  setAccountStatus: (accountId: string, status: 'active' | 'paused') => fetchAPI<LeftSideExperimentAccount>(`/strategy-lab/simulation/accounts/${encodeURIComponent(accountId)}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  account: (accountId: string) => fetchAPI<Record<string, unknown>>(`/strategy-lab/simulation/accounts/${encodeURIComponent(accountId)}`),
  runSimulation: (accountId: string, planIds: string[]) => fetchAPI<Record<string, unknown>>(`/strategy-lab/simulation/accounts/${encodeURIComponent(accountId)}/run`, { method: 'POST', body: JSON.stringify({ plan_ids: planIds }) }),
  backtestReadiness: (snapshotIds: string[]) => fetchAPI<{ ready: boolean; snapshot_count: number; dates: string[]; issues: string[] }>('/strategy-lab/backtests/readiness', { method: 'POST', body: JSON.stringify({ snapshot_ids: snapshotIds }) }),
  runBacktest: (payload: Record<string, unknown>) => fetchAPI<LeftSideBacktestRun>('/strategy-lab/backtests/run', { method: 'POST', body: JSON.stringify(payload) }),
  backtests: (limit = 20) => fetchAPI<{ items: LeftSideBacktestRun[] }>(`/strategy-lab/backtests?limit=${limit}`),
  backtest: (runId: string) => fetchAPI<LeftSideBacktestRun>(`/strategy-lab/backtests/${encodeURIComponent(runId)}`),
}
