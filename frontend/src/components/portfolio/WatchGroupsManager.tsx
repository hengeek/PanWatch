import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, FolderKanban, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { watchGroupsApi, type WatchGroup } from '@panwatch/api/watch-groups'
import type { StockItem } from '@panwatch/api/stocks'
import { useConfirm } from '@panwatch/base-ui/components/ui/confirm-dialog'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@panwatch/base-ui/components/ui/dialog'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'
import { useToast } from '@panwatch/base-ui/components/ui/toast'

export default function WatchGroupsManager({ open, onOpenChange, stocks }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  stocks: StockItem[]
}) {
  const { t } = useTranslation('configuration')
  const tr = (key: string, options?: Record<string, unknown>) =>
    (t as unknown as (key: string, options?: Record<string, unknown>) => string)(`stocksPage.watchGroups.${key}`, options)
  const { toast } = useToast()
  const showConfirm = useConfirm()
  const [groups, setGroups] = useState<WatchGroup[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const selected = groups.find(group => group.id === selectedId) ?? groups[0]
  const memberIds = useMemo(() => new Set(selected?.members.map(member => member.stock_id) ?? []), [selected])
  const availableStocks = useMemo(() => stocks.filter(stock => !memberIds.has(stock.id)), [stocks, memberIds])

  const reload = async () => {
    setLoading(true)
    try {
      const result = await watchGroupsApi.list()
      setGroups(result.items)
      setSelectedId(current => result.items.some(group => group.id === current) ? current : result.items[0]?.id ?? null)
    } catch (error) {
      toast(error instanceof Error ? error.message : tr('loadFailed'), 'error')
    } finally { setLoading(false) }
  }

  useEffect(() => { if (open) void reload() }, [open])

  const create = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const created = await watchGroupsApi.create(name.trim())
      await reload(); setSelectedId(created.id); setName(''); toast(tr('created'), 'success')
    } catch (error) { toast(error instanceof Error ? error.message : tr('createFailed'), 'error') }
    finally { setSaving(false) }
  }

  const rename = async () => {
    if (!selected || !newName.trim()) return
    setSaving(true)
    try {
      await watchGroupsApi.rename(selected.id, newName.trim(), selected.version)
      await reload(); setEditing(false); toast(tr('renamed'), 'success')
    } catch (error) { toast(error instanceof Error ? error.message : tr('renameFailed'), 'error'); await reload() }
    finally { setSaving(false) }
  }

  const remove = async () => {
    if (!selected) return
    if (!(await showConfirm(tr('deleteConfirm', { name: selected.name }), { destructive: true }))) return
    setSaving(true)
    try {
      await watchGroupsApi.remove(selected.id, selected.version)
      await reload(); toast(tr('deleted'), 'success')
    } catch (error) { toast(error instanceof Error ? error.message : tr('deleteFailed'), 'error'); await reload() }
    finally { setSaving(false) }
  }

  const saveMembers = async (ids: number[]) => {
    if (!selected) return
    setSaving(true)
    try { await watchGroupsApi.setMembers(selected.id, ids, selected.version); await reload() }
    catch (error) { toast(error instanceof Error ? error.message : tr('membersFailed'), 'error'); await reload() }
    finally { setSaving(false) }
  }

  const moveMember = (index: number, direction: -1 | 1) => {
    if (!selected) return
    const ids = selected.members.map(member => member.stock_id)
    const next = index + direction
    if (next < 0 || next >= ids.length) return
    ;[ids[index], ids[next]] = [ids[next], ids[index]]
    void saveMembers(ids)
  }

  const moveGroup = async (groupId: number, direction: -1 | 1) => {
    const index = groups.findIndex(group => group.id === groupId)
    const next = index + direction
    if (index < 0 || next < 0 || next >= groups.length) return
    const reordered = [...groups]
    ;[reordered[index], reordered[next]] = [reordered[next], reordered[index]]
    setSelectedId(groupId); setSaving(true)
    try {
      await watchGroupsApi.setOrder(reordered.map((group, sort_order) => ({ group_id: group.id, sort_order, version: group.version })))
      await reload()
    } catch (error) { toast(error instanceof Error ? error.message : tr('orderFailed'), 'error'); await reload() }
    finally { setSaving(false) }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto scrollbar">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><FolderKanban className="w-4 h-4"/>{tr('title')}</DialogTitle>
        <DialogDescription>{tr('description')}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)] min-h-0">
        <section className="min-h-0">
          <div className="flex gap-2 mb-3">
            <Input aria-label={tr('newGroup')} maxLength={40} value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void create() }} placeholder={tr('newGroup')} />
            <Button aria-label={tr('create')} size="icon" onClick={() => void create()} disabled={saving || !name.trim()}><Plus className="w-4 h-4"/></Button>
          </div>
          <div className="space-y-1 max-h-[45vh] overflow-y-auto scrollbar pr-1">
            {groups.map((group, index) => <div key={group.id} className={`w-full flex items-center gap-1 rounded-md px-1.5 py-1 border ${selected?.id === group.id ? 'border-primary/40 bg-primary/5 text-foreground' : 'border-transparent text-muted-foreground'}`}>
              <Button type="button" variant="ghost" onClick={() => { setSelectedId(group.id); setEditing(false) }} className="min-w-0 flex-1 justify-start gap-2 px-1.5 hover:bg-transparent">
                <span className="truncate flex-1 text-sm text-left">{group.name}</span><span className="text-xs tabular-nums">{group.members.length}</span>
              </Button>
              <Button type="button" variant="ghost" size="icon" aria-label={tr('moveUp', { name: group.name })} onClick={() => void moveGroup(group.id, -1)} disabled={index === 0 || saving} className="h-7 w-7"><ArrowUp className="w-3 h-3"/></Button>
              <Button type="button" variant="ghost" size="icon" aria-label={tr('moveDown', { name: group.name })} onClick={() => void moveGroup(group.id, 1)} disabled={index === groups.length - 1 || saving} className="h-7 w-7"><ArrowDown className="w-3 h-3"/></Button>
            </div>)}
            {!groups.length && !loading && <p className="text-sm text-muted-foreground py-3">{tr('empty')}</p>}
          </div>
        </section>
        <section className="min-w-0 border-t md:border-t-0 md:border-l border-border pt-4 md:pt-0 md:pl-5">
          {selected ? <>
            <div className="flex items-start gap-2 mb-4">
              {editing ? <Input aria-label={tr('groupName')} maxLength={40} autoFocus value={newName} onChange={event => setNewName(event.target.value)} /> : <h3 className="font-semibold text-base flex-1">{selected.name}</h3>}
              {editing ? <><Button size="sm" onClick={() => void rename()} disabled={saving}>{tr('save')}</Button><Button size="icon" variant="ghost" aria-label={tr('cancel')} onClick={() => setEditing(false)}><X className="w-4 h-4"/></Button></> : <>
                <Button size="icon" variant="ghost" aria-label={tr('rename', { name: selected.name })} onClick={() => { setNewName(selected.name); setEditing(true) }}><Pencil className="w-4 h-4"/></Button>
                <Button size="icon" variant="ghost" aria-label={tr('delete', { name: selected.name })} onClick={() => void remove()} disabled={saving}><Trash2 className="w-4 h-4"/></Button>
              </>}
            </div>
            <div className="mb-3">
              <Select value="__choose_stock__" onValueChange={value => { const id = Number(value); if (id) void saveMembers([...selected.members.map(member => member.stock_id), id]) }}>
                <SelectTrigger aria-label={tr('addStock')}><SelectValue placeholder={tr('addStock')}/></SelectTrigger>
                <SelectContent>
                  {availableStocks.map(stock => <SelectItem key={stock.id} value={String(stock.id)}>{stock.name} · {stock.market}:{stock.symbol}</SelectItem>)}
                  {!availableStocks.length && <SelectItem value="__none__" disabled>{tr('noStocks')}</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div className="max-h-[40vh] overflow-y-auto scrollbar divide-y divide-border rounded-md border border-border">
              {selected.members.map((member, index) => <div key={member.stock_id} className="flex items-center gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1"><div className="text-sm font-medium truncate">{member.name}</div><div className="text-xs text-muted-foreground">{member.market}:{member.symbol}</div></div>
                <Button aria-label={tr('moveUp', { name: member.name })} size="icon" variant="ghost" className="h-7 w-7" disabled={index === 0 || saving} onClick={() => moveMember(index, -1)}><ArrowUp className="w-3.5 h-3.5"/></Button>
                <Button aria-label={tr('moveDown', { name: member.name })} size="icon" variant="ghost" className="h-7 w-7" disabled={index === selected.members.length - 1 || saving} onClick={() => moveMember(index, 1)}><ArrowDown className="w-3.5 h-3.5"/></Button>
                <Button aria-label={tr('removeMember', { group: selected.name, name: member.name })} size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive" disabled={saving} onClick={() => void saveMembers(selected.members.filter(item => item.stock_id !== member.stock_id).map(item => item.stock_id))}><X className="w-3.5 h-3.5"/></Button>
              </div>)}
              {!selected.members.length && <div className="text-sm text-muted-foreground text-center py-8">{tr('emptyMembers')}</div>}
            </div>
          </> : <div className="text-sm text-muted-foreground py-10 text-center">{loading ? tr('loading') : tr('empty')}</div>}
        </section>
      </div>
    </DialogContent>
  </Dialog>
}
