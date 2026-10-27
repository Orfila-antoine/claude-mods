import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentView, BandView, EtaState, MainView } from '../types'
import { DEFAULT, band, grid, modFx, put } from './modkit'
import type { Grid, Kit, Mod } from './modkit'
import {
  MIN_SIMILAR,
  bucketOf,
  cells,
  costOf,
  estimate,
  extract,
  hms,
  isReliable,
  isUserTurn,
  median,
  remaining,
  remainingOfMax,
  taskRemaining,
  type Bucket,
  type Point,
  type Remaining,
  type TurnRecord,
  type Unit,
} from './estimate'

const HISTORY_KEY = 'history'
const AGENTS_KEY = 'agents'
const SUGGESTIONS_KEY = 'suggestions'
const TASKS_KEY = 'tasks'
const HISTORY_CAP = 600
const TASKS_CAP = 300
const SUGGESTION_TTL_MS = 30 * 60_000
const SUGGESTION_RETRY_MS = 60_000
const AGENT_SILENCE_MS = 120_000
const ENDED_SHOWN_MS = 10_000
const ENDED_KEPT_MS = 60_000
const AGENT_ROWS = 4
const NAME_CELLS = 24
const DETAIL_CELLS = 24
const GUIDANCE: Record<Bucket, string> = {
  short: 'under 5 minutes: a review, some triage or a short reply',
  medium: '5 to 20 minutes: a small bounded task',
  long: '20 to 60 minutes: a ticket that really moves forward',
  'very-long': 'over an hour: a deep ticket, the highest priority one',
}

type Run = {
  startedAt: number
  pausedMs: number
  waitingSince: number | null
  deadline: number | null
  unit: Unit
  sample: Point[]
  p50Raw: number
  similar: number
}
type Main = Run & {
  id: string
  prompts: number
  turnTasks: Set<string>
  hadAgents: boolean
  agentsStarted: number
  lastAgentEndAt: number | null
  tailS: number
  isReliable: boolean
  plan: string
}
type Agent = Run & {
  id: string
  name: string
  model: string | null
  effort: string | null
  tool: string | null
  status: AgentView['status']
  endedAt: number | null
  lastSeen: number
  usd: number
  isPriced: boolean
  isAdopted: boolean
}
type Spawn = { run: Run; name: string; type: string; model: string | null; at: number }
type Task = { status: string; startedAt: number | null }
type Flight = { agentId: string | undefined; tool: string; isAsked: boolean }
type Suggestion = { text: string; at: number; mtime: number }
type Bead = { id: string; title: string; status: string; priority: number; issue_type?: string; updated_at?: string; dependencies?: { type: string; depends_on_id: string }[] }

let snapshot: BandView | null = null
let main: Main | null = null
const agents = new Map<string, Agent>()
const spawns = new Map<string, Spawn>()
const tasks = new Map<string, Task>()
let learnedTasks: number[] = []
let isTaskLearnt = false
let lastTaskEventAt: number | null = null
const flights = new Map<string, Flight>()
let suggestions: Record<string, Suggestion> = {}
const pending = new Set<string>()
const lastTry = new Map<string, number>()
let ticker: Timer | null = null
let isRefreshing = false
let isStale = false

const round1 = (n: number) => Math.round(n * 10) / 10

async function stored($: EngineInterface, key: string): Promise<TurnRecord[]> {
  const value = await $.store.get(key)
  return Array.isArray(value) ? (value as TurnRecord[]) : []
}

async function append($: EngineInterface, key: string, record: TurnRecord): Promise<void> {
  await $.store.set(key, [...(await stored($, key)), record].slice(-HISTORY_CAP))
}

function elapsedOf(run: Run, now: number, end: number | null = null): number {
  const until = end ?? now
  const waiting = run.waitingSince === null ? 0 : until - run.waitingSince
  return Math.max(0, (until - run.startedAt - run.pausedMs - waiting) / 1000)
}

