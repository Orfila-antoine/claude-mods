import type {
  CommandRunInput,
  CommandRunResult,
  CommandSpec,
  ElementTable,
  EngineInterface,
  JsonValue,
  On,
  PluginOptions,
  PromptSubmitInput,
  PromptSubmitResult,
  RenderElement,
  RenderInput,
  RenderNode,
  TurnCompleteInput,
  TurnCompleteResult,
} from 'claude-code'

import type { Flow, ModkitLayout } from './contract'
import { composite, encode, grid, resized } from './grid'
import type { Grid } from './grid'
import { assemble, harvest, keyOf, measure, placedIdOf, solve } from './layers'
import type { BoxProps, Sized } from './layers'
import { alphaOf, apply, flip, isSettled } from './motion'
import type { Phase, Transition } from './motion'
import { OWN, publish, published } from './own'
import { run } from './pipeline'
import type { Entry, Fault, Step } from './pipeline'
import { roster } from './roster'

export * from './components'
export * from './contract'
export * from './grid'
export * from './layers'
export * from './motion'
export * from './pipeline'

export const VERSION = '0.3.0'

export type Fx = {
  plugin: string
  mod: string
  toast(text: string): void
  log(text: string): void
  now(): Promise<number>
  state<T extends JsonValue>(): Promise<T | undefined>
  setState<T extends JsonValue>(update: (current: T | undefined) => T): Promise<void>
  prompt: { read(): Promise<string>; fill(text: string, mode?: 'replace' | 'append'): Promise<boolean> }
}

export type Ctx = { mod: string; fx: Fx }
export type SessionMsg = { reason: 'load' | 'clear' }
export type Events = {
  session: [SessionMsg, void]
  'prompt.submit': [PromptSubmitInput, PromptSubmitResult]
  'turn.complete': [TurnCompleteInput, TurnCompleteResult]
  'command.run': [CommandRunInput, CommandRunResult]
}
export type KitEvent = keyof Events
export type ModStep<E extends KitEvent> = Step<Events[E][0], Events[E][1], Ctx>

export type View<S> = { columns: number; rows: number; now: number; since: number; state: S | undefined; fx: Fx }
export type Room<S> = { state: S | undefined; columns: number; maxRows: number; isWorking: boolean }
type LayerBase<S> = Flow & {
  id: string
  z: number
  rows: number | ((room: Room<S>) => number)
  visible?(state: S | undefined, room: Room<S>): boolean
}
export type GridLayer<S> = LayerBase<S> & {
  slot?: string
  cover?: boolean
  animated?: boolean
  enter?: Transition
  exit?: Transition
  grid(view: View<S>): Grid
}
export type NodeLayer<S> = LayerBase<S> & { node(view: View<S> & { ui: ElementTable<'terminal'>; surface: string; isWorking: boolean }): RenderNode }
export type Layer<S = JsonValue> = GridLayer<S> | NodeLayer<S>

export type Mod<S extends JsonValue = JsonValue> = {
  id: string
  agents?: boolean
  commands?: readonly CommandSpec[]
  on?: { [E in KitEvent]?: readonly ModStep<E>[] }
  layers?: readonly Layer<S>[]
}

export type Kit = { plugin: string; mods: readonly Mod<any>[] }

type Live = { mod: Mod<any>; layer: Layer<any>; order: number; key: string }
type Mounted = { raster: string; columns: number; rows: number; members: Live[]; last: string }
type Band = { requestId: string; slots: Mounted[] }
type Runtime = {
  session: string | null
  cache: Map<string, JsonValue | undefined>
  phases: Map<string, Phase>
  faults: Map<string, string>
  band: Band | null
  isStale: boolean
  ticker: { cancel: () => void } | null
  pending: ModkitLayout | null
  writes: number
}

const FRAME_MS = 33
const RETRY_MS = 50
const RETRIES = 3
const RUNTIMES = new Map<string, Runtime>()
const TICKERS = globalThis as { modkitTickers?: Record<string, { cancel: () => void } | undefined> }

