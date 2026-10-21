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
  RenderNode,
  TurnCompleteInput,
  TurnCompleteResult,
} from 'claude-code'

import { composite, encode, grid, resized } from './grid'
import type { Grid } from './grid'
import { STACK, keyOf, merge, plan } from './layers'
import type { Placed } from './layers'
import { alphaOf, apply, flip, isSettled } from './motion'
import type { Phase, Transition } from './motion'
import { run } from './pipeline'
import type { Entry, Fault, Step } from './pipeline'

export * from './components'
export * from './grid'
export * from './layers'
export * from './motion'
export * from './pipeline'

export const VERSION = '0.1.0'

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
type LayerBase<S> = {
  id: string
  z: number
  rows: number
  visible?(state: S | undefined): boolean
}
export type GridLayer<S> = LayerBase<S> & {
  slot?: string
  cover?: boolean
  animated?: boolean
  enter?: Transition
  exit?: Transition
  grid(view: View<S>): Grid
}
export type NodeLayer<S> = LayerBase<S> & { node(view: View<S> & { ui: ElementTable<'terminal'> }): RenderNode }
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
type Mounted = { key: string; raster: string; rows: number; members: Live[]; last: string }
type Band = { requestId: string; columns: number; slots: Mounted[] }
type Runtime = {
  session: string | null
  cache: Map<string, JsonValue | undefined>
  phases: Map<string, Phase>
  faults: Map<string, string>
  band: Band | null
  isStale: boolean
  ticker: { cancel: () => void } | null
}

const FRAME_MS = 33
const TICKERS = globalThis as { modkitTickers?: Record<string, { cancel: () => void } | undefined> }

const isGrid = (layer: Layer<any>): layer is GridLayer<any> => 'grid' in layer
const storeKey = (mod: string) => `modkit:${mod}`
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

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
      const cells = encode(paint($, kit, runtime, slot.members, band.columns, slot.rows, now))
      if (cells !== slot.last) {
        const blitted = await $.ui.blit({ requestId: band.requestId, key: slot.raster, cells })
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

export function defineMods(on: On, options: PluginOptions, kit: Kit) {
  const seen = new Set<string>()
  for (const mod of kit.mods) {
    if (seen.has(mod.id)) throw new Error(`modkit: two mods are named "${mod.id}"`)
    seen.add(mod.id)
  }
  const mods = kit.mods.filter(mod => options[mod.id] !== false)
  const runtime: Runtime = { session: null, cache: new Map(), phases: new Map(), faults: new Map(), band: null, isStale: false, ticker: null }
  const uses = (event: KitEvent) => mods.some(mod => (mod.on?.[event]?.length ?? 0) > 0)
  const lives: Live[] = mods.flatMap((mod, order) =>
    (mod.layers ?? []).map(layer => ({ mod, layer, order, key: `${mod.id}/${layer.id}` })),
  )
  const commands = mods.flatMap(mod => mod.commands ?? [])
  const noop = async () => undefined

  on('session.start', async ($, e, next) => {
    for (const command of commands) {
      await $.command.register(command).catch(error => $.ui.log(`${kit.plugin}: /${command.name} not registered: ${reason(error)}`))
    }
    await dispatch($, kit, runtime, mods, 'session', { reason: 'load' }, noop)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      stop(kit, runtime)
      runtime.session = null
      runtime.cache.clear()
      runtime.phases.clear()
      runtime.band = null
      $.ui.invalidate('ui.render')
      await dispatch($, kit, runtime, mods, 'session', { reason: 'clear' }, noop)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  if (uses('prompt.submit')) {
    on('prompt.submit', async ($, e, next) => dispatch($, kit, runtime, mods, 'prompt.submit', e, msg => next(msg))).catch(($, e, next) => next(e))
  }

  if (uses('turn.complete')) {
    on('turn.complete', async ($, e, next) => {
      const heard = e.agentId ? mods.filter(mod => mod.agents) : mods
      return dispatch($, kit, runtime, heard, 'turn.complete', e, msg => next(msg))
    }).catch(($, e, next) => next(e))
  }

  if (uses('command.run')) {
    on('command.run', async ($, e, next) => dispatch($, kit, runtime, mods, 'command.run', e, msg => next(msg))).catch(($, e, next) => next(e))
  }

  if (lives.length > 0) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      const below = await next(e)
      if (e.surface !== 'terminal' || e.props.hasSurvey) return below
      const ui = $.ui.resolve(e)
      const { Box, Raster } = ui
      const now = await $.clock.now()
      const columns = Math.max(1, Math.floor(e.props.bodyColumns))
      await load($, runtime, mods)

      const placed: (Placed & { live: Live })[] = []
      for (const live of lives) {
        const layer = live.layer
        const state = runtime.cache.get(live.mod.id)
        const isVisible = guarded($, kit, runtime, live, 'visible', false, () => layer.visible?.(state) ?? true)
        const enter = isGrid(layer) ? layer.enter : undefined
        const exit = isGrid(layer) ? layer.exit : undefined
        const before = runtime.phases.get(live.key) ?? { visible: false, since: -Infinity }
        const phase = flip(before, isVisible, now, enter, exit)
        runtime.phases.set(live.key, phase)
        if (!phase.visible && isSettled(phase, now, enter, exit)) continue
        const slot = isGrid(layer) ? (layer.slot ?? live.key) : live.key
        placed.push({ mod: live.mod.id, layer: layer.id, slot, order: live.order, z: layer.z, rows: layer.rows, cover: isGrid(layer) && Boolean(layer.cover), live })
      }

      const slots = plan(placed, e.props.maxRows)
      const mounted: Mounted[] = []
      const own = slots.map(slot => {
        const members = slot.members.map(member => placed.find(one => one.mod === member.mod && one.layer === member.layer)?.live).filter((live): live is Live => Boolean(live))
        const key = keyOf(slot.z, kit.plugin, slot.slot)
        const first = members[0]
        if (first && !isGrid(first.layer)) {
          const layer = first.layer
          const view = { columns, rows: slot.rows, now, since: runtime.phases.get(first.key)?.since ?? now, state: runtime.cache.get(first.mod.id), fx: fxOf($, kit.plugin, first.mod.id, runtime), ui }
          const node = guarded($, kit, runtime, first, 'node', null, () => layer.node(view))
          return (
            <Box key={key} height={slot.rows} overflow="hidden" flexDirection="column">
              {node}
            </Box>
          )
        }
        const raster = `modkit-${kit.plugin}-${slot.slot}`
        const cells = encode(paint($, kit, runtime, members, columns, slot.rows, now))
        mounted.push({ key, raster, rows: slot.rows, members, last: cells })
        return (
          <Box key={key} height={slot.rows}>
            <Raster key={raster} columns={columns} rows={slot.rows} cells={cells} />
          </Box>
        )
      })

      runtime.band = { requestId: e.requestId, columns, slots: mounted }
      runtime.isStale = false
      if (mounted.some(slot => isMoving(runtime, slot.members, now))) tick($, kit, runtime)
      const isCovered = slots.some(slot => slot.members.some(member => member.cover))
      return (
        <Box key={STACK} flexDirection="column">
          {isCovered ? own : merge(own, below)}
        </Box>
      )
    }).catch(($, e, next) => next(e))
  }
}
