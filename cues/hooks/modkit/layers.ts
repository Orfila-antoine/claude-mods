import type { Flow, FlowCell, ModkitLayout, Side } from './contract'

export type Placed = { id: string; kind: 'block' | 'float'; side?: Side; top: number; columns: number; rows: number }

type Cell = {
  id: string
  plugin: string
  z: number
  order: number
  float?: Side
  width: number
  minColumns: number
  priority: number
  full: number
  narrow: Record<string, number>
}
type Active = { side: Side; width: number; end: number }
type Walked = { cell: Cell; placed: Placed }
type Ranked = { z: number; plugin: string; order: number }

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byFlow = (a: Ranked, b: Ranked) => b.z - a.z || compare(a.plugin, b.plugin) || a.order - b.order
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

export const pluginOf = (id: string) => id.split('/')[0] ?? ''
export const placedIdOf = (cell: Pick<FlowCell, 'id' | 'slot'>) => (cell.slot === undefined ? cell.id : `${pluginOf(cell.id)}/${cell.slot}`)

export function resolve(flow: Flow, bodyColumns: number) {
  let float = flow.float
  let hidden = false
  for (const point of flow.at ?? []) {
    if (bodyColumns >= point.below) continue
    if (point.float !== undefined) float = point.float ?? undefined
    if (point.hidden) hidden = true
  }
  return { float: (flow.width ?? 0) > 0 ? float : undefined, hidden }
}

function cellsOf(bodyColumns: number, cells: readonly FlowCell[]): Cell[] {
  const groups = new Map<string, FlowCell[]>()
  for (const cell of cells) {
    if (resolve(cell.flow, bodyColumns).hidden) continue
    const id = placedIdOf(cell)
    groups.set(id, [...(groups.get(id) ?? []), cell])
  }
  return [...groups.entries()]
    .map(([id, members]) => {
      const lead = members.reduce((best, one) => (one.z > best.z || (one.z === best.z && one.order < best.order) ? one : best))
      const widths = new Set(members.flatMap(one => Object.keys(one.rows.narrow)))
      const float = resolve(lead.flow, bodyColumns).float
      const cell: Cell = {
        id,
        plugin: pluginOf(id),
        z: Math.max(...members.map(one => one.z)),
        order: Math.min(...members.map(one => one.order)),
        width: Math.floor(lead.flow.width ?? 0),
        minColumns: Math.max(1, lead.flow.minColumns ?? 1),
        priority: Math.max(...members.map(one => one.flow.priority ?? one.z)),
        full: Math.max(...members.map(one => one.rows.full)),
        narrow: Object.fromEntries([...widths].map(width => [width, Math.max(...members.map(one => one.rows.narrow[width] ?? one.rows.full))])),
      }
      return float ? { ...cell, float } : cell
    })
    .sort(byFlow)
}

function walk(cells: readonly Cell[], bodyColumns: number, start = 0, given: readonly Active[] = []): { walked: Walked[]; height: number } {
  const walked: Walked[] = []
  let active = [...given]
  let y = start
  let bottom = Math.max(start, ...given.map(float => float.end))
  for (const [index, cell] of cells.entries()) {
    active = active.filter(float => float.end > y)
    const free = bodyColumns - sum(active.map(float => float.width))
    const side = cell.float
    if (side && !active.some(float => float.side === side) && free - cell.width >= 1) {
      const float: Active = { side, width: cell.width, end: y + cell.full }
      const rest = walk(cells.slice(index + 1), bodyColumns, y, [...active, float]).walked
      const isReadable = rest.every(({ cell: next, placed }) => placed.kind === 'float' || placed.top >= float.end || placed.columns >= next.minColumns)
      if (isReadable) {
        walked.push({ cell, placed: { id: cell.id, kind: 'float', side, top: y, columns: cell.width, rows: cell.full } })
        active.push(float)
        bottom = Math.max(bottom, float.end)
        continue
      }
    }
    const rows = free === bodyColumns ? cell.full : (cell.narrow[String(free)] ?? cell.full)
    walked.push({ cell, placed: { id: cell.id, kind: 'block', top: y, columns: free, rows } })
    y += rows
    bottom = Math.max(bottom, y)
  }
  return { walked, height: bottom }
}

export function solve(bodyColumns: number, maxRows: number, layouts: readonly (ModkitLayout | undefined)[]): Placed[] {
  const columns = Math.max(1, Math.floor(bodyColumns))
  const room = Math.max(0, Math.floor(maxRows))
  const all = layouts.flatMap(layout => layout?.cells ?? [])
  const cover = all
    .filter(cell => cell.cover)
    .map(cell => ({ cell, plugin: pluginOf(cell.id), z: cell.z, order: cell.order }))
    .sort(byFlow)[0]?.cell
  if (cover) {
    const rows = Math.min(cover.rows.full, room)
    return rows > 0 ? [{ id: placedIdOf(cover), kind: 'block', top: 0, columns, rows }] : []
  }
  const cells = cellsOf(columns, all).filter(cell => cell.full > 0)
  const ranked = [...cells].sort((a, b) => b.priority - a.priority || byFlow(a, b))
  let kept: Cell[] = []
  for (const cell of ranked) {
    const trial = [...kept, cell].sort(byFlow)
    if (walk(trial, columns).height <= room) kept = trial
  }
  return walk(kept, columns).walked.map(({ placed }) => placed)
}