const isGrid = (layer: Layer<any>): layer is GridLayer<any> => 'grid' in layer
const storeKey = (mod: string) => `modkit:${mod}`
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

function runtimeOf(plugin: string) {
  let runtime = RUNTIMES.get(plugin)
  if (!runtime) {
    runtime = { session: null, cache: new Map(), phases: new Map(), faults: new Map(), band: null, isStale: false, ticker: null, pending: null, writes: 0 }
    RUNTIMES.set(plugin, runtime)
  }
  return runtime
}

function fxOf($: EngineInterface, plugin: string, mod: string, runtime: Runtime): Fx {
  return {
    plugin,
    mod,
    toast: text => {
      $.ui.toast(text)
    },
    log: text => {
      $.ui.log(`${plugin}/${mod}: ${text}`)
    },
    now: () => $.clock.now(),
    state: async <T extends JsonValue>() => (await stateOf($, runtime, mod)) as T | undefined,
    setState: async <T extends JsonValue>(update: (current: T | undefined) => T) => {
      const value = update((await stateOf($, runtime, mod)) as T | undefined)
      runtime.cache.set(mod, value)
      $.ui.invalidate('ui.render')
      await $.store.set(storeKey(mod), { session: runtime.session, value })
    },
    prompt: {
      read: async () => (await $.prompt.read()).text,
      fill: async (text, mode = 'replace') => (await $.prompt.fill({ text, mode })).isFilled,
    },
  }
}

export function modFx($: EngineInterface, kit: Kit, mod: string): Fx {
  return fxOf($, kit.plugin, mod, runtimeOf(kit.plugin))
}

function faultOf($: EngineInterface, plugin: string, event: string) {
  return (fault: Fault) => {
    $.ui.log(`${plugin}/${fault.mod}: ${event} step ${fault.name} failed: ${reason(fault.error)}`)
  }
}

async function dispatch<E extends KitEvent>(
  $: EngineInterface,
  kit: Kit,
  runtime: Runtime,
  mods: readonly Mod<any>[],
  event: E,
  msg: Events[E][0],
  terminal: (msg: Events[E][0]) => Promise<Events[E][1]>,
) {
  const entries: Entry<Events[E][0], Events[E][1], Ctx>[] = mods.flatMap(mod =>
    (mod.on?.[event] ?? []).map((step, k) => ({
      mod: mod.id,
      name: step.name || `#${k + 1}`,
      step: step as Step<Events[E][0], Events[E][1], Ctx>,
      ctx: { mod: mod.id, fx: fxOf($, kit.plugin, mod.id, runtime) },
    })),
  )
  return run(entries, msg, terminal, faultOf($, kit.plugin, event))
}

async function stateOf($: EngineInterface, runtime: Runtime, mod: string) {
  const session = await $.session.id().catch(() => '')
  if (runtime.session !== session) {
    runtime.cache.clear()
    runtime.session = session
  }
  if (!runtime.cache.has(mod)) {
    const stored = (await $.store.get(storeKey(mod)).catch(() => undefined)) as { session?: unknown; value?: JsonValue } | undefined
    runtime.cache.set(mod, stored?.session === session ? stored.value : undefined)
  }
  return runtime.cache.get(mod)
}

async function load($: EngineInterface, runtime: Runtime, mods: readonly Mod<any>[]) {
  for (const mod of mods) await stateOf($, runtime, mod.id)
}

function guarded<T>($: EngineInterface, kit: Kit, runtime: Runtime, live: Live, part: string, fallback: T, draw: () => T): T {
  const key = `${live.key}#${part}`
  try {
    const value = draw()
    runtime.faults.delete(key)
    return value
  } catch (error) {
    const message = reason(error)
    if (runtime.faults.get(key) !== message) $.ui.log(`${kit.plugin}/${live.mod.id}: layer ${live.layer.id} ${part} failed: ${message}`)
    runtime.faults.set(key, message)
    return fallback
  }
}

