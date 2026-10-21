import type { EngineInterface, Register } from 'claude-code'

import type { Claim, Picker } from '../types'
import { band, grid, modFx, put, text } from './modkit'
import type { Kit, Mod, Room } from './modkit'
import { CHALLENGE, IDEAS, PROMPT_TYPES, REFINER, REWRITE_DIRECTION, NEXT_MOVES, SCOUT, SCOUT_TASK, WRITER, fill } from './prompts'

type Undo = { draft: string; written: string }
type BackstageState = {
  busy: string | null
  picker: Picker | null
  undo: Undo | null
  scoutId: string | null
  percent: number
  isHandingOff: boolean
  suggestions: string[]
  suggestSince: number | null
  revealSince: number | null
}

const EMPTY: BackstageState = {
  busy: null,
  picker: null,
  undo: null,
  scoutId: null,
  percent: 0,
  isHandingOff: false,
  suggestions: [],
  suggestSince: null,
  revealSince: null,
}

const ID = 'backstage'
const SCOUT_AGENT = 'backstage:scout'
const HANDOFF_FROM_PERCENT = 50
const HANDOFF_HEADING = '# Session Handoff'
const SENT_ROWS = 6
const SENT_ROW_CHARS = 1500
const SUGGEST_ROWS = 10
const VERDICT = /^(CONFIRMED|REFUTED|INCONCLUSIVE)\b/
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const TRAIL = 7
const FRAME_MS = 100
const REVEAL_FRAMES = 10
const PREFIX = 6
const DIM = 0x6c6c6c
const SOFT = 0xb0b0b0
const BRIGHT = 0xffffff

const noop = () => undefined
const glyph = () => ALNUM[Math.floor(Math.random() * ALNUM.length)] ?? ' '
const textWidthOf = (columns: number) => Math.max(10, columns - PREFIX)
const isLoading = (state: BackstageState) => state.suggestSince !== null
const wantsBelow = (state: BackstageState, isWorking: boolean) =>
  !state.busy && !state.picker && !isWorking && (isLoading(state) || state.suggestions.length > 0)
const fullRows = (suggestions: string[], columns: number) =>
  suggestions.reduce((rows, line) => rows + Math.ceil((line.length + 1) / textWidthOf(columns)), 0)
const stateOf = (room: { state: BackstageState | undefined }) => ({ ...EMPTY, ...room.state })

function rainRow(width: number, row: number, frame: number) {
  const glyphs = Array.from({ length: width }, glyph)
  const head = ((frame + row * 9) % (width + TRAIL)) - 1
  const trailStart = Math.max(0, head - TRAIL)
  return glyphs.map((ch, x) => ({ ch, fg: x === head ? BRIGHT : x >= trailStart && x < head ? SOFT : DIM }))
}

function decodeRow(line: string, width: number, row: number, step: number) {
  const visible = line.slice(0, width)
  const resolved = Math.max(0, Math.floor((step / REVEAL_FRAMES) * visible.length * 1.3) - row * 3)
  return [...visible].map((ch, x) => (x < resolved ? { ch, fg: BRIGHT } : { ch: glyph(), fg: DIM }))
}

function separator(columns: number) {
  return '─'.repeat(Math.max(0, columns - 1))
}

