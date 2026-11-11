import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, Clock3, Database, LineChart, RefreshCw, ShieldAlert } from 'lucide-react'
import { leftSideApi, type LeftSideBoard, type LeftSideRankingItem, type LeftSideSnapshot, type LeftSideStatusResponse } from '@panwatch/api'
import { Button } from '@panwatch/base-ui/components/ui/button'
import LeftSideOperations from './LeftSideOperations'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '@panwatch/base-ui/components/ui/confirm-dialog'
import { useToast } from '@panwatch/base-ui/components/ui/toast'

const PAGE_SIZE = 30
const BOARD_GROUPS: Array<{ key: 'low' | 'drawdown'; boards: LeftSideBoard[] }> = [
  { key: 'low', boards: ['low_composite', 'low_60', 'low_250', 'low_1000'] },
  { key: 'drawdown', boards: ['drawdown_10', 'drawdown_30', 'drawdown_90'] },
]

function fmt(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '--'
  return value.toFixed(digits)
}

function progressOf(snapshot: LeftSideSnapshot | null): number {
  if (!snapshot) return 0
  if (snapshot.status === 'succeeded' || snapshot.status === 'partial') return 100
  if (snapshot.status === 'failed') return 0
  if (snapshot.phase === 'fundamentals' && snapshot.universe_total > 0) {
    return Math.min(45, Math.round(snapshot.fundamentals_checked / snapshot.universe_total * 45))
  }
  if (snapshot.phase === 'history' && snapshot.pe_passed > 0) {
    return 45 + Math.min(50, Math.round(snapshot.history_checked / snapshot.pe_passed * 50))
  }
  return snapshot.status === 'running' ? 5 : 0
}