function paint($: EngineInterface, kit: Kit, runtime: Runtime, members: readonly Live[], columns: number, rows: number, now: number) {
  let out = grid(columns, rows)
  for (const live of members) {
    const layer = live.layer
    if (!isGrid(layer)) continue
    const phase = runtime.phases.get(live.key) ?? { visible: true, since: -Infinity }
    const view: View<any> = { columns, rows, now, since: phase.since, state: runtime.cache.get(live.mod.id), fx: fxOf($, kit.plugin, live.mod.id, runtime) }
    const drawn = guarded($, kit, runtime, live, 'grid', null, () => layer.grid(view))
    if (!drawn) continue
    const transition = phase.visible ? layer.enter : layer.exit
    out = composite(out, apply(resized(drawn, columns, rows), transition?.kind ?? 'none', alphaOf(phase, now, layer.enter, layer.exit)))
  }
  return out
}

function isMoving(runtime: Runtime, members: readonly Live[], now: number) {
  return members.some(live => {
    const layer = live.layer
    if (!isGrid(layer)) return false
    const phase = runtime.phases.get(live.key)
    return Boolean(layer.animated && phase?.visible) || (phase !== undefined && !isSettled(phase, now, layer.enter, layer.exit))
  })
}

function stop(kit: Kit, runtime: Runtime) {
  runtime.ticker?.cancel()
  runtime.ticker = null
  const tickers = (TICKERS.modkitTickers ??= {})
  tickers[kit.plugin] = undefined
}

function tick($: EngineInterface, kit: Kit, runtime: Runtime) {
  if (runtime.ticker) return
  const tickers = (TICKERS.modkitTickers ??= {})
  tickers[kit.plugin]?.cancel()
  const ticker = $.clock.every(FRAME_MS, async () => {
    const band = runtime.band
    if (!band || runtime.isStale) return stop(kit, runtime)
    const now = await $.clock.now()
    let isNeeded = false
    let hasEnded = false
    for (const slot of band.slots) {
      const cells = encode(paint($, kit, runtime, slot.members, slot.columns, slot.rows, now))
      if (cells !== slot.last) {
        const blitted = await $.ui.blit({ requestId: band.requestId, key: slot.raster, cells }).catch((error: unknown) => ({ deny: reason(error) }))
        if ('deny' in blitted && blitted.deny) {
          runtime.isStale = true
          $.ui.invalidate('ui.render')
          return stop(kit, runtime)
        }
        slot.last = cells
      }
      isNeeded ||= isMoving(runtime, slot.members, now)
      hasEnded ||= slot.members.some(live => {
        const phase = runtime.phases.get(live.key)
        return phase !== undefined && !phase.visible && isSettled(phase, now, (live.layer as GridLayer<any>).enter, (live.layer as GridLayer<any>).exit)
      })
    }
    if (hasEnded) $.ui.invalidate('ui.render')
    if (!isNeeded || hasEnded) stop(kit, runtime)
  })
  runtime.ticker = ticker
  tickers[kit.plugin] = ticker
}

const livesOf = (mods: readonly Mod<any>[]): Live[] =>
  mods.flatMap(mod => (mod.layers ?? []).map(layer => ({ mod, layer, key: `${mod.id}/${layer.id}` }))).map((live, order) => ({ ...live, order }))

const flowOf = ({ float, width, minColumns, priority, at }: Flow): Flow => ({
  ...(float !== undefined && { float }),
  ...(width !== undefined && { width }),
  ...(minColumns !== undefined && { minColumns }),
  ...(priority !== undefined && { priority }),
  ...(at !== undefined && { at }),
})

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every(key => same(left[key], right[key]))
}