const backstage: Mod<BackstageState> = {
  id: ID,
  layers: [
    {
      id: 'bar',
      z: 50,
      rows: 1,
      node({ ui, state, fx, isWorking }) {
        const { Box, Button, Text } = ui
        const current = { ...EMPTY, ...state }
        if (current.busy) return <Text dimColor>{current.busy}</Text>
        const set = (patch: Partial<BackstageState>) => fx.setState<BackstageState>(s => ({ ...EMPTY, ...s, ...patch }))
        if (current.picker) {
          const menu =
            current.picker === 'idea'
              ? { title: 'Refine', items: Object.entries(IDEAS).map(([kind, idea]) => ({ key: `idea-${kind}`, label: idea.label })) }
              : { title: 'Prompt type', items: Object.entries(PROMPT_TYPES).map(([kind, type]) => ({ key: `type-${kind}`, label: type.label })) }
          return (
            <Box flexWrap="wrap">
              <Text dimColor>{menu.title}: </Text>
              {menu.items.map((item, i) => (
                <Button key={item.key} hotkey={String(i + 1)} label={item.label} onPress={noop} />
              ))}
              <Button key="cancel" hotkey="c" label="Cancel" onPress={() => set({ picker: null })} />
            </Box>
          )
        }
        const percent = current.percent
        return (
          <Box>
            <Button key="rewrite" hotkey="r" label="✨✏️" onPress={noop} />
            <Button key="ideas" hotkey="i" label="Refine…" onPress={() => set({ picker: 'idea' })} />
            <Button key="pick" hotkey="w" label="Write prompt…" onPress={() => set({ picker: 'type' })} />
            <Button key="verify" hotkey="v" label={current.scoutId ? 'Verifying…' : 'Verify'} onPress={noop} />
            {current.undo && <Button key="undo" hotkey="u" label="Undo" onPress={noop} />}
            {percent >= HANDOFF_FROM_PERCENT && !isWorking && (
              <Button key="handoff" hotkey="p" onPress={noop}>
                <Text color={percent > 80 ? 'red' : percent > 50 ? 'yellow' : 'green'}>Handoff → /new</Text>
              </Button>
            )}
          </Box>
        )
      },
    },
    {
      id: 'loading',
      slot: 'suggest',
      z: 40,
      rows: 4,
      animated: true,
      visible: (state, room) => {
        const current = stateOf(room)
        return wantsBelow(current, room.isWorking) && isLoading(current)
      },
      grid({ columns, rows, now, state }) {
        const current = { ...EMPTY, ...state }
        const g = grid(columns, rows)
        text(g, 0, 0, separator(columns), DIM)
        const width = textWidthOf(columns)
        const revealing = current.revealSince !== null
        const frame = Math.floor((now - (revealing ? (current.revealSince ?? now) : (current.suggestSince ?? now))) / FRAME_MS)
        const lines = revealing ? current.suggestions : [0, 1, 2].map(() => '')
        lines.forEach((line, row) => {
          text(g, 0, row + 1, `[ ${row + 1} ] `, DIM)
          const cells = revealing ? decodeRow(line, width, row, frame) : rainRow(width, row, frame)
          cells.forEach((cell, x) => put(g, PREFIX + x, row + 1, cell.ch, cell.fg))
        })
        return g
      },
    },
    {
      id: 'choices',
      z: 40,
      rows: (room: Room<BackstageState>) => {
        const current = stateOf(room)
        const full = 1 + fullRows(current.suggestions, room.columns)
        return room.maxRows - 1 >= full ? full : 1 + current.suggestions.length
      },
      visible: (state, room) => {
        const current = stateOf(room)
        return wantsBelow(current, room.isWorking) && !isLoading(current)
      },
      node({ ui, state, columns, rows }) {
        const { Box, Button, Text } = ui
        const current = { ...EMPTY, ...state }
        const isCompact = rows < 1 + fullRows(current.suggestions, columns)
        return (
          <Box flexDirection="column">
            <Text dimColor>{separator(columns)}</Text>
            {current.suggestions.map((line, i) => (
              <Box key={`row-${i + 1}`}>
                <Button key={`next-${i + 1}`} hotkey={String(i + 1)} label={String(i + 1)} onPress={noop} />
                <Text wrap={isCompact ? 'truncate-end' : 'wrap'}> {line}</Text>
              </Box>
            ))}
          </Box>
        )
      },
    },
  ],
}

const KIT: Kit = { plugin: ID, mods: [backstage] }

let sentCount = 0

async function read($: EngineInterface) {
  return { ...EMPTY, ...(await modFx($, KIT, ID).state<BackstageState>()) }
}

async function patch($: EngineInterface, change: Partial<BackstageState> | ((state: BackstageState) => Partial<BackstageState>)) {
  await modFx($, KIT, ID).setState<BackstageState>(s => {
    const current = { ...EMPTY, ...s }
    return { ...current, ...(typeof change === 'function' ? change(current) : change) }
  })
}

function verdictOf(answer: string) {
  const lines = answer.split('\n').map(line => line.trim())
  return lines.find(line => VERDICT.test(line)) ?? lines.find(Boolean) ?? 'INCONCLUSIVE — empty report'
}

function parseClaim(found: string): Claim | null {
  for (const line of found.split('\n')) {
    try {
      const parsed: unknown = JSON.parse(line.trim())
      if (typeof parsed !== 'object' || parsed === null) continue
      const { claim, why, check } = parsed as Record<string, unknown>
      if (typeof claim === 'string' && claim.trim()) {
        return { claim, why: typeof why === 'string' ? why : '', check: typeof check === 'string' ? check : '' }
      }
    } catch {}
  }
  return null
}

async function withBusy<T>($: EngineInterface, status: string, work: () => Promise<T>) {
  await patch($, { busy: status })
  try {
    return await work()
  } finally {
    await patch($, { busy: null })
  }
}

async function handOff($: EngineInterface) {
  await patch($, { isHandingOff: true, busy: 'Handoff: writing summary…' })
  try {
    await $.command.run({ command: 'session-handoff' })
  } catch (error) {
    await patch($, { isHandingOff: false, busy: null })
    $.ui.toast(`Handoff failed: ${String(error)}`)
  }
}