function endWait(run: Run, now: number): void {
  if (run.waitingSince === null) return
  const waited = now - run.waitingSince
  run.pausedMs += waited
  if (run.deadline !== null) run.deadline += waited
  run.waitingSince = null
}

function startRun(unit: Unit, past: readonly TurnRecord[], now: number): Run {
  const est = estimate(unit, past, now / 1000)
  return { startedAt: now, pausedMs: 0, waitingSince: null, deadline: null, unit, sample: est.sample, p50Raw: est.p50Raw, similar: est.similar }
}

function hold(run: Run, now: number, r: Remaining): Remaining {
  const proposed = now + r.p50 * 1000
  if (run.deadline === null || proposed < run.deadline) run.deadline = proposed
  const left = (run.deadline - now) / 1000
  return r.overdue || left <= 0 ? { ...r, p50: 0, overdue: true } : { ...r, p50: left }
}

function shortModel(model: string | null): string | null {
  const found = model?.match(/(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/)
  if (!found) return model
  return `${found[1]} ${found[2]}${found[3] ? `.${found[3]}` : ''}`
}

function describe(tool: string, input: Record<string, unknown>): string {
  const pick = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const path = pick('file_path') || pick('path') || pick('notebook_path')
  const target = path ? (path.split(/[\\/]/).pop() ?? path) : pick('description') || pick('pattern') || pick('query') || pick('command')
  return `${tool.replace(/^mcp__[^_]+__/, '')}${target ? ` ${target}` : ''}`.slice(0, 40)
}

function fromSpawn(agentId: string, spawn: Spawn, now: number): Agent {
  const agent: Agent = {
    ...spawn.run,
    id: agentId,
    name: spawn.name,
    model: spawn.model,
    effort: null,
    tool: null,
    status: 'running',
    endedAt: null,
    lastSeen: now,
    usd: 0,
    isPriced: true,
    isAdopted: false,
  }
  agents.set(agentId, agent)
  noteAgent()
  return agent
}

function noteAgent(): void {
  if (!main) return
  main.hadAgents = true
  main.agentsStarted += 1
}

async function agentFor($: EngineInterface, agentId: string): Promise<Agent> {
  const now = await $.clock.now()
  const known = agents.get(agentId)
  if (known) {
    if (known.endedAt !== null) Object.assign(known, { status: 'running', endedAt: null, startedAt: now, pausedMs: 0, waitingSince: null, deadline: null })
    known.lastSeen = now
    return known
  }
  const info = (await $.agent.list()).find(one => one.id === agentId)
  const waiting = [...spawns.entries()].filter(([, s]) => s.type === (info?.type ?? s.type))
  const match = waiting.find(([, s]) => info?.description !== undefined && s.name === info.description.slice(0, 40)) ?? (waiting.length === 1 ? waiting[0] : undefined)
  if (match) {
    spawns.delete(match[0])
    return fromSpawn(agentId, match[1], now)
  }
  const type = info?.type ?? 'agent'
  const unit: Unit = { f: extract(info?.description ?? ''), agent: type }
  const past = (await stored($, AGENTS_KEY)).filter(r => r.agent === type)
  const agent: Agent = {
    ...startRun(unit, past, now),
    id: agentId,
    name: (info?.name ?? info?.description ?? type).slice(0, 40),
    model: null,
    effort: null,
    tool: null,
    status: 'running',
    endedAt: null,
    lastSeen: now,
    usd: 0,
    isPriced: true,
    isAdopted: true,
  }
  agents.set(agentId, agent)
  noteAgent()
  return agent
}

function finish(agent: Agent, status: AgentView['status'], now: number): void {
  endWait(agent, now)
  agent.status = status
  agent.endedAt = now
  agent.tool = null
  if (main) main.lastAgentEndAt = now
}

function setTask(id: string, task: Task, status: string, now: number): void {
  if (status === 'deleted') {
    tasks.delete(id)
    return
  }
  if (status === 'in_progress' && task.status !== 'in_progress') task.startedAt = now
  if (status === 'completed' && task.status !== 'completed') {
    const from = task.startedAt ?? lastTaskEventAt
    if (from !== null && now > from) {
      learnedTasks = [...learnedTasks, round1((now - from) / 1000)].slice(-TASKS_CAP)
      isTaskLearnt = true
    }
    lastTaskEventAt = now
  }
  task.status = status
  tasks.set(id, task)
}

function candidates(jsonl: string): Bead[] {
  const beads = jsonl.split('\n').flatMap(line => {
    try {
      return line.trim() ? [JSON.parse(line) as Bead] : []
    } catch {
      return []
    }
  })
  const closed = new Set(beads.filter(b => b.status === 'closed').map(b => b.id))
  return beads
    .filter(b => (b.status === 'open' || b.status === 'in_progress') && b.issue_type !== 'epic' && typeof b.title === 'string')
    .filter(b => !(b.dependencies ?? []).some(d => d.type === 'blocks' && !closed.has(d.depends_on_id)))
    .sort((a, b) => a.priority - b.priority || (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
    .slice(0, 30)
}

async function forget($: EngineInterface, key: string): Promise<void> {
  if (!(key in suggestions)) return
  const { [key]: _, ...rest } = suggestions
  suggestions = rest
  await $.store.set(SUGGESTIONS_KEY, suggestions)
}

async function suggest($: EngineInterface, root: string, bucket: Bucket, minutes: number, key: string): Promise<void> {
  pending.add(key)
  try {
    const path = `${root}/.beads/issues.jsonl`
    const stat = await $.fs.stat(path).catch(() => null)
    if (stat === null) return await forget($, key)
    const now = await $.clock.now()
    const cached = suggestions[key]
    if (cached && cached.mtime === stat.mtimeMs && now - cached.at < SUGGESTION_TTL_MS) return
    const list = candidates(await $.fs.read(path))
    if (list.length === 0) return await forget($, key)
    const lines = list.map(b => `- [P${b.priority}, ${b.status}] ${b.title.slice(0, 110)}`).join('\n')
    const reply = await $.model.complete({
      model: 'haiku',
      maxTokens: 120,
      prompt:
        `A developer is waiting about ${minutes} minutes for their agent to finish. ` +
        `These are their open tickets (P0 = urgent):\n${lines}\n\n` +
        `Pick ONE ticket from this list to do or move forward in ${GUIDANCE[bucket]}. ` +
        'Reply with a single line in English, 60 characters at most, starting with an imperative verb ' +
        'and naming the ticket by a few words of its title. No preamble.',
    })
    if (!reply.isAnswered) return
    const text = (reply.text.trim().split('\n')[0] ?? '').slice(0, 80)
    if (!text) return
    suggestions = { ...suggestions, [key]: { text, at: now, mtime: stat.mtimeMs } }
    await $.store.set(SUGGESTIONS_KEY, suggestions)
  } catch {
    return
  } finally {
    pending.delete(key)
  }
  await refresh($)
}

async function reconcile($: EngineInterface, now: number): Promise<void> {
  const live = [...agents.values()].filter(a => a.endedAt === null)
  if (live.length === 0) return
  const list = await $.agent.list()
  for (const agent of live) {
    const info = list.find(one => one.id === agent.id)
    if (info?.status === 'completed' || info?.status === 'idle') finish(agent, 'done', now)
    else if (info?.status === 'failed' || info?.status === 'killed') finish(agent, 'failed', now)
    else if (!info && now - agent.lastSeen > AGENT_SILENCE_MS) finish(agent, 'lost', now)
  }
}

function shift(r: Remaining, byS: number): Remaining {
  return { p10: r.p10 + byS, p50: r.p50 + byS, p90: r.p90 + byS, overdue: r.overdue }
}

async function compute($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await reconcile($, now)
  if (isTaskLearnt) {
    isTaskLearnt = false
    await $.store.set(TASKS_KEY, learnedTasks)
  }
  for (const [id, agent] of agents) if (agent.endedAt !== null && now - agent.endedAt > ENDED_KEPT_MS) agents.delete(id)

  const shown = [...agents.values()]
    .filter(a => a.endedAt === null || now - a.endedAt < ENDED_SHOWN_MS)
    .sort((a, b) => Number(a.endedAt !== null) - Number(b.endedAt !== null) || b.startedAt - a.startedAt)
  const running = shown.filter(a => a.status === 'running')
  const hasEta = (a: Agent) => Math.round(a.similar) >= MIN_SIMILAR
  const agentsMax = running.length > 0 && running.every(hasEta)
    ? remainingOfMax(running.map(a => ({ sample: a.sample, elapsedS: elapsedOf(a, now) })))
    : null

  const m = main
  let mainView: MainView | null = null
  if (m && m.waitingSince !== null) {
    mainView = { mode: 'waiting', elapsedS: elapsedOf(m, now) }
  } else if (m) {
    const similar = Math.round(m.similar)
    const elapsedS = elapsedOf(m, now)
    const list = [...m.turnTasks].flatMap(id => tasks.get(id) ?? [])
    const total = list.length
    const done = list.filter(t => t.status === 'completed').length
    const current = list.find(t => t.status === 'in_progress')
    const taskRem =
      total > done
        ? taskRemaining(
            learnedTasks.slice(-50),
            list.filter(t => t.status === 'pending').length,
            current?.startedAt == null ? null : (now - current.startedAt) / 1000,
          )
        : null
    const evidence = [
      taskRem === null ? null : { remS: taskRem, basis: 'tasks' as const },
      agentsMax === null ? null : { remS: shift(agentsMax, m.tailS).p50, basis: 'agents' as const },
    ].filter(item => item !== null)
    const longest = evidence.sort((a, b) => b.remS - a.remS)[0]
    let r: Remaining | null = null
    let basis: 'history' | 'tasks' | 'agents' = 'history'
    if (longest) {
      r = { p10: longest.remS, p50: longest.remS, p90: longest.remS, overdue: false }
      basis = longest.basis
    } else if (m.isReliable && similar >= MIN_SIMILAR) {
      r = remaining(m.sample, elapsedS)
    }
    const plan = `${total}|${m.agentsStarted}`
    if (plan !== m.plan) {
      m.plan = plan
      m.deadline = null
    }
    const held = r === null ? null : hold(m, now, r)
    mainView = held === null
      ? { mode: 'working', elapsedS }
      : { mode: 'eta', done, total, remS: held.p50, elapsedS, overdue: held.overdue, basis, similar }
  } else if (agentsMax) {
    const elapsedS = Math.max(...running.map(a => elapsedOf(a, now)))
    mainView = { mode: 'eta', done: 0, total: 0, remS: agentsMax.p50, elapsedS, overdue: false, basis: 'agents', similar: 0 }
  }

  let suggestion: BandView['suggestion'] = null
  if (mainView?.mode === 'eta' && !mainView.overdue) {
    const bucket = bucketOf(mainView.remS)
    if (bucket) {
      const root = await $.session.root()
      const key = `${root}|${bucket}`
      const minutes = Math.max(1, Math.round(mainView.remS / 60))
      if (!pending.has(key) && now - (lastTry.get(key) ?? 0) >= SUGGESTION_RETRY_MS) {
        lastTry.set(key, now)
        void suggest($, root, bucket, minutes, key)
      }
      const cached = suggestions[key]
      if (cached && now - cached.at < SUGGESTION_TTL_MS) suggestion = cached.text
    }
  }

  const agentViews: AgentView[] = shown.slice(0, AGENT_ROWS).map(a => {
    const r = a.status === 'running' && hasEta(a) ? hold(a, now, remaining(a.sample, elapsedOf(a, now))) : null
    return {
      id: a.id,
      name: a.name,
      model: shortModel(a.model),
      effort: a.effort,
      tool: a.tool,
      status: a.status,
      elapsedS: elapsedOf(a, now, a.endedAt),
      remS: r && !r.overdue ? r.p50 : null,
      overdue: r?.overdue ?? false,
      costUsd: a.isPriced && a.usd > 0 ? a.usd : null,
      isAdopted: a.isAdopted,
    }
  })
  for (const [id, spawn] of spawns) if (now - spawn.at > ENDED_KEPT_MS) spawns.delete(id)

  const next: BandView | null =
    mainView === null && agentViews.length === 0
      ? null
      : { main: mainView, agents: agentViews, more: Math.max(0, shown.length - AGENT_ROWS), suggestion }
  snapshot = next
  const rows = next === null ? 0 : lines(next, Number.POSITIVE_INFINITY).length
  const fx = modFx($, KIT, 'eta')
  if (((await fx.state<EtaState>())?.rows ?? 0) !== rows) await fx.setState<EtaState>(() => ({ rows }))
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    isStale = true
    return
  }
  isRefreshing = true
  try {
    do {
      isStale = false
      await compute($)
    } while (isStale)
  } catch {
    return
  } finally {
    isRefreshing = false
  }
}

type Tone = 'strong' | 'normal' | 'dim' | 'warning' | 'permission' | 'error' | 'suggestion'
type Segment = { text: string; tone: Tone }
type Line = { segments: Segment[] }
type Slot = { rank: number; segments: Segment[] }

const TONES: Record<Tone, number> = {
  strong: 0xffffff,
  normal: DEFAULT,
  dim: 0x8a8a8a,
  warning: 0xe0af68,
  permission: 0xbb9af7,
  error: 0xf7768e,
  suggestion: 0x7aa2f7,
}
const GLYPHS: Record<AgentView['status'], Segment> = {
  running: { text: '●', tone: 'normal' },
  waiting: { text: '!', tone: 'permission' },
  done: { text: '✓', tone: 'dim' },
  failed: { text: '✗', tone: 'error' },
  lost: { text: '?', tone: 'warning' },
}

function cutWords(text: string, width: number): string {
  if (cells(text) <= width) return text
  let kept = ''
  for (const char of text) {
    if (cells(kept + char) > width - 1) break
    kept += char
  }
  const space = kept.lastIndexOf(' ')
  return `${space > width / 2 ? kept.slice(0, space) : kept.trimEnd()}…`
}

const dimNote = (text: string): Segment => ({ text: ` · ${text}`, tone: 'dim' })

function mainLine(m: MainView, columns: number): Segment[] {
  if (m.mode === 'waiting') {
    return [{ text: columns < 60 ? '! waiting' : '! waiting for your answer', tone: 'permission' }, dimNote(`${hms(m.elapsedS)} elapsed`)]
  }
  if (m.mode === 'working') return [{ text: `working · ${hms(m.elapsedS)} elapsed`, tone: 'dim' }]
  const isWide = columns >= 90
  const done = Math.min(Math.max(m.done, 0), m.total)
  const tasks = m.total > 0 ? [dimNote(`tasks ${done}/${m.total}`)] : []
  if (m.overdue) return [{ text: 'longer than usual', tone: 'warning' }, dimNote(`${hms(m.elapsedS)} elapsed`), ...tasks]
  const note =
    m.basis === 'agents'
      ? [dimNote('until the agents finish')]
      : m.basis === 'history' && isWide
        ? [dimNote(`from ${m.similar} past turns`)]
        : []
  return [{ text: `${hms(m.remS)} left`, tone: 'strong' }, ...tasks, ...note]
}

function agentSlots(a: AgentView): (Slot | null)[] {
  const isEnded = a.status === 'done' || a.status === 'lost'
  const detail =
    a.status === 'waiting'
      ? 'needs your approval'
      : a.status === 'lost'
        ? 'end never received'
        : a.status === 'failed'
          ? 'failed'
          : a.status === 'running'
            ? a.tool
            : null
  const detailTone: Tone = a.status === 'waiting' ? 'permission' : a.status === 'lost' ? 'warning' : a.status === 'failed' ? 'error' : 'dim'
  const time: Segment = a.overdue
    ? { text: 'longer than usual', tone: 'warning' }
    : a.remS !== null
      ? { text: `${hms(a.remS)} left`, tone: 'normal' }
      : a.isAdopted && !isEnded
        ? { text: 'running', tone: 'dim' }
        : { text: `${hms(a.elapsedS)}${a.status === 'waiting' ? ' elapsed' : ''}`, tone: 'dim' }
  return [
    { rank: 0, segments: [GLYPHS[a.status], { text: ` ${cutWords(a.name, NAME_CELLS)}`, tone: isEnded ? 'dim' : 'normal' }] },
    detail ? { rank: a.status === 'running' ? 1 : 0, segments: [{ text: cutWords(detail, DETAIL_CELLS), tone: detailTone }] } : null,
    a.model ? { rank: 2, segments: [{ text: `${a.model}${a.effort ? ` ${a.effort}` : ''}`, tone: 'dim' }] } : null,
    { rank: 0, segments: [time] },
    a.costUsd === null ? null : { rank: 3, segments: [{ text: `$${a.costUsd.toFixed(2)}`, tone: 'dim' }] },
  ]
}

const slotCells = (slot: Slot | null) => (slot ? slot.segments.reduce((n, s) => n + cells(s.text), 0) : 0)
const lineCells = (segments: readonly Segment[]) => segments.reduce((n, s) => n + cells(s.text), 0)

function agentLines(views: readonly AgentView[], columns: number): Line[] {
  const rows = views.map(agentSlots)
  const widths = [0, 1, 2, 3, 4].map(i => Math.max(0, ...rows.map(row => slotCells(row[i] ?? null))))
  const build = (limit: number) => {
    const included = widths.map((_, i) => rows.some(row => (row[i]?.rank ?? 99) <= limit))
    const last = included.lastIndexOf(true)
    return rows.map(row => {
      const segments: Segment[] = [{ text: ' ', tone: 'dim' }]
      included.forEach((isIn, i) => {
        if (!isIn) return
        const slot = row[i] ?? null
        segments.push({ text: i === 0 ? ' ' : '  ', tone: 'dim' })
        if (slot) segments.push(...slot.segments)
        const pad = i === last ? 0 : (widths[i] ?? 0) - slotCells(slot)
        if (pad > 0) segments.push({ text: ' '.repeat(pad), tone: 'dim' })
      })
      return segments
    })
  }
  let limit = 3
  let built = build(limit)
  while (limit > 0 && built.some(segments => lineCells(segments) > columns)) {
    limit -= 1
    built = build(limit)
  }
  return built.map(segments => ({ segments }))
}

function lines(v: BandView, columns: number): Line[] {
  const out: Line[] = []
  if (v.main) out.push({ segments: mainLine(v.main, columns) })
  out.push(...agentLines(v.agents, columns))
  if (v.more > 0) out.push({ segments: [{ text: `  +${v.more} more agent${v.more > 1 ? 's' : ''}`, tone: 'dim' }] })
  if (v.suggestion) {
    const segments: Segment[] =
      columns >= 80
        ? [{ text: '  meanwhile: ', tone: 'dim' }, { text: v.suggestion, tone: 'suggestion' }]
        : [{ text: `  ${v.suggestion}`, tone: 'suggestion' }]
    out.push({ segments })
  }
  return out
}

function paint(g: Grid, v: BandView | null, columns: number, rows: number): void {
  if (v === null) return
  lines(v, columns)
    .slice(0, rows)
    .forEach((line, y) => {
      const chars = line.segments.flatMap(segment => [...segment.text].map(char => ({ char, fg: TONES[segment.tone] })))
      const fits = chars.length <= columns
      chars.slice(0, columns).forEach((cell, x) => put(g, x, y, !fits && x === columns - 1 ? '…' : cell.char, cell.fg))
    })
}

const eta: Mod<EtaState> = {
  id: 'eta',
  layers: [
    {
      id: 'band',
      z: 60,
      priority: 70,
      rows: ({ state }) => Math.max(1, state?.rows ?? 1),
      visible: state => (state?.rows ?? 0) > 0,
      animated: true,
      enter: { kind: 'fade', ms: 250 },
      exit: { kind: 'fade', ms: 250 },
      grid({ columns, rows }) {
        const g = grid(columns, rows)
        paint(g, snapshot, columns, rows)
        return g
      },
    },
  ],
}

const KIT: Kit = { plugin: 'eta-band', mods: [eta] }

type Finished = {
  tool: string
  id: string
  result: { agentId?: string; task?: { id?: string }; statusChange?: { from: string; to: string } } | undefined
  taskId: string | undefined
  todos: { content: string; status: string }[] | undefined
}

function afterTool(call: Finished, now: number): void {
  const spawn = spawns.get(call.id)
  if (call.tool === 'Agent' && call.result?.agentId && spawn) {
    spawns.delete(call.id)
    if (!agents.has(call.result.agentId)) fromSpawn(call.result.agentId, spawn, now)
  }
  if (call.tool !== 'TaskCreate' && call.tool !== 'TaskUpdate' && call.tool !== 'TodoWrite') return
  lastTaskEventAt ??= now
  const created = call.result?.task?.id
  const change = call.result?.statusChange
  if (call.tool === 'TaskCreate' && created) {
    tasks.set(created, { status: 'pending', startedAt: null })
    main?.turnTasks.add(created)
  }
  if (call.tool === 'TaskUpdate' && call.taskId && change) {
    setTask(call.taskId, tasks.get(call.taskId) ?? { status: change.from, startedAt: null }, change.to, now)
    main?.turnTasks.add(call.taskId)
  }
  if (call.todos) {
    const seen = new Set<string>()
    for (const todo of call.todos) {
      const id = `todo:${todo.content}`
      seen.add(id)
      setTask(id, tasks.get(id) ?? { status: 'pending', startedAt: null }, todo.status, now)
      main?.turnTasks.add(id)
    }
    for (const id of [...tasks.keys()]) if (id.startsWith('todo:') && !seen.has(id)) tasks.delete(id)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const [saved, learnt] = await Promise.all([$.store.get(SUGGESTIONS_KEY), $.store.get(TASKS_KEY)])
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) suggestions = saved as typeof suggestions
    if (Array.isArray(learnt)) learnedTasks = learnt.filter((value): value is number => typeof value === 'number')
    ticker?.cancel()
    ticker = $.clock.every(1000, () => void refresh($))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await agentFor($, e.agentId)
      void refresh($)
      return next(e)
    }
    const f = extract(e.text)
    if (f.kind === 'notification') return next(e)
    const [now, project, model, history] = await Promise.all([$.clock.now(), $.session.root(), $.session.model(), stored($, HISTORY_KEY)])
    const past = history.filter(isUserTurn)
    const tails = past.flatMap(r => (r.tailS === undefined ? [] : [r.tailS])).slice(-50)
    main = {
      ...startRun({ f, project, model }, past, now),
      id: e.turnId,
      prompts: 1,
      turnTasks: new Set(),
      hadAgents: false,
      agentsStarted: 0,
      lastAgentEndAt: null,
      tailS: tails.length >= MIN_SIMILAR ? (median(tails) ?? 0) : 0,
      isReliable: isReliable(past),
      plan: '0|0',
    }
    void refresh($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (main && e.turnId === main.id) main.prompts += 1
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    const now = await $.clock.now()
    const type = e.subagentType
    const unit: Unit = { f: extract(e.prompt), agent: type, model: started.model }
    const past = (await stored($, AGENTS_KEY)).filter(r => r.agent === type)
    const spawn: Spawn = { run: startRun(unit, past, now), name: (e.description || type).slice(0, 40), type, model: started.model, at: now }
    if (started.agentId && !agents.has(started.agentId)) fromSpawn(started.agentId, spawn, now)
    else if (!started.agentId) spawns.set(e.tool_use_id, spawn)
    void refresh($)
    return started
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const effort = e.effort === undefined ? null : String(e.effort)
    if (e.agentId !== undefined) {
      const agent = await agentFor($, e.agentId)
      agent.model = e.model
      agent.effort = effort
      agent.unit = { ...agent.unit, model: e.model, effort: effort ?? undefined }
      if (result.usage) {
        const usd = costOf(result.usage.model || e.model, result.usage)
        if (usd === null) agent.isPriced = false
        else agent.usd += usd
      }
    } else if (main) {
      main.unit = { ...main.unit, effort: effort ?? undefined }
    }
    return result
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const agentId = e.agent_id
    const open = [...flights.values()].filter(f => f.agentId === agentId && !f.isAsked)
    const flight = open.find(f => f.tool === e.tool_name) ?? open[0]
    const run = agentId === undefined ? main : agents.get(agentId)
    if (flight && run) {
      flight.isAsked = true
      run.waitingSince ??= await $.clock.now()
      if ('status' in run) run.status = 'waiting'
      void refresh($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const flight: Flight = { agentId: e.agentId, tool: e.tool, isAsked: false }
    flights.set(e.tool_use_id, flight)
    if (e.agentId !== undefined) {
      const agent = await agentFor($, e.agentId)
      agent.tool = describe(e.tool, e as unknown as Record<string, unknown>)
    } else if (main && (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode')) {
      flight.isAsked = true
      main.waitingSince ??= await $.clock.now()
    } else if (e.tool === 'Agent' && !spawns.has(e.tool_use_id)) {
      const now = await $.clock.now()
      const type = e.subagent_type ?? 'general-purpose'
      const past = (await stored($, AGENTS_KEY)).filter(r => r.agent === type)
      const unit: Unit = { f: extract(e.prompt), agent: type }
      spawns.set(e.tool_use_id, { run: startRun(unit, past, now), name: (e.description || type).slice(0, 40), type, model: e.model ?? null, at: now })
    }
    void refresh($)
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      flights.delete(e.tool_use_id)
      if (flight.isAsked) {
        const run = flight.agentId === undefined ? main : agents.get(flight.agentId)
        if (run) {
          endWait(run, await $.clock.now())
          if ('status' in run && run.status === 'waiting') run.status = 'running'
        }
      }
    }
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      const call: Finished = {
        tool: e.tool,
        id: e.tool_use_id,
        result: ran.result as Finished['result'],
        taskId: e.tool === 'TaskUpdate' ? e.taskId : undefined,
        todos: e.tool === 'TodoWrite' ? e.todos.map(todo => ({ content: todo.content, status: todo.status })) : undefined,
      }
      afterTool(call, await $.clock.now())
    }
    void refresh($)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId !== undefined) {
      const agent = agents.get(e.agentId)
      if (agent && agent.endedAt === null) {
        finish(agent, e.reason === 'answer' ? 'done' : 'failed', now)
        const durS = (e.durationMs - agent.pausedMs) / 1000
        if (e.reason === 'answer' && durS >= 1) {
          await append($, AGENTS_KEY, { ...agent.unit, durS: round1(durS), endedAt: Math.round(now / 1000), predP50: round1(agent.p50Raw) })
        }
      }
      void refresh($)
      return next(e)
    }
    if (main === null || e.turnId !== main.id) return next(e)
    const m = main
    main = null
    endWait(m, now)
    const durS = (e.durationMs - m.pausedMs) / 1000
    if (e.reason === 'answer' && m.prompts === 1 && durS >= 1) {
      await append($, HISTORY_KEY, {
        ...m.unit,
        durS: round1(durS),
        endedAt: Math.round(now / 1000),
        predP50: round1(m.p50Raw),
        tailS: m.hadAgents && m.lastAgentEndAt !== null ? round1((now - m.lastAgentEndAt) / 1000) : undefined,
      })
    }
    void refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => band($, e, await next(e), KIT)).catch(($, e, next) => next(e))
}