function schedule($: EngineInterface, kit: Kit, runtime: Runtime, layout: ModkitLayout, attempt = 0) {
  const isWaiting = runtime.pending !== null
  runtime.pending = layout
  if (isWaiting) return
  $.clock.after(attempt === 0 ? 0 : RETRY_MS, () => {
    const value = runtime.pending
    runtime.pending = null
    if (!value) return
    void publish($, value)
      .then(() => {
        runtime.writes += 1
        $.ui.log(`${kit.plugin}: layout written (${value.cells.length} cells, write ${runtime.writes})`, { to: 'debug' })
      })
      .catch((error: unknown) => {
        $.ui.log(`${kit.plugin}: layout not written: ${reason(error)}`, { to: 'debug' })
        if (runtime.pending === null && attempt < RETRIES) schedule($, kit, runtime, value, attempt + 1)
      })
  })
}

export async function band($: EngineInterface, e: RenderInput<'AbovePrompt'>, below: RenderElement, kit: Kit): Promise<RenderElement> {
  if (e.props.hasSurvey) return below
  const runtime = runtimeOf(kit.plugin)
  const isTerminal = e.surface === 'terminal'
  const ui = $.ui.resolve(e) as unknown as ElementTable<'terminal'>
  const { Box, Raster } = ui
  const now = await $.clock.now()
  const columns = Math.max(1, Math.floor(e.props.bodyColumns))
  await load($, runtime, kit.mods)
  const [layouts, current] = await Promise.all([roster($), published($)])

  const shown: (Sized & { live: Live })[] = []
  for (const live of livesOf(kit.mods)) {
    const layer = live.layer
    if (isGrid(layer) && !isTerminal) continue
    const roomAt = (width: number): Room<any> => ({ state: runtime.cache.get(live.mod.id), columns: width, maxRows: e.props.maxRows, isWorking: e.props.isWorking })
    const room = roomAt(columns)
    const isVisible = guarded($, kit, runtime, live, 'visible', false, () => layer.visible?.(room.state, room) ?? true)
    const enter = isGrid(layer) ? layer.enter : undefined
    const exit = isGrid(layer) ? layer.exit : undefined
    const before = runtime.phases.get(live.key) ?? { visible: false, since: -Infinity }
    const phase = flip(before, isVisible, now, enter, exit)
    runtime.phases.set(live.key, phase)
    if (!phase.visible && isSettled(phase, now, enter, exit)) continue
    const sizing = layer.rows
    const rowsAt = (width: number) =>
      Math.max(0, Math.floor(typeof sizing === 'number' ? sizing : guarded($, kit, runtime, live, 'rows', 0, () => sizing(roomAt(width)))))
    const slot = isGrid(layer) ? layer.slot : undefined
    const cell = {
      id: `${kit.plugin}/${live.key}`,
      z: layer.z,
      order: live.order,
      ...(slot !== undefined && { slot }),
      ...(isGrid(layer) && layer.cover && { cover: true }),
      flow: flowOf(layer),
    }
    shown.push({ live, cell, rowsAt })
  }

  const others = Object.entries(layouts).flatMap(([plugin, layout]) => (plugin === OWN ? [] : [layout]))
  const fresh = measure(columns, shown, others)
  if (isTerminal && !same(fresh, current)) schedule($, kit, runtime, fresh)

  const plan = solve(columns, e.props.maxRows, [...others, fresh])
  const mine = new Map<string, Live[]>()
  for (const { live, cell } of shown) mine.set(placedIdOf(cell), [...(mine.get(placedIdOf(cell)) ?? []), live])
  const { base, found } = harvest(below, new Set(plan.map(item => item.id).filter(id => !mine.has(id))))
  const elements = new Map<string, RenderNode>([...found].map(([id, node]) => [id, node as RenderNode]))
  const mounted: Mounted[] = []
  for (const item of plan) {
    const members = mine.get(item.id)
    const first = members?.[0]
    if (!members || !first) continue
    const layer = first.layer
    const key = keyOf(item.id)
    if (!isGrid(layer)) {
      const view = {
        columns: item.columns,
        rows: item.rows,
        now,
        since: runtime.phases.get(first.key)?.since ?? now,
        state: runtime.cache.get(first.mod.id),
        fx: fxOf($, kit.plugin, first.mod.id, runtime),
        ui,
        surface: e.surface,
        isWorking: e.props.isWorking,
      }
      const node = guarded($, kit, runtime, first, 'node', null, () => layer.node(view))
      elements.set(
        item.id,
        <Box key={key} width={item.columns} height={item.rows} overflow="hidden" flexDirection="column">
          {node}
        </Box>,
      )
      continue
    }
    const painted = [...members].sort((a, b) => a.layer.z - b.layer.z || b.order - a.order)
    const raster = `modkit-${kit.plugin}-${layer.slot ?? first.key}`
    const cells = encode(paint($, kit, runtime, painted, item.columns, item.rows, now))
    mounted.push({ raster, columns: item.columns, rows: item.rows, members: painted, last: cells })
    elements.set(
      item.id,
      <Box key={key} width={item.columns} height={item.rows}>
        <Raster key={raster} columns={item.columns} rows={item.rows} cells={cells} />
      </Box>,
    )
  }

  if (isTerminal) {
    runtime.band = { requestId: e.requestId, slots: mounted }
    runtime.isStale = false
    if (mounted.some(slot => isMoving(runtime, slot.members, now))) tick($, kit, runtime)
  }
  const isCovered = [...others, fresh].some(layout => layout?.cells.some(cell => cell.cover))
  const box = (props: BoxProps, children: readonly RenderNode[]): RenderNode => <Box {...props}>{[...children]}</Box>
  return assemble(columns, plan, elements, isCovered ? [] : (base as RenderNode[]), box) as RenderElement
}