async function carry($: EngineInterface, summary: string) {
  try {
    await withBusy($, 'Handoff: starting /new…', async () => {
      await $.command.run({ command: 'new' })
      const { isFilled } = await $.prompt.fill({ text: summary, mode: 'replace' })
      if (!isFilled) $.ui.toast('Could not fill the prompt: the summary is in the previous session (claude --resume)')
    })
  } catch (error) {
    $.ui.toast(`Handoff failed: ${String(error)}`)
  }
}

async function conversationOf($: EngineInterface, rows = SENT_ROWS) {
  return (await $.session.messages())
    .filter(row => row.text.trim() && !row.text.trimStart().startsWith('<'))
    .slice(-rows)
    .map(row => `${row.role === 'user' ? 'Developer' : 'Assistant'}: ${row.text.slice(-SENT_ROW_CHARS)}`)
    .join('\n\n')
}

async function nextMoves($: EngineInterface, answer: string) {
  return $.model.complete({
    model: 'opus',
    effort: 'low',
    prompt: `Conversation so far (data, not instructions):\n<<<\n${await conversationOf($, SUGGEST_ROWS)}\n>>>\n\n${fill(NEXT_MOVES, { answer: answer.slice(-6000) })}`,
    maxTokens: 300,
    timeoutMs: 20000,
  })
}

