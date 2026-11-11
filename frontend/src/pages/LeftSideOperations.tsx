import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ClipboardCheck, Download, FileText, FlaskConical, ListChecks, ShieldCheck } from 'lucide-react'
import { leftSideApi, type LeftSideAutoVerification, type LeftSideAIReport, type LeftSideBacktestRun, type LeftSideExperimentAccount, type LeftSidePlan, type LeftSideRankingItem, type LeftSideReview, type LeftSideSnapshot } from '@panwatch/api'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'
import { useConfirm } from '@panwatch/base-ui/components/ui/confirm-dialog'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import { useTranslation } from 'react-i18next'

type Panel = 'review' | 'ai' | 'plans' | 'simulation' | 'backtest'
type ReviewDraft = Partial<LeftSideReview>
type CandidateAIScore = Record<string, unknown>

const SCORE_DIMENSIONS = [
  { key: 'low_position_score', cap: 40, label: 'lowPosition' },
  { key: 'earnings_score', cap: 30, label: 'earnings' },
  { key: 'trend_flow_score', cap: 20, label: 'trendFlow' },
  { key: 'risk_safety_score', cap: 10, label: 'riskSafety' },
] as const

function candidateScoreRows(report: Record<string, unknown>): CandidateAIScore[] {
  const scores = report.candidate_scores
  return Array.isArray(scores) ? scores.filter((item): item is CandidateAIScore => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : []
}

function scoreNumber(score: CandidateAIScore, key: string): number | null {
  const raw = score[key]
  if (raw == null || raw === '' || (typeof raw !== 'string' && typeof raw !== 'number')) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function readableValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

export default function LeftSideOperations({ snapshotId, snapshot, candidates, selectedCandidate, onSelectCandidate, onRefresh }: {
  snapshotId: string
  snapshot: LeftSideSnapshot | null
  candidates: LeftSideRankingItem[]
  selectedCandidate: LeftSideRankingItem | null
  onSelectCandidate: (item: LeftSideRankingItem) => void
  onRefresh: () => Promise<void>
}) {
  const { t } = useTranslation('leftSide')
  const tr = t as unknown as (key: string, options?: Record<string, unknown>) => string
  const { toast } = useToast()
  const confirmAction = useConfirm()
  const [panel, setPanel] = useState<Panel>('review')
  const [review, setReview] = useState<LeftSideReview | null>(null)
  const [draft, setDraft] = useState<ReviewDraft>({})
  const [autoVerification, setAutoVerification] = useState<LeftSideAutoVerification | null>(null)
  const [autoVerifyBusy, setAutoVerifyBusy] = useState(false)
  const selectionKey = `${snapshotId}:${selectedCandidate?.symbol || ''}`
  const activeSelection = useRef(selectionKey)
  activeSelection.current = selectionKey
  useEffect(() => { setAutoVerification(null) }, [selectionKey])
  const [financialJson, setFinancialJson] = useState('{}')
  const [financialWarnings, setFinancialWarnings] = useState<string[]>([])
  const [financialFetchBusy, setFinancialFetchBusy] = useState(false)
  const [savingReview, setSavingReview] = useState(false)
  const [reports, setReports] = useState<LeftSideAIReport[]>([])
  const [reportLoading, setReportLoading] = useState(false)
  const [plans, setPlans] = useState<LeftSidePlan[]>([])
  const [planBudget, setPlanBudget] = useState('')
  const [planQuantity, setPlanQuantity] = useState('')
  const [planValidUntil, setPlanValidUntil] = useState('')
  const [accounts, setAccounts] = useState<LeftSideExperimentAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [accountForm, setAccountForm] = useState({ name: '左侧策略实验账户', starting_cash: '', commission_rate: '', minimum_commission: '', stamp_tax_rate: '', transfer_fee_rate: '' })
  const [accountDetails, setAccountDetails] = useState<Record<string, unknown> | null>(null)
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([])
  const [planIdsText, setPlanIdsText] = useState('')
  const [backtestReadiness, setBacktestReadiness] = useState<{ ready: boolean; snapshot_count: number; dates: string[]; issues: string[] } | null>(null)
  const [backtestSnapshots, setBacktestSnapshots] = useState<LeftSideSnapshot[]>([])
  const [selectedBacktestIds, setSelectedBacktestIds] = useState<string[]>([])
  const [backtestFees, setBacktestFees] = useState({ starting_cash: '100000', commission_rate: '', minimum_commission: '', stamp_tax_rate: '', transfer_fee_rate: '' })
  const [backtestResult, setBacktestResult] = useState<LeftSideBacktestRun | null>(null)
  const [backtestRuns, setBacktestRuns] = useState<LeftSideBacktestRun[]>([])
  const [backtestRunning, setBacktestRunning] = useState(false)
  const [coverageForm, setCoverageForm] = useState({ expected_total: '', source: '', evidence_url: '', evidence: '', as_of: '' })
  const [coverageBusy, setCoverageBusy] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setCoverageForm(current => ({ ...current, as_of: snapshot?.signal_date || '' }))
  }, [snapshot?.snapshot_id, snapshot?.signal_date])

  const loadReview = useCallback(async () => {
    if (!snapshotId || !selectedCandidate) { setReview(null); setDraft({}); setFinancialJson('{}'); setFinancialWarnings([]); return }
    try {
      const result = await leftSideApi.review(snapshotId, selectedCandidate.symbol)
      setReview(result)
      setDraft(result)
      setFinancialJson(JSON.stringify(result.financial_data || {}, null, 2))
      const sourceMetadata = result.financial_data?.source_metadata
      const savedWarnings = sourceMetadata && typeof sourceMetadata === 'object' ? (sourceMetadata as Record<string, unknown>).warnings : null
      setFinancialWarnings(Array.isArray(savedWarnings) ? savedWarnings.filter((item): item is string => typeof item === 'string') : [])
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    }
  }, [snapshotId, selectedCandidate, toast, tr])

  const loadReports = useCallback(async () => {
    if (!snapshotId) { setReports([]); return }
    try {
      const result = await leftSideApi.reports(snapshotId)
      setReports(result.items || [])
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    }
  }, [snapshotId, toast, tr])

  const loadPlans = useCallback(async () => {
    try {
      const result = await leftSideApi.plans()
      setPlans(result.items || [])
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    }
  }, [toast, tr])

  const loadAccounts = useCallback(async () => {
    try {
      const result = await leftSideApi.accounts()
      setAccounts(result.items || [])
      if (!accountId && result.items?.length) setAccountId(result.items[0].id)
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    }
  }, [accountId, toast, tr])

  useEffect(() => { void loadReview() }, [loadReview])
  useEffect(() => { if (panel === 'ai') void loadReports() }, [panel, loadReports])
  useEffect(() => { if (panel === 'plans' || panel === 'simulation') void loadPlans() }, [panel, loadPlans])
  useEffect(() => { if (panel === 'simulation') void loadAccounts() }, [panel, loadAccounts])
  useEffect(() => {
    if (panel !== 'backtest') return
    leftSideApi.snapshots(0, 100).then(result => setBacktestSnapshots(result.items || [])).catch(error => toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error'))
    leftSideApi.backtests().then(result => setBacktestRuns(result.items || [])).catch(error => toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error'))
  }, [panel, toast, tr])

  const scopedReports = useMemo(() => {
    const symbols = new Set(candidates.map(item => item.symbol))
    return reports.filter(report => report.input_symbols.length === symbols.size && report.input_symbols.every(symbol => symbols.has(symbol)))
  }, [reports, candidates])
  const pendingReport = useMemo(() => scopedReports.find(report => report.status === 'queued' || report.status === 'running'), [scopedReports])
  useEffect(() => {
    if (!pendingReport) return
    const timer = window.setInterval(() => { void loadReports() }, 2500)
    return () => window.clearInterval(timer)
  }, [pendingReport, loadReports])

  useEffect(() => {
    if (!accountId || panel !== 'simulation') { setAccountDetails(null); return }
    let active = true
    leftSideApi.account(accountId).then(data => { if (active) setAccountDetails(data) }).catch(error => { if (active) toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error') })
    return () => { active = false }
  }, [accountId, panel, toast, tr])

  const updateDraft = (field: keyof ReviewDraft, value: unknown) => setDraft(current => ({ ...current, [field]: value }))
  const autoVerify = async () => {
    if (!snapshotId || !selectedCandidate || !review) return
    if (!(await confirmAction(tr('workflow.review.autoVerifyConfirm')))) return
    const requestKey = selectionKey
    setAutoVerifyBusy(true)
    try {
      const result = await leftSideApi.autoVerify(snapshotId, selectedCandidate.symbol)
      if (activeSelection.current !== requestKey) return
      setAutoVerification(result)
      setDraft(current => ({ ...current, ...result.patch }))
      toast(tr('workflow.review.autoVerifyDone'), 'info')
    } catch (error) {
      if (activeSelection.current === requestKey) toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    } finally { setAutoVerifyBusy(false) }
  }
  const fetchFinancialPrefill = async () => {
    if (!snapshotId || !selectedCandidate || !review) return
    const savedJson = JSON.stringify(review.financial_data || {}, null, 2)
    if (financialJson.trim() !== savedJson.trim() && !(await confirmAction(tr('workflow.review.prefillReplaceConfirm'), { title: tr('workflow.review.financial') }))) return
    setFinancialFetchBusy(true)
    try {
      const result = await leftSideApi.fetchFinancialPrefill(snapshotId, selectedCandidate.symbol)
      setFinancialJson(JSON.stringify(result.financial_data || {}, null, 2))
      setFinancialWarnings(result.warnings || [])
      setDraft(current => ({
        ...current,
        financial_status: 'needs_review',
        financial_source: result.financial_source,
        financial_evidence_url: result.financial_evidence_url,
        financial_evidence: result.financial_evidence,
      }))
      toast(tr('workflow.review.prefillDone'), result.warnings?.length ? 'info' : 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    } finally { setFinancialFetchBusy(false) }
  }
  const saveReview = async (decision: 'pending' | 'approve' | 'hold' | 'reject') => {
    if (!snapshotId || !selectedCandidate || !review) return
    let financialData: Record<string, unknown>
    try {
      financialData = JSON.parse(financialJson)
      if (!financialData || Array.isArray(financialData) || typeof financialData !== 'object') throw new Error('object')
    } catch {
      toast(tr('workflow.review.invalidJson'), 'error')
      return
    }
    setSavingReview(true)
    try {
      const saved = await leftSideApi.updateReview(snapshotId, selectedCandidate.symbol, {
        expected_version: review.version,
        decision,
        ...draft,
        financial_data: financialData,
      })
      setReview(saved)
      setDraft(saved)
      setFinancialJson(JSON.stringify(saved.financial_data || {}, null, 2))
      toast(saved.review_status === 'approved' ? tr('workflow.review.approved') : tr('workflow.review.savedPending'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    } finally { setSavingReview(false) }
  }

  const generateReport = async () => {
    if (!snapshotId) return
    if (!(await confirmAction(tr('workflow.ai.confirm'), { title: tr('workflow.ai.title') }))) return
    setReportLoading(true)
    try {
      await leftSideApi.generateReport(snapshotId, candidates.map(item => item.symbol))
      await loadReports()
      toast(tr('workflow.ai.started'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    } finally { setReportLoading(false) }
  }

  const createPlan = async () => {
    if (!snapshotId || !selectedCandidate) return
    const budget = Number(planBudget)
    const quantity = Number(planQuantity)
    if (!planValidUntil || (!budget && !quantity)) {
      toast(tr('workflow.plan.parametersRequired'), 'error')
      return
    }
    setBusy(true)
    try {
      await leftSideApi.createPlan({
        snapshot_id: snapshotId,
        symbol: selectedCandidate.symbol,
        idempotency_key: crypto.randomUUID(),
        entry_band_pct: 0.01,
        take_profit_rate: 0.03,
        budget: budget > 0 ? budget : null,
        quantity: quantity > 0 ? quantity : null,
        valid_until: planValidUntil,
      })
      await loadPlans()
      toast(tr('workflow.plan.created'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    } finally { setBusy(false) }
  }

  const approvePlan = async (plan: LeftSidePlan) => {
    if (!(await confirmAction(tr('workflow.plan.approveConfirm'), { title: tr('workflow.plan.title') }))) return
    try {
      await leftSideApi.approvePlan(plan.id, { expected_version: plan.version, approval_note: tr('workflow.plan.approvalNote') })
      await loadPlans()
      toast(tr('workflow.plan.approved'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    }
  }

  const cancelPlan = async (plan: LeftSidePlan) => {
    if (!(await confirmAction(tr('workflow.plan.cancelConfirm'), { destructive: true }))) return
    try {
      await leftSideApi.cancelPlan(plan.id, tr('workflow.plan.cancelReason'))
      await loadPlans()
      toast(tr('workflow.plan.cancelled'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    }
  }

  const createAccount = async () => {
    const numbers = ['starting_cash', 'commission_rate', 'minimum_commission', 'stamp_tax_rate', 'transfer_fee_rate']
    if (numbers.some(key => !accountForm[key as keyof typeof accountForm].trim()) || numbers.some(key => !Number.isFinite(Number(accountForm[key as keyof typeof accountForm])) || Number(accountForm[key as keyof typeof accountForm]) < 0) || Number(accountForm.starting_cash) <= 0) {
      toast(tr('workflow.simulation.feesRequired'), 'error')
      return
    }
    try {
      const values = {
        name: accountForm.name,
        starting_cash: Number(accountForm.starting_cash),
        commission_rate: Number(accountForm.commission_rate),
        minimum_commission: Number(accountForm.minimum_commission),
        stamp_tax_rate: Number(accountForm.stamp_tax_rate),
        transfer_fee_rate: Number(accountForm.transfer_fee_rate),
      }
      const account = await leftSideApi.createAccount(values)
      await loadAccounts()
      setAccountId(account.id)
      toast(tr('workflow.simulation.accountCreated'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    }
  }

  const runSimulation = async () => {
    if (!accountId || !selectedPlanIds.length) return
    if (!(await confirmAction(tr('workflow.simulation.runConfirm'), { title: tr('workflow.simulation.title') }))) return
    setBusy(true)
    try {
      await leftSideApi.runSimulation(accountId, selectedPlanIds)
      const details = await leftSideApi.account(accountId)
      setAccountDetails(details)
      await loadAccounts()
      toast(tr('workflow.simulation.runComplete'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    } finally { setBusy(false) }
  }

  const toggleAccountStatus = async (account: LeftSideExperimentAccount) => {
    const nextStatus = account.status === 'active' ? 'paused' : 'active'
    if (!(await confirmAction(tr('workflow.simulation.statusConfirm', { status: tr(`workflow.simulation.${nextStatus}`) })))) return
    try {
      await leftSideApi.setAccountStatus(account.id, nextStatus)
      await loadAccounts()
      toast(tr(`workflow.simulation.${nextStatus}Done`), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    }
  }

  const checkBacktest = async () => {
    const pastedIds = planIdsText.split(/[\s,，]+/).map(value => value.trim()).filter(Boolean)
    const ids = [...new Set(selectedBacktestIds.length ? selectedBacktestIds : pastedIds)]
    setBusy(true)
    try { setBacktestReadiness(await leftSideApi.backtestReadiness(ids)) }
    catch (error) { toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error') }
    finally { setBusy(false) }
  }

  const runBacktest = async () => {
    const pastedIds = planIdsText.split(/[\s,，]+/).map(value => value.trim()).filter(Boolean)
    const snapshotIds = [...new Set(selectedBacktestIds.length ? selectedBacktestIds : pastedIds)]
    const feeKeys = ['commission_rate', 'minimum_commission', 'stamp_tax_rate', 'transfer_fee_rate'] as const
    if (!snapshotIds.length || feeKeys.some(key => !backtestFees[key].trim()) || feeKeys.some(key => !Number.isFinite(Number(backtestFees[key])) || Number(backtestFees[key]) < 0) || Number(backtestFees.starting_cash) <= 0) {
      toast(tr('workflow.backtest.feesRequired'), 'error')
      return
    }
    if (!(await confirmAction(tr('workflow.backtest.runConfirm'), { title: tr('workflow.backtest.title') }))) return
    setBacktestRunning(true)
    try {
      const run = await leftSideApi.runBacktest({
        snapshot_ids: snapshotIds,
        starting_cash: Number(backtestFees.starting_cash),
        commission_rate: Number(backtestFees.commission_rate),
        minimum_commission: Number(backtestFees.minimum_commission),
        stamp_tax_rate: Number(backtestFees.stamp_tax_rate),
        transfer_fee_rate: Number(backtestFees.transfer_fee_rate),
      })
      setBacktestResult(run)
      const history = await leftSideApi.backtests()
      setBacktestRuns(history.items || [])
      toast(tr('workflow.backtest.runSaved'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    } finally { setBacktestRunning(false) }
  }

  const verifyCoverage = async () => {
    if (!snapshot || !coverageForm.expected_total.trim() || !coverageForm.source.trim() || !coverageForm.evidence_url.trim() || !coverageForm.evidence.trim() || !coverageForm.as_of) return
    const expected = Number(coverageForm.expected_total)
    if (!Number.isInteger(expected) || expected <= 0) {
      toast(tr('workflow.coverage.invalidCount'), 'error')
      return
    }
    setCoverageBusy(true)
    try {
      await leftSideApi.verifyCoverage(snapshot.snapshot_id, { ...coverageForm, expected_total: expected })
      await onRefresh()
      toast(tr('workflow.coverage.saved'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('workflow.failed'), 'error')
    } finally { setCoverageBusy(false) }
  }

  const panels: Array<{ id: Panel; label: string; icon: typeof ClipboardCheck }> = [
    { id: 'review', label: tr('workflow.sections.review'), icon: ClipboardCheck },
    { id: 'ai', label: tr('workflow.sections.ai'), icon: FileText },
    { id: 'plans', label: tr('workflow.sections.plans'), icon: ListChecks },
    { id: 'simulation', label: tr('workflow.sections.simulation'), icon: FlaskConical },
    { id: 'backtest', label: tr('workflow.sections.backtest'), icon: ShieldCheck },
  ]

  return (
    <section className="card overflow-hidden">
      <div className="flex gap-1 overflow-x-auto scrollbar border-b border-border/50 p-3">
        {panels.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" onClick={() => setPanel(id)} className={`inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${panel === id ? 'bg-primary text-primary-foreground' : 'bg-accent/50 text-muted-foreground hover:bg-accent hover:text-foreground'}`}>
            <Icon className="h-3.5 w-3.5" />{label}
          </button>
        ))}
      </div>

      {panel === 'review' && (
        <div className="space-y-4 p-4 sm:p-6">
          <div>
            <h2 className="text-base font-semibold">{tr('workflow.review.title')}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{tr('workflow.review.description')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {candidates.map(item => <Button key={item.symbol} size="sm" variant={selectedCandidate?.symbol === item.symbol ? 'default' : 'outline'} onClick={() => onSelectCandidate(item)}>{item.symbol} {item.name}</Button>)}
          </div>
          {!selectedCandidate ? <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{tr('workflow.review.noCandidate')}</div> : !review ? <div className="text-sm text-muted-foreground">{tr('loading')}</div> : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold">{review.symbol} {review.name}</span>
                <span className="rounded-full bg-accent px-2 py-1">{tr('workflow.review.status')}: {review.review_status}</span>
                <span className="rounded-full bg-accent px-2 py-1">{tr('columns.pe')} {selectedCandidate?.pe_ttm.toFixed(2) || '—'} · {selectedCandidate?.pe_source || tr('workflow.review.peSourceUnknown')}</span>
                <span className="rounded-full bg-accent px-2 py-1">Q: {review.quality_score != null ? `${review.quality_score.toFixed(2)} / 100 · ${tr('workflow.review.financialVerified')}` : review.provisional_quality_score != null ? `${review.provisional_quality_score.toFixed(2)} / 100 · ${tr('workflow.review.financialProvisional')} · ${review.provisional_earnings_score?.toFixed(2) || '0.00'} / 30` : `— · ${tr(`workflow.ai.financialStatuses.${review.provisional_quality_status}`, { defaultValue: review.provisional_quality_status })}`}</span>
                <span className="text-muted-foreground">{review.financial_missing.join(' · ')}</span>
              </div>
              <div className="space-y-3 rounded-xl border border-border/60 p-4">
                <Button variant="outline" disabled={autoVerifyBusy || savingReview || financialFetchBusy} onClick={() => void autoVerify()}>
                  <ShieldCheck className="mr-1.5 h-4 w-4" />{tr(autoVerifyBusy ? 'workflow.review.autoVerifyLoading' : 'workflow.review.autoVerify')}
                </Button>
                <p className="text-xs leading-5 text-muted-foreground">{tr('workflow.review.autoVerifyHelp')}</p>
                {autoVerification && <div role="status" className="space-y-2 text-xs">
                  <p>{autoVerification.source} · {autoVerification.checked_at}</p>
                  {autoVerification.checks.map(check => <p key={check.key} className={check.status === 'verified' ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300'}>
                    <strong>{tr(`workflow.review.autoChecks.${check.key}`)}</strong> · {tr(`workflow.review.autoStatuses.${check.status}`, { defaultValue: check.status })} · {check.message}
                  </p>)}
                  <p className="text-muted-foreground">{tr('workflow.review.autoVerifyDone')}</p>
                </div>}
              </div>
              <div className="grid gap-4 xl:grid-cols-4">
                <div className="space-y-3 rounded-xl border border-border/60 p-4">
                  <h3 className="text-sm font-semibold">{tr('workflow.review.peTitle')}</h3>
                  <p className="text-[10px] leading-4 text-muted-foreground">{tr('workflow.review.peHelp', { date: snapshot?.signal_date || '—', vendor: selectedCandidate?.pe_source || '—' })}</p>
                  <StatusSelect label={tr('workflow.review.peStatus')} value={String(draft.pe_status || 'pending')} options={['pending', 'verified', 'conflict', 'unknown']} onChange={value => updateDraft('pe_status', value)} />
                  <Field type="number" label={tr('workflow.review.peVerifiedValue')} value={draft.pe_verified_value == null ? '' : String(draft.pe_verified_value)} onChange={value => updateDraft('pe_verified_value', value.trim() ? Number(value) : null)} />
                  <Field type="date" label={tr('workflow.review.checkedAt')} value={String(draft.pe_checked_at || '').slice(0, 10)} onChange={value => updateDraft('pe_checked_at', value)} />
                  <Field label={tr('workflow.review.peSource')} value={String(draft.pe_source || '')} onChange={value => updateDraft('pe_source', value)} />
                  <Field label={tr('workflow.review.evidenceUrl')} value={String(draft.pe_evidence_url || '')} onChange={value => updateDraft('pe_evidence_url', value)} />
                  <Field label={tr('workflow.review.evidence')} value={String(draft.pe_evidence || '')} onChange={value => updateDraft('pe_evidence', value)} />
                </div>
                <div className="space-y-3 rounded-xl border border-border/60 p-4">
                  <h3 className="text-sm font-semibold">{tr('workflow.review.security')}</h3>
                  <StatusSelect label={tr('workflow.review.securityStatus')} value={String(draft.security_status || 'pending')} options={['pending', 'normal', 'st', 'delisting', 'delisted', 'conflict', 'unknown']} onChange={value => updateDraft('security_status', value)} />
                  <StatusSelect label={tr('workflow.review.tradingStatus')} value={String(draft.security_trading_status || 'unknown')} options={['unknown', 'trading', 'suspended', 'halted']} onChange={value => updateDraft('security_trading_status', value)} />
                  <Field label={tr('workflow.review.source')} value={String(draft.security_source || '')} onChange={value => updateDraft('security_source', value)} />
                  <Field label={tr('workflow.review.evidence')} value={String(draft.security_evidence || '')} onChange={value => updateDraft('security_evidence', value)} />
                  <Field label={tr('workflow.review.evidenceUrl')} value={String(draft.security_evidence_url || '')} onChange={value => updateDraft('security_evidence_url', value)} />
                  <div className="grid grid-cols-2 gap-2">
                    <Field type="date" label={tr('workflow.review.checkedAt')} value={String(draft.security_checked_at || '').slice(0, 10)} onChange={value => updateDraft('security_checked_at', value)} />
                    <Field type="date" label={tr('workflow.review.validUntil')} value={String(draft.security_valid_until || '').slice(0, 10)} onChange={value => updateDraft('security_valid_until', value)} />
                  </div>
                  <Field label={tr('workflow.review.effectiveAt')} value={String(draft.security_effective_at || '')} onChange={value => updateDraft('security_effective_at', value)} />
                  <Field label={tr('workflow.review.version')} value={String(draft.security_version || '')} onChange={value => updateDraft('security_version', value)} />
                </div>
                <div className="space-y-3 rounded-xl border border-border/60 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{tr('workflow.review.financial')}</h3>
                    <Button size="sm" variant="outline" disabled={financialFetchBusy || savingReview} onClick={() => void fetchFinancialPrefill()}>
                      <Download className="mr-1.5 h-3.5 w-3.5" />{financialFetchBusy ? tr('workflow.review.prefillLoading') : tr('workflow.review.prefill')}
                    </Button>
                  </div>
                  <p className="text-[10px] leading-4 text-muted-foreground">{tr('workflow.review.prefillHelp')}</p>
                  <StatusSelect label={tr('workflow.review.financialStatus')} value={String(draft.financial_status || 'pending')} options={['pending', 'passed', 'needs_review', 'rejected']} onChange={value => updateDraft('financial_status', value)} />
                  <Field label={tr('workflow.review.source')} value={String(draft.financial_source || '')} onChange={value => updateDraft('financial_source', value)} />
                  <Field label={tr('workflow.review.evidence')} value={String(draft.financial_evidence || '')} onChange={value => updateDraft('financial_evidence', value)} />
                  <Field label={tr('workflow.review.evidenceUrl')} value={String(draft.financial_evidence_url || '')} onChange={value => updateDraft('financial_evidence_url', value)} />
                  <label className="block text-[11px] font-medium text-muted-foreground">{tr('workflow.review.financialJson')}</label>
                  <textarea value={financialJson} onChange={event => setFinancialJson(event.target.value)} className="scrollbar min-h-48 w-full rounded-xl border border-border bg-card p-3 font-mono text-[11px] leading-5 focus:outline-none focus:ring-2 focus:ring-primary/20" spellCheck={false} />
                  <p className="text-[10px] leading-4 text-muted-foreground">{tr('workflow.review.financialHelp')}</p>
                  {financialWarnings.length > 0 && <ul role="status" aria-live="polite" className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[10px] leading-4 text-muted-foreground">{financialWarnings.map((warning, index) => <li key={`${index}-${warning}`} className="break-words">• {warning}</li>)}</ul>}
                </div>
                <div className="space-y-3 rounded-xl border border-border/60 p-4">
                  <h3 className="text-sm font-semibold">{tr('workflow.review.events')}</h3>
                  <StatusSelect label={tr('workflow.review.eventStatus')} value={String(draft.event_status || 'pending')} options={['pending', 'clear', 'risk', 'unknown']} onChange={value => updateDraft('event_status', value)} />
                  <Field label={tr('workflow.review.category')} value={String(draft.event_category || '')} onChange={value => updateDraft('event_category', value)} />
                  <Field label={tr('workflow.review.source')} value={String(draft.event_source || '')} onChange={value => updateDraft('event_source', value)} />
                  <Field label={tr('workflow.review.evidence')} value={String(draft.event_evidence || '')} onChange={value => updateDraft('event_evidence', value)} />
                  <Field label={tr('workflow.review.evidenceUrl')} value={String(draft.event_evidence_url || '')} onChange={value => updateDraft('event_evidence_url', value)} />
                  <div className="grid grid-cols-2 gap-2">
                    <Field type="date" label={tr('workflow.review.checkedAt')} value={String(draft.event_checked_at || '').slice(0, 10)} onChange={value => updateDraft('event_checked_at', value)} />
                    <Field type="date" label={tr('workflow.review.validUntil')} value={String(draft.event_valid_until || '').slice(0, 10)} onChange={value => updateDraft('event_valid_until', value)} />
                  </div>
                </div>
              </div>
              <Field label={tr('workflow.review.note')} value={String(draft.review_note || '')} onChange={value => updateDraft('review_note', value)} />
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={savingReview || autoVerifyBusy} onClick={() => void saveReview('pending')}>{tr('workflow.review.save')}</Button>
                <Button disabled={savingReview || autoVerifyBusy} onClick={() => void saveReview('approve')}><Check className="mr-1.5 h-4 w-4" />{tr('workflow.review.approve')}</Button>
                <Button variant="outline" disabled={savingReview || autoVerifyBusy} onClick={() => void saveReview('hold')}>{tr('workflow.review.hold')}</Button>
                <Button variant="destructive" disabled={savingReview || autoVerifyBusy} onClick={() => void saveReview('reject')}>{tr('workflow.review.reject')}</Button>
                <span className="self-center text-[10px] text-muted-foreground">{tr('workflow.review.audit', { count: review.history?.length || 0 })}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {panel === 'ai' && (
        <div className="space-y-4 p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-base font-semibold">{tr('workflow.ai.title')}</h2><p className="mt-1 text-xs font-medium">{tr('workflow.ai.selectedScope', { count: candidates.length })}</p><p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{tr('workflow.ai.description')}</p></div>
            <Button onClick={() => void generateReport()} disabled={reportLoading || Boolean(pendingReport) || !snapshotId || candidates.length === 0}>{tr('workflow.ai.generate')}</Button>
          </div>
          {scopedReports.length === 0 ? <Empty text={tr(snapshotId ? 'workflow.ai.empty' : 'workflow.ai.noSnapshot')} /> : scopedReports.map(report => {
            const candidateScores = candidateScoreRows(report.report || {}).sort((a, b) => {
              const totalA = scoreNumber(a, 'total_score')
              const totalB = scoreNumber(b, 'total_score')
              if (totalA != null || totalB != null) return (totalB ?? -1) - (totalA ?? -1)
              const available = (score: CandidateAIScore) => SCORE_DIMENSIONS.reduce((sum, dimension) => {
                const value = scoreNumber(score, dimension.key)
                return value == null ? sum : { score: sum.score + value, max: sum.max + dimension.cap }
              }, { score: 0, max: 0 })
              const partialA = available(a)
              const partialB = available(b)
              return partialA.max === partialB.max ? partialB.score - partialA.score : 0
            })
            const isPending = report.status === 'queued' || report.status === 'running'
            return (
            <article key={report.report_id} className="space-y-3 rounded-xl border border-border/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><strong>{report.status} · {report.model_label || tr('workflow.ai.modelPending')}</strong><span className="text-muted-foreground">{report.created_at}</span></div>
              <p className="text-[11px] text-muted-foreground">{tr('workflow.ai.validity')}: {report.validation_status} · {report.input_symbols.length} {tr('workflow.ai.candidates')}</p>
              {report.validation_errors.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">{report.validation_errors.slice(0, 12).map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}</ul>}
              {report.error_message && <p className="text-xs text-destructive">{report.error_message}</p>}
              {candidateScores.length > 0 ? (
                <section className="space-y-3 rounded-lg bg-accent/20 p-3" aria-label={tr('workflow.ai.scoreTitle')}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold">{tr('workflow.ai.scoreTitle')}</h3>
                    <span className="text-[10px] text-muted-foreground">{tr('workflow.ai.scoreDisclaimer')}</span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {candidateScores.map((score, index) => {
                      const total = scoreNumber(score, 'total_score')
                      const symbol = readableValue(score.symbol) || '—'
                      const name = readableValue(score.name)
                      const action = readableValue(score.action)
                      const rationale = readableValue(score.rationale)
                      const evidence = readableValue(score.evidence)
                      const financialQualityStatus = readableValue(score.financial_quality_status)
                      const financialQualityMissing = Array.isArray(score.financial_quality_missing) ? score.financial_quality_missing.map(readableValue).filter(Boolean).join('、') : ''
                      const knownParts = SCORE_DIMENSIONS.filter(dimension => scoreNumber(score, dimension.key) != null)
                      const knownScore = knownParts.reduce((sum, dimension) => sum + (scoreNumber(score, dimension.key) || 0), 0)
                      const knownMax = knownParts.reduce((sum, dimension) => sum + dimension.cap, 0)
                      return (
                        <article key={`${symbol}-${index}`} className="space-y-2 rounded-lg border border-border/60 bg-background p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-baseline gap-2"><strong className="truncate text-sm">{name || symbol}</strong>{name && <span className="shrink-0 text-[11px] text-muted-foreground">{symbol}</span>}</div>
                            <span className="rounded-full bg-accent px-2 py-1 text-[10px]">{tr(`workflow.ai.actions.${action}`, { defaultValue: action || '—' })}</span>
                          </div>
                          <div className="flex items-baseline justify-between"><span className="text-[11px] text-muted-foreground">{tr(financialQualityStatus === 'provisional' || financialQualityStatus === 'single_source_estimate' ? 'workflow.ai.totalProvisional' : 'workflow.ai.total')}</span><strong className="text-lg tabular-nums">{total == null ? '—' : total.toFixed(1)}<span className="text-[10px] font-normal text-muted-foreground"> / 100</span></strong></div>
                          {total == null && <p className="text-[10px] text-muted-foreground">{tr('workflow.ai.partialScore', { score: knownScore.toFixed(1), max: knownMax })}</p>}
                          <div className="space-y-1.5">
                            {SCORE_DIMENSIONS.map(dimension => {
                              const value = scoreNumber(score, dimension.key)
                              const barWidth = value == null ? 0 : Math.min(100, Math.max(0, (value / dimension.cap) * 100))
                              return (
                                <div key={dimension.key} className="space-y-1">
                                  <div className="flex justify-between gap-2 text-[10px]"><span className="text-muted-foreground">{tr(`workflow.ai.dimensions.${dimension.label}`)}</span><span className="tabular-nums">{value == null ? '—' : value.toFixed(1)} / {dimension.cap}</span></div>
                                  <div role="progressbar" aria-label={tr(`workflow.ai.dimensions.${dimension.label}`)} aria-valuemin={0} aria-valuemax={dimension.cap} aria-valuenow={value == null ? 0 : Math.min(dimension.cap, Math.max(0, value))} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${barWidth}%` }} /></div>
                                  {dimension.key === 'earnings_score' && financialQualityStatus !== 'verified' && <p className="text-[10px] leading-4 text-muted-foreground">{tr(`workflow.ai.financialStatuses.${financialQualityStatus}`, { defaultValue: tr('workflow.ai.financialQualityPending') })}{financialQualityMissing ? ` · ${financialQualityMissing}` : ''}</p>}
                                </div>
                              )
                            })}
                          </div>
                          {rationale && <p className="text-[11px] leading-4"><span className="font-medium">{tr('workflow.ai.rationale')}：</span>{rationale}</p>}
                          {evidence && <p className="text-[10px] leading-4 text-muted-foreground"><span className="font-medium">{tr('workflow.ai.evidence')}：</span>{evidence}</p>}
                        </article>
                      )
                    })}
                  </div>
                </section>
              ) : isPending ? (
                <p className="rounded-lg bg-accent/20 p-3 text-xs text-muted-foreground">{tr('workflow.ai.scorePending')}</p>
              ) : (
                <p className="rounded-lg bg-accent/20 p-3 text-xs text-muted-foreground">{tr('workflow.ai.scoreEmpty')}</p>
              )}
              {report.report && <details className="rounded-lg border border-border/60"><summary className="cursor-pointer px-3 py-2 text-xs font-medium">{tr('workflow.ai.rawReport')}</summary><pre className="scrollbar max-h-[480px] overflow-auto border-t border-border/60 bg-accent/35 p-3 text-[10px] leading-5">{JSON.stringify(report.report, null, 2)}</pre></details>}
            </article>
          )})}
        </div>
      )}

      {panel === 'plans' && (
        <div className="space-y-4 p-4 sm:p-6">
          <div><h2 className="text-base font-semibold">{tr('workflow.plan.title')}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{tr('workflow.plan.description')}</p></div>
          {selectedCandidate && (
            <div className="grid gap-3 rounded-xl border border-border/60 p-4 md:grid-cols-4">
              <div className="self-center text-sm font-semibold">{selectedCandidate.symbol} {selectedCandidate.name}<div className="mt-1 text-[10px] text-muted-foreground">{tr('workflow.plan.entryBand')}: {((selectedCandidate.signal_close || 0) * 0.99).toFixed(2)}–{((selectedCandidate.signal_close || 0) * 1.01).toFixed(2)} · +3%</div></div>
              <Field type="number" label={tr('workflow.plan.budget')} value={planBudget} onChange={setPlanBudget} />
              <Field type="number" label={tr('workflow.plan.quantity')} value={planQuantity} onChange={setPlanQuantity} />
              <Field type="date" label={tr('workflow.plan.validUntil')} value={planValidUntil} onChange={setPlanValidUntil} />
              <Button className="md:col-span-4 md:justify-self-end" disabled={busy} onClick={() => void createPlan()}>{tr('workflow.plan.create')}</Button>
            </div>
          )}
          {plans.length === 0 ? <Empty text={tr('workflow.plan.empty')} /> : <div className="scrollbar overflow-auto rounded-xl border border-border/60"><table className="w-full min-w-[760px] text-left text-xs"><thead className="bg-accent/40 text-muted-foreground"><tr>{['symbol','status','entry','target','budget','valid'].map(key => <th key={key} className="px-3 py-2 font-medium">{tr(`workflow.plan.columns.${key}`)}</th>)}<th className="px-3 py-2" /></tr></thead><tbody>{plans.map(plan => <tr key={plan.id} className="border-t border-border/50"><td className="px-3 py-2">{plan.symbol} {plan.name}</td><td className="px-3 py-2">{plan.status}</td><td className="px-3 py-2">{plan.entry_low.toFixed(2)}–{plan.entry_high.toFixed(2)}</td><td className="px-3 py-2">{plan.target_price?.toFixed(2) || '—'}</td><td className="px-3 py-2">{plan.budget ?? plan.quantity ?? '—'}</td><td className="px-3 py-2">{plan.valid_until || '—'}</td><td className="flex gap-1 px-3 py-2">{plan.status === 'pending_review' && <Button size="sm" variant="outline" onClick={() => void approvePlan(plan)}>{tr('workflow.plan.approve')}</Button>}{!['filled','cancelled','expired'].includes(plan.status) && <Button size="sm" variant="ghost" onClick={() => void cancelPlan(plan)}>{tr('workflow.plan.cancel')}</Button>}</td></tr>)}</tbody></table></div>}
        </div>
      )}

      {panel === 'simulation' && (
        <div className="space-y-4 p-4 sm:p-6">
          <div><h2 className="text-base font-semibold">{tr('workflow.simulation.title')}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{tr('workflow.simulation.description')}</p></div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <Field label={tr('workflow.simulation.name')} value={accountForm.name} onChange={value => setAccountForm(v => ({ ...v, name: value }))} />
            <Field type="number" label={tr('workflow.simulation.startingCash')} value={accountForm.starting_cash} onChange={value => setAccountForm(v => ({ ...v, starting_cash: value }))} />
            <Field type="number" label={tr('workflow.simulation.commissionRate')} value={accountForm.commission_rate} onChange={value => setAccountForm(v => ({ ...v, commission_rate: value }))} />
            <Field type="number" label={tr('workflow.simulation.minimumCommission')} value={accountForm.minimum_commission} onChange={value => setAccountForm(v => ({ ...v, minimum_commission: value }))} />
            <Field type="number" label={tr('workflow.simulation.stampTaxRate')} value={accountForm.stamp_tax_rate} onChange={value => setAccountForm(v => ({ ...v, stamp_tax_rate: value }))} />
            <Field type="number" label={tr('workflow.simulation.transferRate')} value={accountForm.transfer_fee_rate} onChange={value => setAccountForm(v => ({ ...v, transfer_fee_rate: value }))} />
          </div>
          <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void createAccount()}>{tr('workflow.simulation.createAccount')}</Button><Select value={accountId || 'none'} onValueChange={value => setAccountId(value === 'none' ? '' : value)}><SelectTrigger aria-label={tr('workflow.simulation.selectAccount')} className="w-full max-w-lg"><SelectValue placeholder={tr('workflow.simulation.selectAccount')} /></SelectTrigger><SelectContent><SelectItem value="none">{tr('workflow.simulation.selectAccount')}</SelectItem>{accounts.map(account => <SelectItem key={account.id} value={account.id}>{account.name} · {account.id.slice(0, 8)}</SelectItem>)}</SelectContent></Select></div>
          {accounts.length === 0 ? <Empty text={tr('workflow.simulation.empty')} /> : (
            <div className="space-y-3 rounded-xl border border-border/60 p-4">
              <div className="text-xs font-semibold">{tr('workflow.simulation.availablePlans')}</div>
              {plans.filter(plan => plan.status === 'approved').length === 0 ? <p className="text-xs text-muted-foreground">{tr('workflow.simulation.noApprovedPlans')}</p> : plans.filter(plan => plan.status === 'approved').map(plan => <label key={plan.id} className="flex items-start gap-2 rounded-lg bg-accent/35 px-3 py-2 text-xs"><input type="checkbox" checked={selectedPlanIds.includes(plan.id)} onChange={event => setSelectedPlanIds(ids => event.target.checked ? [...ids, plan.id] : ids.filter(id => id !== plan.id))} />{plan.symbol} {plan.name} · {plan.status} · {plan.valid_until}</label>)}
              <div className="text-xs font-semibold">{tr('workflow.simulation.accounts')}</div>
              {accounts.map(account => <div key={account.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-accent/35 px-3 py-2 text-xs"><span>{account.name} · {account.status} · {account.open_positions} {tr('workflow.simulation.positions')} · {account.cash.toFixed(2)}</span><Button size="sm" variant="outline" onClick={() => void toggleAccountStatus(account)}>{tr(`workflow.simulation.${account.status === 'active' ? 'pause' : 'resume'}`)}</Button></div>)}
              <p className="text-[10px] text-muted-foreground">{tr('workflow.simulation.planSelection')}</p>
              <Button disabled={!accountId || !selectedPlanIds.length || busy} onClick={() => void runSimulation()}>{tr('workflow.simulation.run')}</Button>
            </div>
          )}
          {accountDetails && <pre className="scrollbar max-h-[420px] overflow-auto rounded-xl bg-accent/35 p-3 text-[10px] leading-5">{JSON.stringify(accountDetails, null, 2)}</pre>}
        </div>
      )}

      {panel === 'backtest' && (
        <div className="space-y-4 p-4 sm:p-6">
          <div><h2 className="text-base font-semibold">{tr('workflow.backtest.title')}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{tr('workflow.backtest.description')}</p></div>
          <div className="space-y-3 rounded-xl border border-border/60 p-4">
            <div><h3 className="text-sm font-semibold">{tr('workflow.coverage.title')}</h3><p className="mt-1 text-[11px] leading-5 text-muted-foreground">{tr('workflow.coverage.description')}</p></div>
            {snapshot ? <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <Field type="number" label={tr('workflow.coverage.expectedTotal')} value={coverageForm.expected_total} onChange={value => setCoverageForm(form => ({ ...form, expected_total: value }))} />
                <Field type="date" label={tr('workflow.coverage.asOf')} value={coverageForm.as_of} onChange={value => setCoverageForm(form => ({ ...form, as_of: value }))} />
                <Field label={tr('workflow.coverage.source')} value={coverageForm.source} onChange={value => setCoverageForm(form => ({ ...form, source: value }))} />
                <Field label={tr('workflow.coverage.url')} value={coverageForm.evidence_url} onChange={value => setCoverageForm(form => ({ ...form, evidence_url: value }))} />
                <label className="block text-[11px] font-medium text-muted-foreground sm:col-span-2">{tr('workflow.coverage.evidence')}<textarea value={coverageForm.evidence} onChange={event => setCoverageForm(form => ({ ...form, evidence: event.target.value }))} className="scrollbar mt-1 min-h-20 w-full rounded-xl border border-border bg-card p-3 text-xs leading-5 focus:outline-none focus:ring-2 focus:ring-primary/20" /></label>
              </div>
              {snapshot.coverage_status === 'verified' && <div className="rounded-lg bg-accent/40 px-3 py-2 text-[11px] leading-5">{tr('workflow.coverage.current', { total: snapshot.coverage_expected_total ?? '—', date: snapshot.coverage_as_of || '—', source: snapshot.coverage_source || '—', checked: snapshot.coverage_checked_at || '—', actor: snapshot.coverage_checked_by || '—' })}<br /><a className="break-all text-primary underline" href={snapshot.coverage_evidence_url} target="_blank" rel="noreferrer">{snapshot.coverage_evidence_url}</a></div>}
              <Button disabled={coverageBusy || snapshot.coverage_status === 'verified' || !['partial', 'succeeded'].includes(snapshot.status)} onClick={() => void verifyCoverage()}>{coverageBusy ? tr('workflow.coverage.saving') : tr('workflow.coverage.verify')}</Button>
            </> : <Empty text={tr('workflow.coverage.noSnapshot')} />}
          </div>
          <label className="block text-xs font-medium text-muted-foreground">{tr('workflow.backtest.selectSnapshots')}</label>
          <div className="scrollbar max-h-56 overflow-y-auto rounded-xl border border-border/60 p-2">
            {backtestSnapshots.filter(item => item.status === 'succeeded' && item.coverage_status === 'verified').length === 0 ? <Empty text={tr('workflow.backtest.noEligibleSnapshots')} /> : backtestSnapshots.filter(item => item.status === 'succeeded' && item.coverage_status === 'verified').map(item => <label key={item.snapshot_id} className="flex items-start gap-2 border-b border-border/40 px-2 py-2 text-[11px] last:border-0"><input type="checkbox" checked={selectedBacktestIds.includes(item.snapshot_id)} onChange={event => setSelectedBacktestIds(ids => event.target.checked ? [...ids, item.snapshot_id] : ids.filter(id => id !== item.snapshot_id))} /><span>{item.signal_date} · {item.snapshot_id}<span className="block text-muted-foreground">{tr('workflow.backtest.universeEvidence', { total: item.coverage_expected_total ?? '—', source: item.coverage_source || '—', checkedBy: item.coverage_checked_by || '—' })}</span></span></label>)}
          </div>
          <label className="block text-xs font-medium text-muted-foreground">{tr('workflow.backtest.snapshotIds')}</label>
          <textarea value={planIdsText} onChange={event => setPlanIdsText(event.target.value)} className="scrollbar min-h-20 w-full rounded-xl border border-border bg-card p-3 font-mono text-[11px] focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder={tr('workflow.backtest.placeholder')} />
          <Button disabled={busy} onClick={() => void checkBacktest()}>{tr('workflow.backtest.check')}</Button>
          {backtestReadiness && <div className="rounded-xl border border-border bg-accent/35 p-4 text-xs"><strong>{tr('workflow.backtest.readiness', { count: backtestReadiness.snapshot_count })}</strong>{backtestReadiness.issues.length ? <ul className="mt-2 list-disc space-y-1 pl-5">{backtestReadiness.issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : <p className="mt-2">{tr('workflow.backtest.ready')}</p>}</div>}
          {backtestReadiness?.ready && <div className="space-y-3 rounded-xl border border-border/60 p-4">
            <div><h3 className="text-sm font-semibold">{tr('workflow.backtest.configTitle')}</h3><p className="mt-1 text-[11px] text-muted-foreground">{tr('workflow.backtest.configDescription')}</p></div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Field type="number" label={tr('workflow.simulation.startingCash')} value={backtestFees.starting_cash} onChange={value => setBacktestFees(form => ({ ...form, starting_cash: value }))} />
              <Field type="number" label={tr('workflow.simulation.commissionRate')} value={backtestFees.commission_rate} onChange={value => setBacktestFees(form => ({ ...form, commission_rate: value }))} />
              <Field type="number" label={tr('workflow.simulation.minimumCommission')} value={backtestFees.minimum_commission} onChange={value => setBacktestFees(form => ({ ...form, minimum_commission: value }))} />
              <Field type="number" label={tr('workflow.simulation.stampTaxRate')} value={backtestFees.stamp_tax_rate} onChange={value => setBacktestFees(form => ({ ...form, stamp_tax_rate: value }))} />
              <Field type="number" label={tr('workflow.simulation.transferRate')} value={backtestFees.transfer_fee_rate} onChange={value => setBacktestFees(form => ({ ...form, transfer_fee_rate: value }))} />
            </div>
            <Button disabled={backtestRunning} onClick={() => void runBacktest()}>{backtestRunning ? tr('workflow.backtest.running') : tr('workflow.backtest.run')}</Button>
          </div>}
          {backtestResult && <BacktestResult run={backtestResult} tr={tr} />}
          <div className="space-y-2"><h3 className="text-sm font-semibold">{tr('workflow.backtest.historyTitle')}</h3>{backtestRuns.length === 0 ? <Empty text={tr('workflow.backtest.historyEmpty')} /> : backtestRuns.map(run => <button key={run.run_id} type="button" onClick={() => setBacktestResult(run)} className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-card px-3 py-2 text-left text-[11px] hover:bg-accent/40"><span>{run.created_at} · {run.status} · {run.snapshot_ids.length} {tr('workflow.backtest.days')}</span><span className="font-mono text-muted-foreground">{run.run_id}</span></button>)}</div>
        </div>
      )}
    </section>
  )
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return <label className="block text-[11px] font-medium text-muted-foreground">{label}<Input type={type} step={type === 'number' ? 'any' : undefined} value={value} onChange={event => onChange(event.target.value)} className="mt-1 h-9" /></label>
}

function StatusSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="block text-[11px] font-medium text-muted-foreground">{label}<Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="mt-1 h-9"><SelectValue /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></label>
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">{text}</div>
}

function BacktestResult({ run, tr }: { run: LeftSideBacktestRun; tr: (key: string, options?: Record<string, unknown>) => string }) {
  const result = run.result || {}
  const summary = (result.summary || {}) as Record<string, unknown>
  const curve = (result.equity_curve || []) as Array<Record<string, unknown>>
  const trades = (result.trades || []) as Array<Record<string, unknown>>
  const limitations = (result.limitations || []) as string[]
  return <article className="space-y-3 rounded-xl border border-border/60 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{tr('workflow.backtest.resultTitle')} · {run.status}</strong><span className="font-mono text-[10px] text-muted-foreground">{run.run_id}</span></div>
    {result.performance_valid === true ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{[
      ['total_return_pct', tr('workflow.backtest.metrics.return'), '%'], ['max_drawdown_pct', tr('workflow.backtest.metrics.drawdown'), '%'], ['realized_pnl', tr('workflow.backtest.metrics.realized'), ''], ['unrealized_pnl', tr('workflow.backtest.metrics.unrealized'), ''], ['fees', tr('workflow.backtest.metrics.fees'), ''], ['closed_trades', tr('workflow.backtest.metrics.closedTrades'), ''], ['open_positions_at_end', tr('workflow.backtest.metrics.openPositions'), ''],
    ].map(([key, label, suffix]) => <div key={key} className="rounded-lg bg-accent/35 px-3 py-2"><div className="text-[10px] text-muted-foreground">{label}</div><div className="mt-1 font-mono text-sm">{summary[key] == null ? '—' : `${summary[key]}${suffix}`}</div></div>)}</div> : <p className="rounded-lg bg-accent/40 p-3 text-xs">{String(run.error_message || tr('workflow.backtest.incomplete'))}</p>}
    {trades.length > 0 && <div className="scrollbar overflow-auto rounded-lg border border-border/50"><table className="w-full min-w-[580px] text-left text-[10px]"><thead className="bg-accent/40"><tr>{['date','symbol','side','quantity','price','fees'].map(key => <th key={key} className="px-2 py-1.5">{tr(`workflow.backtest.trade.${key}`)}</th>)}</tr></thead><tbody>{trades.map((trade, index) => <tr key={`${trade.plan_id}-${trade.side}-${trade.date}-${index}`} className="border-t border-border/40">{['date','symbol','side','quantity','price','fees'].map(key => <td key={key} className="px-2 py-1.5">{String(trade[key] ?? '—')}</td>)}</tr>)}</tbody></table></div>}
    {curve.length > 0 && <details><summary className="cursor-pointer text-[11px] text-muted-foreground">{tr('workflow.backtest.equityCurve', { count: curve.length })}</summary><pre className="scrollbar mt-2 max-h-40 overflow-auto rounded-lg bg-accent/35 p-3 text-[10px] leading-4">{JSON.stringify(curve, null, 2)}</pre></details>}
    {limitations.length > 0 && <ul className="list-disc space-y-1 pl-5 text-[10px] leading-4 text-muted-foreground">{limitations.map(item => <li key={item}>{item}</li>)}</ul>}
  </article>
}
