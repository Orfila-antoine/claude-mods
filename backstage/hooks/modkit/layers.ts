export type Placed = { mod: string; layer: string; slot: string; order: number; z: number; rows: number; cover: boolean }
export type Slot = { slot: string; z: number; rows: number; order: number; members: Placed[] }

const byPriority = (a: { z: number; order: number }, b: { z: number; order: number }) => b.z - a.z || a.order - b.order

export function plan(items: readonly Placed[], budget: number): Slot[] {
  const room = Math.max(0, Math.floor(budget))
  const covers = items.filter(item => item.cover).sort(byPriority)
  const top = covers[0]
  if (top) return [{ slot: top.slot, z: top.z, rows: Math.min(top.rows, room), order: top.order, members: [top] }]

  const groups = new Map<string, Placed[]>()
  for (const item of items) groups.set(item.slot, [...(groups.get(item.slot) ?? []), item])
  const slots = [...groups.entries()]
    .map(([slot, members]) => ({
      slot,
      z: Math.max(...members.map(one => one.z)),
      rows: Math.max(...members.map(one => one.rows)),
      order: Math.min(...members.map(one => one.order)),
      members: [...members].sort((a, b) => a.z - b.z || b.order - a.order),
    }))
    .sort(byPriority)

  let used = 0
  return slots.filter(slot => {
    if (slot.rows <= 0 || used + slot.rows > room) return false
    used += slot.rows
    return true
  })
}

export const STACK = 'modkit-stack'
export const keyOf = (z: number, plugin: string, slot: string) => `modkit:${z}:${plugin}:${slot}`

export function parseKey(key: unknown) {
  if (typeof key !== 'string') return null
  const found = /^modkit:(-?\d+(?:\.\d+)?):([^:]+):(.+)$/.exec(key)
  return found ? { z: Number(found[1]), plugin: found[2] ?? '', slot: found[3] ?? '' } : null
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

type Element = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }

const keyed = (node: unknown) => parseKey((node as Element | null)?.props?.key)

export function stacked(node: unknown) {
  const element = node as Element | null
  return element?.type === 'Box' && element.props?.key === STACK ? (element.children ?? []) : null
}

export function merge<T>(own: readonly T[], below: T | null | undefined): T[] {
  const inner = stacked(below) as T[] | null
  const theirs = inner ? inner.filter(child => keyed(child)) : []
  const base = inner ? inner.filter(child => !keyed(child)) : below == null ? [] : [below]
  const layers = [...own, ...theirs].sort((a, b) => {
    const left = keyed(a)
    const right = keyed(b)
    if (!left || !right) return 0
    return right.z - left.z || compare(left.plugin, right.plugin) || compare(left.slot, right.slot)
  })
  return [...layers, ...base]
}
