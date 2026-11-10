import { fetchAPI } from './client'

export interface WatchGroupMember {
  stock_id: number
  sort_order: number
  symbol: string
  name: string
  market: string
}

export interface WatchGroup {
  id: number
  name: string
  sort_order: number
  version: number
  members: WatchGroupMember[]
}

export const watchGroupsApi = {
  list: () => fetchAPI<{ items: WatchGroup[] }>('/watch-groups'),
  create: (name: string) => fetchAPI<WatchGroup>('/watch-groups', { method: 'POST', body: JSON.stringify({ name }) }),
  rename: (id: number, name: string, version: number) =>
    fetchAPI<WatchGroup>(`/watch-groups/${id}`, { method: 'PATCH', body: JSON.stringify({ name, version }) }),
  remove: (id: number, version: number) =>
    fetchAPI<{ ok: boolean; id: number }>(`/watch-groups/${id}?version=${version}`, { method: 'DELETE' }),
  setMembersBatch: (groups: Array<{ group_id: number; stock_ids: number[]; version: number }>) =>
    fetchAPI<{ items: WatchGroup[] }>('/watch-groups/members', {
      method: 'PUT', body: JSON.stringify({ groups }),
    }),
  setMembers: (id: number, stockIds: number[], version: number) =>
    fetchAPI<WatchGroup>(`/watch-groups/${id}/members`, {
      method: 'PUT', body: JSON.stringify({ stock_ids: stockIds, version }),
    }),
}