export function defineMods(on: On, options: PluginOptions, kit: Kit) {
  const seen = new Set<string>()
  for (const mod of kit.mods) {
    if (seen.has(mod.id)) throw new Error(`modkit: two mods are named "${mod.id}"`)
    seen.add(mod.id)
  }
  const mods = kit.mods.filter(mod => options[mod.id] !== false)
  const enabled: Kit = { plugin: kit.plugin, mods }
  const runtime = runtimeOf(kit.plugin)
  const uses = (event: KitEvent) => mods.some(mod => (mod.on?.[event]?.length ?? 0) > 0)
  const hasLayers = livesOf(mods).length > 0
  const commands = mods.flatMap(mod => mod.commands ?? [])
  const noop = async () => undefined

  if (commands.length > 0 || uses('session')) {
    on('session.start', async ($, e, next) => {
      for (const command of commands) {
        await $.command.register(command).catch(error => $.ui.log(`${kit.plugin}: /${command.name} not registered: ${reason(error)}`))
      }
      await dispatch($, enabled, runtime, mods, 'session', { reason: 'load' }, noop)
      return next(e)
    }).catch(($, e, next) => next(e))
  }

  if (hasLayers || uses('session')) {
    on('session.end', async ($, e, next) => {
      if (e.reason === 'clear') {
        stop(enabled, runtime)
        runtime.session = null
        runtime.cache.clear()
        runtime.phases.clear()
        runtime.band = null
        runtime.pending = null
        $.ui.invalidate('ui.render')
        await dispatch($, enabled, runtime, mods, 'session', { reason: 'clear' }, noop)
      }
      return next(e)
    }).catch(($, e, next) => next(e))
  }

  if (uses('prompt.submit')) {
    on('prompt.submit', async ($, e, next) => dispatch($, enabled, runtime, mods, 'prompt.submit', e, msg => next(msg))).catch(($, e, next) => next(e))
  }

  if (uses('turn.complete')) {
    on('turn.complete', async ($, e, next) => {
      const heard = e.agentId ? mods.filter(mod => mod.agents) : mods
      return dispatch($, enabled, runtime, heard, 'turn.complete', e, msg => next(msg))
    }).catch(($, e, next) => next(e))
  }

  if (uses('command.run')) {
    on('command.run', async ($, e, next) => dispatch($, enabled, runtime, mods, 'command.run', e, msg => next(msg))).catch(($, e, next) => next(e))
  }

  if (hasLayers) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => band($, e, await next(e), enabled)).catch(($, e, next) => next(e))
  }
}