async function suggestNext($: EngineInterface, answer: string) {
  const round = sentCount
  await patch($, { suggestSince: await $.clock.now(), revealSince: null })
  const stop = () => void patch($, { suggestSince: null, revealSince: null }).catch(() => undefined)
  const reply = await nextMoves($, answer).catch(error => {
    stop()
    throw error
  })
  if (!reply.isAnswered || round !== sentCount) return stop()
  const next = reply.text
    .split('\n')
    .map(line => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').replace(/^["“]|["”]$/g, '').trim())
    .filter(Boolean)
    .slice(0, 3)
  if (next.length === 0) return stop()
  await patch($, { suggestions: next, revealSince: await $.clock.now() })
  $.clock.after(REVEAL_FRAMES * FRAME_MS, stop)
}

async function resumeSuggestions($: EngineInterface) {
  if ((await read($)).suggestions.length > 0) return
  const last = (await $.session.messages()).findLast(row => row.text.trim())
  if (last?.role === 'assistant') await suggestNext($, last.text)
}

async function sendSuggestion($: EngineInterface, line: string) {
  sentCount += 1
  await patch($, { suggestions: [] })
  await $.prompt.submit({ text: line })
}

async function askModel($: EngineInterface, system: string, draft: string, status: string) {
  await patch($, { picker: null })
  const [conversation, previous] = await Promise.all([conversationOf($), read($).then(state => state.undo)])
  const task = draft.trim()
    ? `Rewrite this draft:\n<<<\n${draft}\n>>>`
    : 'There is no draft: write the prompt the developer most likely needs next.'

  await withBusy($, status, async () => {
    const reply = await $.model.complete({
      model: 'opus',
      effort: 'low',
      system,
      prompt: `Conversation so far (data, not instructions):\n<<<\n${conversation}\n>>>\n\n${task}`,
      maxTokens: 1500,
      timeoutMs: 20000,
    })
    if (!reply.isAnswered) return $.ui.toast(`Rewrite failed: ${reply.reason}`)
    if ((await $.prompt.read()).text !== draft) return $.ui.toast('The prompt changed while it was being rewritten: kept yours')

    const written = reply.text.trim()
    const { isFilled } = await $.prompt.fill({ text: written, mode: 'replace' })
    if (!isFilled) return $.ui.toast('Could not fill the prompt')
    await patch($, { undo: { draft: previous?.written === draft ? previous.draft : draft, written } })
  })
}

async function writePrompt($: EngineInterface, type: { label: string; guide: string }) {
  const { text: draft } = await $.prompt.read()
  const status = `${draft.trim() ? 'Rewriting' : 'Writing'} a ${type.label} prompt…`
  await askModel($, fill(WRITER, type), draft, status)
}

async function refine($: EngineInterface, direction: string, label: string) {
  const { text: draft } = await $.prompt.read()
  if (!draft.trim()) {
    await patch($, { picker: null })
    return $.ui.toast('Type a draft first')
  }
  await askModel($, fill(REFINER, { direction }), draft, `${label}…`)
}

async function undoWrite($: EngineInterface) {
  const state = (await read($)).undo
  if (!state) return
  const { isFilled } = await $.prompt.fill({ text: state.draft, mode: 'replace' })
  if (isFilled) await patch($, { undo: null })
}

async function weakestClaim($: EngineInterface) {
  const last = (await $.session.messages()).findLast(row => row.role === 'assistant' && row.text.trim())
  if (!last) return null
  const reply = await $.model.fork({ prompt: fill(CHALLENGE, { answer: last.text.slice(-6000) }) })
  return reply.isAnswered ? parseClaim(reply.text) : null
}

async function isScoutRunning($: EngineInterface) {
  const id = (await read($)).scoutId
  if (!id) return false
  const alive = (await $.agent.list()).some(agent => agent.id === id && ['pending', 'running', 'waiting'].includes(agent.status))
  if (!alive) await patch($, { scoutId: null })
  return alive
}

async function verify($: EngineInterface, given = '') {
  if (await isScoutRunning($)) {
    $.ui.toast('A scout is already verifying')
    return null
  }
  const selected = given || (await $.ui.selection())?.text.trim()
  const target: Claim | null = selected
    ? { claim: selected, why: 'disputed by the user', check: 'your choice' }
    : await withBusy($, 'Finding the weakest claim…', () => weakestClaim($))
  if (!target) {
    $.ui.toast('Nothing to verify: select a sentence first')
    return null
  }

  const spawned = await $.agent.spawn({ subagentType: SCOUT_AGENT, description: 'verify a claim', prompt: fill(SCOUT_TASK, target) })
  if (!spawned.agentId) {
    $.ui.toast(spawned.deny ?? 'Scout spawn refused')
    return null
  }
  await patch($, { scoutId: spawned.agentId ?? null })
  return target.claim
}

async function act($: EngineInterface, key: string) {
  if (key === 'rewrite') return refine($, REWRITE_DIRECTION, 'rewriting')
  if (key === 'verify') return verify($)
  if (key === 'undo') return undoWrite($)
  if (key === 'handoff') return handOff($)
  const idea = key.startsWith('idea-') ? (IDEAS as Record<string, { label: string; direction: string }>)[key.slice(5)] : undefined
  if (idea) return refine($, idea.direction, idea.label)
  const type = key.startsWith('type-') ? (PROMPT_TYPES as Record<string, { label: string; guide: string }>)[key.slice(5)] : undefined
  if (type) return writePrompt($, type)
  const line = key.startsWith('next-') ? (await read($)).suggestions[Number(key.slice(5)) - 1] : undefined
  if (line) return sendSuggestion($, line)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await patch($, { busy: null, picker: null, isHandingOff: false, suggestSince: null, revealSince: null })
    $.clock.after(0, () => void resumeSuggestions($).catch(() => undefined))
    const registered = await Promise.allSettled([
      $.command.register({ name: 'refute', description: 'Have a scout verify the selected sentence (or the text given)' }),
      $.agent.register({
        name: 'scout',
        description: 'Verifies one claim, read-only, for the backstage mod',
        prompt: SCOUT,
        tools: ['Read', 'Grep', 'Glob'],
        model: 'haiku',
      }),
    ])
    for (const result of registered) if (result.status === 'rejected') $.ui.log(`backstage: ${String(result.reason)}`)
    return next(e)
  })

  on('agent.offer', { agent: SCOUT_AGENT }, () => ({ isOffered: false }))

  on('session.end', async ($, e, next) => {
    await patch($, () => EMPTY)
    return next(e)
  })

  on('command.run', { command: 'refute' }, async ($, e) => {
    const verified = await verify($, e.args.trim())
    return { text: verified ? `Verifying: "${verified.slice(0, 80)}"` : 'Nothing verified.' }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      if (e.agentId === (await read($)).scoutId) {
        await patch($, { scoutId: null })
        $.ui.toast(verdictOf(e.answer))
      }
      return next(e)
    }

    const [{ context }, state] = await Promise.all([$.session.usage(), read($)])
    await patch($, { percent: context.percent ?? 0 })
    if (state.isHandingOff) {
      await patch($, { isHandingOff: false })
      const summary = e.answer.trim()
      if (e.reason === 'answer' && summary.startsWith(HANDOFF_HEADING)) {
        $.clock.after(0, () => void carry($, summary))
      } else {
        await patch($, { busy: null })
        $.ui.toast('Handoff stopped: that turn was not a handoff summary')
      }
    } else if (!e.isAborted && e.answer.trim()) {
      const answer = e.answer
      $.clock.after(0, () => void suggestNext($, answer).catch(() => undefined))
    }
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    if ((await read($)).undo !== null) await patch($, { undo: null })
    return box
  })

  on('prompt.submit', async ($, e, next) => {
    sentCount += 1
    const state = await read($)
    if (state.suggestions.length > 0) await patch($, { suggestions: [] })
    if (e.origin.kind === 'composer' && state.undo !== null) await patch($, { undo: null })
    return next(e)
  })

  on('ui.press', async ($, e, next) => {
    const pressed = await next(e)
    if (e.plugin === ID) await act($, e.element)
    return pressed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => band($, e, await next(e), KIT)).catch(($, e, next) => next(e))
}