export default function LeftSideStrategyPage() {
  const { t } = useTranslation('leftSide')
  const confirmAction = useConfirm()
  const { toast } = useToast()
  const tr = t as unknown as (key: string, options?: Record<string, unknown>) => string
  const [status, setStatus] = useState<LeftSideStatusResponse | null>(null)
  const [snapshots, setSnapshots] = useState<LeftSideSnapshot[]>([])
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('')
  const [board, setBoard] = useState<LeftSideBoard>('low_composite')
  const [offset, setOffset] = useState(0)
  const [items, setItems] = useState<LeftSideRankingItem[]>([])
  const [total, setTotal] = useState(0)
  const [riskExclusions, setRiskExclusions] = useState<Array<{ symbol: string; name: string; reasons: string[] }>>([])
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [loadingRows, setLoadingRows] = useState(false)
  const [statusError, setStatusError] = useState('')
  const [rowsError, setRowsError] = useState('')
  const [selectedCandidate, setSelectedCandidate] = useState<LeftSideRankingItem | null>(null)

  const refreshStatus = useCallback(async () => {
    try {
      const [next, history] = await Promise.all([leftSideApi.status(), leftSideApi.snapshots()])
      setStatus(next)
      setSnapshots(history.items || [])
      setSelectedSnapshotId(current => current || next.latest_completed?.snapshot_id || '')
      setStatusError('')
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : tr('failed'))
    }
  }, [tr])

  useEffect(() => {
    void refreshStatus()
    const timer = window.setInterval(() => { void refreshStatus() }, 4000)
    return () => window.clearInterval(timer)
  }, [refreshStatus])

  const snapshotId = selectedSnapshotId || status?.latest_completed?.snapshot_id || ''
  useEffect(() => {
    let active = true
    if (!snapshotId) {
      setItems([])
      setTotal(0)
      setLoadingRows(false)
      return () => { active = false }
    }
    setLoadingRows(true)
    setRowsError('')
    leftSideApi.rankings(board, snapshotId, offset, PAGE_SIZE)
      .then(result => {
        if (!active) return
        setItems(result.items || [])
        setTotal(result.total || 0)
        setRiskExclusions(result.risk_exclusions || [])
        setSelectedCandidate(current => current ? (result.items || []).find(item => item.symbol === current.symbol) || null : null)
      })
      .catch(error => {
        if (!active) return
        setRowsError(error instanceof Error ? error.message : tr('failed'))
      })
      .finally(() => { if (active) setLoadingRows(false) })
    return () => { active = false }
  }, [board, offset, snapshotId, tr])

  useEffect(() => { setSelectedCandidate(null) }, [snapshotId])

  const current = status?.current || null
  const isRunning = current?.status === 'queued' || current?.status === 'running'
  const busy = starting || isRunning
  const selectedSnapshot = snapshots.find(snapshot => snapshot.snapshot_id === snapshotId) || status?.latest_completed || null
  const activeSnapshot = isRunning ? current : selectedSnapshot || current
  const progress = progressOf(current)
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const isDrawdown = board.startsWith('drawdown')
  const boardTitle = useMemo(() => tr(`boards.${board}`), [board, tr])

  const startRefresh = async () => {
    setStarting(true)
    setStatusError('')
    try {
      await leftSideApi.refresh()
      await refreshStatus()
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : tr('failed'))
    } finally {
      setStarting(false)
    }
  }

  const cancelRefresh = async () => {
    if (!current?.snapshot_id || !(await confirmAction(tr('cancelConfirm'), { destructive: true }))) return
    setCancelling(true)
    try {
      await leftSideApi.cancel(current.snapshot_id)
      await refreshStatus()
      toast(tr('cancelled'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('failed'), 'error')
    } finally { setCancelling(false) }
  }

  const selectBoard = (next: LeftSideBoard) => {
    setBoard(next)
    setOffset(0)
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-5 pb-8">
      <section className="relative overflow-hidden rounded-[1.6rem] border border-[#31534c] bg-[#122421] px-5 py-6 text-white shadow-[0_22px_60px_-38px_rgba(12,48,41,0.85)] sm:px-7 lg:px-9">
        <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full border border-emerald-200/10" />
        <div className="pointer-events-none absolute -right-2 -top-10 h-52 w-52 rounded-full border border-emerald-200/10" />
        <div className="relative flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl">
            <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-200/70">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
              {tr('brand')}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{tr('title')}</h1>
            <p className="mt-2 text-sm text-emerald-50/65">{tr('subtitle')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {activeSnapshot && (
              <div className="rounded-xl border border-white/10 bg-white/[0.06] px-3.5 py-2.5">
                <div className="text-[10px] uppercase tracking-[0.15em] text-emerald-50/50">{tr('currentDate')}</div>
                <div className="mt-1 font-mono text-sm text-white">{activeSnapshot.signal_date || '—'}</div>
              </div>
            )}
            <Select value={snapshotId || 'none'} onValueChange={value => setSelectedSnapshotId(value === 'none' ? '' : value)}>
              <SelectTrigger aria-label={tr('historySnapshot')} className="h-11 w-full min-w-[220px] border-white/15 bg-white/[0.06] text-white sm:w-auto">
                <SelectValue placeholder={tr('historySnapshot')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{tr('historySnapshot')}</SelectItem>
                {snapshots.map(item => <SelectItem key={item.snapshot_id} value={item.snapshot_id}>{item.signal_date || tr(`phases.${item.phase}`)} · {tr(`status.${item.status}`)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button onClick={startRefresh} disabled={busy} className="h-11 rounded-xl bg-emerald-300 px-4 text-sm font-semibold text-[#10221e] hover:bg-emerald-200">
              <RefreshCw className={`mr-2 h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
              {busy ? tr('refreshing') : tr('refresh')}
            </Button>
            {isRunning && <Button variant="outline" onClick={() => void cancelRefresh()} disabled={cancelling} className="h-11 border-white/20 bg-transparent text-white hover:bg-white/10">{cancelling ? tr('cancelling') : tr('cancelTask')}</Button>}
          </div>
        </div>
        {isRunning && (
          <div className="relative mt-6 max-w-2xl">
            <div className="mb-2 flex items-center justify-between text-xs text-emerald-50/70">
              <span>{tr(`phases.${current?.phase || 'queued'}`)}</span>
              <span className="font-mono">{progress}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-emerald-300 transition-all duration-500" style={{ width: `${progress}%` }} />
            </div>
            <div className="mt-2 text-xs text-emerald-50/55">{current?.message}</div>
          </div>
        )}
      </section>

      <section className="flex gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.07] p-4 sm:p-5">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
        <div>
          <div className="text-sm font-semibold text-foreground">{tr('riskTitle')}</div>
          <p className="mt-1.5 max-w-5xl text-xs leading-5 text-muted-foreground">{tr('riskDescription')}</p>
        </div>
      </section>

      {statusError && (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />{statusError}
        </div>
      )}

      {activeSnapshot && (
        <>
        <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[
            { label: tr('universe'), value: activeSnapshot.universe_total, icon: Database, detail: `${activeSnapshot.excluded_st_count} ${tr('stExcluded')}` },
            { label: tr('pePassed'), value: activeSnapshot.pe_passed, icon: CheckCircle2, detail: `${activeSnapshot.fundamentals_checked} ${tr('fundamentals_checked')}` },
            { label: tr('historyReady'), value: activeSnapshot.history_passed, icon: LineChart, detail: `${activeSnapshot.history_checked} ${tr('history_checked')}` },
            { label: tr('riskPending'), value: activeSnapshot.risk_pending_count, icon: ShieldAlert, detail: activeSnapshot.status === 'partial' ? tr('status.partial') : tr('pending') },
          ].map(({ label, value, icon: Icon, detail }) => (
            <div key={label} className="card min-h-[116px] p-4 sm:p-5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{label}</span><Icon className="h-4 w-4 opacity-60" />
              </div>
              <div className="mt-3 flex items-end justify-between gap-2">
                <span className="font-mono text-2xl font-semibold tracking-tight">{Number(value || 0).toLocaleString()}</span>
                <span className="truncate text-right text-[10px] text-muted-foreground/75">{detail}</span>
              </div>
            </div>
          ))}
        </section>
        <div className="text-[10px] leading-4 text-muted-foreground">{tr('universeStatus', { observedAt: activeSnapshot.universe_observed_at || '—', age: activeSnapshot.universe_age_seconds == null ? '—' : Math.floor(activeSnapshot.universe_age_seconds / 3600), source: activeSnapshot.universe_source || '—', coverage: activeSnapshot.coverage_status || 'unverified' })}</div>
        </>
      )}

      {current?.status === 'failed' && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div><div className="font-medium">{tr('failed')}</div><div className="mt-1 text-xs opacity-80">{current.error_message || current.message}</div></div>
        </div>
      )}

      <section className="card overflow-hidden">
        <div className="border-b border-border/60 px-4 pt-4 sm:px-6 sm:pt-5">
          {BOARD_GROUPS.map(group => (
            <div key={group.key} className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="w-24 shrink-0 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">{tr(`groups.${group.key}`)}</div>
              <div className="flex flex-wrap gap-1.5">
                {group.boards.map(key => {
                  const selected = board === key
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => selectBoard(key)}
                      className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${selected ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-accent/50 text-muted-foreground hover:bg-accent hover:text-foreground'}`}
                    >
                      {tr(`boards.${key}`)}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-6">
          <div>
            <h2 className="text-base font-semibold">{boardTitle}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {status?.latest_completed?.signal_date ? `${status.latest_completed.signal_date} · ` : ''}
              {total.toLocaleString()} {tr('items')}
            </p>
          </div>
          {activeSnapshot && <div className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400"><Clock3 className="h-3.5 w-3.5" />{tr('pending')}</div>}
        </div>

        <div className="px-4 pb-4 text-xs text-muted-foreground sm:px-6">
          <p>{tr('riskFilterHint')}</p>
          {riskExclusions.length > 0 && <details className="mt-2 rounded-lg border border-border/60 p-3">
            <summary className="cursor-pointer">{tr('riskFilterCount', { count: riskExclusions.length })}</summary>
            <ul className="mt-2 space-y-1">{riskExclusions.map(item => <li key={item.symbol}>{item.symbol} {item.name} · {item.reasons.join('；')}</li>)}</ul>
          </details>}
        </div>
        {!status?.latest_completed && !isRunning ? (
          <div className="mx-4 mb-5 rounded-2xl border border-dashed border-border p-8 text-center sm:mx-6">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Activity className="h-5 w-5" /></div>
            <h3 className="mt-4 text-sm font-semibold">{tr('noSnapshot')}</h3>
            <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-muted-foreground">{tr('noSnapshotHint')}</p>
            <Button onClick={startRefresh} disabled={busy} className="mt-5" size="sm">{tr('refresh')}</Button>
          </div>
        ) : rowsError ? (
          <div className="px-6 pb-6 text-sm text-destructive">{rowsError}</div>
        ) : loadingRows ? (
          <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" />{tr('loading')}</div>
        ) : items.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <div className="text-sm font-medium">{isRunning ? current?.message : tr('emptyBoard')}</div>
            {!isRunning && <p className="mt-1 text-xs text-muted-foreground">{tr('emptyBoardHint')}</p>}
          </div>
        ) : (
          <div className="scrollbar overflow-x-auto border-t border-border/50">
            <table className="w-full min-w-[900px] border-collapse text-left text-xs">
              <thead className="bg-accent/35 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium sm:px-6">{tr('columns.rank')}</th>
                  <th className="px-4 py-3 font-medium">{tr('columns.stock')}</th>
                  <th className="px-4 py-3 text-right font-medium">{tr('columns.close')}</th>
                  <th className="px-4 py-3 text-right font-medium">{tr('columns.pe')}</th>
                  {!isDrawdown && <th className="px-4 py-3 text-right font-medium">{tr('columns.low60')}</th>}
                  {!isDrawdown && <th className="px-4 py-3 text-right font-medium">{tr('columns.low250')}</th>}
                  {!isDrawdown && board === 'low_1000' && <th className="px-4 py-3 text-right font-medium">{tr('columns.low1000')}</th>}
                  {board === 'low_composite' && <th className="px-4 py-3 text-right font-medium">{tr('columns.score')}</th>}
                  {isDrawdown && <th className="px-4 py-3 text-right font-medium">{tr('columns.drawdown')}</th>}
                  <th className="px-4 py-3 font-medium">{tr('columns.sample')}</th>
                  <th className="px-4 py-3 font-medium">{tr('columns.risk')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {items.map(item => {
                  const drawdownValue = board === 'drawdown_10' ? item.drawdown_10 : board === 'drawdown_30' ? item.drawdown_30 : item.drawdown_90
                  const selectedLow = board === 'low_60' ? item.low_60 : board === 'low_250' ? item.low_250 : item.low_1000
                  return (
                    <tr key={item.symbol} className="transition-colors hover:bg-accent/20">
                      <td className="px-4 py-3.5 font-mono text-muted-foreground sm:px-6">{String(item.rank).padStart(2, '0')}</td>
                      <td className="px-4 py-3.5">
                        <div className="font-semibold text-foreground">{item.name}</div>
                        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{item.symbol}</div>
                      </td>
                      <td className="px-4 py-3.5 text-right font-mono">{fmt(item.signal_close, 2)}</td>
                      <td className="px-4 py-3.5 text-right font-mono" title={`${tr('peObserved')}: ${item.pe_observed_at || '—'} · ${tr('peProvider')}: ${item.pe_source || '—'}`}>
                        <div>{fmt(item.pe_ttm, 2)}</div>
                        <div className="mt-0.5 text-[9px] text-muted-foreground">{item.pe_observed_at ? item.pe_observed_at.replace('T', ' ').slice(0, 16) : '—'}</div>
                        <div className="mt-0.5 text-[9px] text-muted-foreground">{item.pe_source || '—'}</div>
                      </td>
                      {!isDrawdown && <td className="px-4 py-3.5 text-right font-mono">{board === 'low_60' ? fmt(selectedLow) : fmt(item.low_60)}</td>}
                      {!isDrawdown && <td className="px-4 py-3.5 text-right font-mono">{board === 'low_250' ? fmt(selectedLow) : fmt(item.low_250)}</td>}
                      {!isDrawdown && board === 'low_1000' && <td className="px-4 py-3.5 text-right font-mono">{fmt(selectedLow)}</td>}
                      {board === 'low_composite' && <td className="px-4 py-3.5 text-right font-mono font-semibold text-primary">{fmt(item.low_composite)}</td>}
                      {isDrawdown && <td className="px-4 py-3.5 text-right font-mono font-semibold">{fmt(drawdownValue)}%</td>}
                      <td className="px-4 py-3.5 font-mono text-[10px] text-muted-foreground">{item.sample_start} — {item.sample_end}</td>
                      <td className="px-4 py-3.5"><span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300"><Clock3 className="h-3 w-3" />{tr('pending')}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {items.length > 0 && (
          <div className="flex items-center justify-between border-t border-border/50 px-4 py-3 sm:px-6">
            <span className="text-[11px] text-muted-foreground">{tr('page', { page })} / {pageCount}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={offset === 0 || loadingRows} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{tr('previous')}</Button>
              <Button size="sm" variant="outline" disabled={offset + PAGE_SIZE >= total || loadingRows} onClick={() => setOffset(offset + PAGE_SIZE)}>{tr('next')}</Button>
            </div>
          </div>
        )}
      </section>

      <LeftSideOperations
        snapshotId={snapshotId}
        snapshot={selectedSnapshot}
        candidates={items}
        selectedCandidate={selectedCandidate}
        onSelectCandidate={setSelectedCandidate}
        onRefresh={refreshStatus}
      />

      <footer className="grid gap-3 text-[11px] leading-5 text-muted-foreground lg:grid-cols-2">
        <div className="flex gap-2 rounded-xl border border-border/50 bg-card/60 px-4 py-3"><ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />{tr('formulas')}</div>
        <div className="flex gap-2 rounded-xl border border-border/50 bg-card/60 px-4 py-3"><ArrowDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />{tr('source')}</div>
      </footer>
    </div>
  )
}