export function narrowWidths(bodyColumns: number, flows: readonly Flow[]) {
  const columns = Math.max(1, Math.floor(bodyColumns))
  const widths: Record<Side, Set<number>> = { left: new Set([0]), right: new Set([0]) }
  for (const flow of flows) {
    const { float, hidden } = resolve(flow, columns)
    if (float && !hidden) widths[float].add(Math.floor(flow.width ?? 0))
  }
  const found = new Set<number>()
  for (const left of widths.left) {
    for (const right of widths.right) if (left + right > 0 && columns - left - right >= 1) found.add(columns - left - right)
  }
  return [...found].sort((a, b) => b - a)
}

export type Sized = { cell: Omit<FlowCell, 'rows'>; rowsAt: (columns: number) => number }

export function measure(bodyColumns: number, sized: readonly Sized[], others: readonly (ModkitLayout | undefined)[]): ModkitLayout {
  const columns = Math.max(1, Math.floor(bodyColumns))
  const flows = [...others.flatMap(layout => layout?.cells.map(cell => cell.flow) ?? []), ...sized.map(({ cell }) => cell.flow)]
  const widths = narrowWidths(columns, flows)
  return {
    v: 2,
    cells: sized.map(({ cell, rowsAt }) => {
      const full = rowsAt(columns)
      const narrow = widths.map(width => [String(width), rowsAt(width)] as const).filter(([, rows]) => rows !== full)
      return { ...cell, rows: { full, narrow: Object.fromEntries(narrow) } }
    }),
  }
}

export const STACK = 'modkit-stack'
export const FLOW = 'modkit-flow'
const PREFIX = 'modkit:'
export const keyOf = (id: string) => `${PREFIX}${id}`

type Element = { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }

export function harvest(below: unknown, wanted: ReadonlySet<string>) {
  const found = new Map<string, unknown>()
  const collect = (node: unknown): unknown[] => {
    if (node === null || node === undefined || typeof node === 'boolean') return []
    if (typeof node !== 'object') return [node]
    const element = node as Element
    const key = element.props?.key
    if (typeof key === 'string' && key.startsWith(PREFIX) && wanted.has(key.slice(PREFIX.length))) {
      found.set(key.slice(PREFIX.length), node)
      return []
    }
    const children = element.children?.flatMap(collect)
    if (key === FLOW) return []
    if (key === STACK) return children ?? []
    return children ? [{ ...element, children }] : [node]
  }
  return { base: collect(below), found }
}

export type BoxProps = {
  key?: string
  flexDirection?: 'row' | 'column'
  justifyContent?: 'flex-end'
  overflow?: 'hidden'
  width?: number
  height?: number
}
export type Build<T> = (props: BoxProps, children: readonly T[]) => T

type Zone = { top: number; end: number; left: Placed[]; right: Placed[]; blocks: Placed[] }

export function assemble<T>(bodyColumns: number, plan: readonly Placed[], elements: ReadonlyMap<string, T>, base: readonly T[], box: Build<T>): T {
  const at = (item: Placed) => elements.get(item.id) ?? box({ width: item.columns, height: item.rows }, [])
  const widthOf = (floats: readonly Placed[]) => Math.max(0, ...floats.map(float => float.columns))
  const side = (zone: Zone, floats: readonly Placed[]) => {
    let y = zone.top
    const children = floats.flatMap(float => {
      const gap = float.top - y
      y = float.top + float.rows
      return gap > 0 ? [box({ height: gap }, []), at(float)] : [at(float)]
    })
    return box({ flexDirection: 'column', width: widthOf(floats), height: zone.end - zone.top }, children)
  }
  const draw = (zone: Zone) => {
    const height = zone.end - zone.top
    const width = bodyColumns - widthOf(zone.left) - widthOf(zone.right)
    const first = [...zone.left, ...zone.right].sort((a, b) => a.top - b.top)[0]?.id ?? ''
    return box({ key: `modkit-zone:${first}`, flexDirection: 'row', height }, [
      ...(zone.left.length > 0 ? [side(zone, zone.left)] : []),
      box({ flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden', width, height }, zone.blocks.map(at)),
      ...(zone.right.length > 0 ? [side(zone, zone.right)] : []),
    ])
  }
  const items: T[] = []
  let zone: Zone | null = null
  for (const item of plan) {
    if (item.kind === 'float') {
      if (!zone || item.top >= zone.end) {
        if (zone) items.push(draw(zone))
        zone = { top: item.top, end: item.top, left: [], right: [], blocks: [] }
      }
      ;(item.side === 'left' ? zone.left : zone.right).push(item)
      zone.end = Math.max(zone.end, item.top + item.rows)
    } else if (zone && item.top < zone.end) {
      zone.blocks.push(item)
      zone.end = Math.max(zone.end, item.top + item.rows)
    } else {
      if (zone) items.push(draw(zone))
      zone = null
      items.push(at(item))
    }
  }
  if (zone) items.push(draw(zone))
  return box({ key: STACK, flexDirection: 'column' }, [...base, box({ key: FLOW, flexDirection: 'column' }, items)])
}
