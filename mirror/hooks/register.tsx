import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Spiral } from '../types'
import { band, modFx } from './modkit'
import type { Kit, Mod } from './modkit'

const WINDOW = 3
const ALIKE = 0.6
const MIN_PROMPT_WORDS = 4
const DETAIL_CHARS = 70
const BREAK =
  'Stop iterating. Name the assumption that might be wrong, then ask me one diagnostic question before changing anything.'

type Turn = { prompt: string; answer: string; failures: Map<string, { count: number; input: string }> }

const tokens = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? []

const words = (text: string) => new Set(tokens(text.toLowerCase()))

const clip = (text: string) => (text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS - 1)}…` : text)

function shared(texts: string[]) {
  const sets = texts.map(words)
  const kept = tokens(texts.at(-1) ?? '').filter(token => sets.every(set => set.has(token.toLowerCase())))
  return clip([...new Set(kept)].join(' '))
}

function inputOf(input: Record<string, unknown>) {
  const value = input.command ?? input.file_path ?? input.pattern ?? input.url
  return clip(typeof value === 'string' ? value.split('\n')[0] ?? '' : JSON.stringify(input))
}

function alike(a: string, b: string) {
  const left = words(a)
  const right = words(b)
  if (left.size === 0 || right.size === 0) return false
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / (left.size + right.size - shared) >= ALIKE
}

const allAlike = (texts: string[]) => texts.length === WINDOW && texts.every(text => alike(text, texts[0] ?? ''))

const isPrompt = (row: SessionMessage) =>
  row.role === 'user' && !row.toolResults?.length && row.text.trim() !== '' && !row.text.trimStart().startsWith('<')

function turnsOf(rows: SessionMessage[]) {
  const turns: Turn[] = []
  for (const row of rows) {
    if (isPrompt(row)) {
      turns.push({ prompt: row.text, answer: '', failures: new Map() })
      continue
    }
    const current = turns.at(-1)
    if (!current || row.role !== 'assistant') continue
    if (row.text.trim()) current.answer = row.text
    for (const use of row.toolUses) {
      if (use.isError) current.failures.set(use.tool, { count: (current.failures.get(use.tool)?.count ?? 0) + 1, input: inputOf(use.input) })
    }
  }
  return turns
}

function spiralOf(turns: Turn[]): { reason: string; detail: string } | null {
  const prompts = turns.map(turn => turn.prompt)
  if (allAlike(prompts) && prompts.every(prompt => words(prompt).size >= MIN_PROMPT_WORDS)) {
    return { reason: `The same request came back ${WINDOW} times.`, detail: `Repeated: "${shared(prompts)}"` }
  }
  const answers = turns.map(turn => turn.answer)
  if (allAlike(answers)) return { reason: `The last ${WINDOW} answers say the same thing.`, detail: `Repeated: "${shared(answers)}"` }
  for (const [tool, { count, input }] of turns.at(-1)?.failures ?? []) {
    if (count >= WINDOW) return { reason: `${tool} failed ${count} times in the last turn.`, detail: `Last failing call: ${input}` }
  }
  return null
}

function recentRows(rows: SessionMessage[]) {
  let seen = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row && isPrompt(row) && ++seen === WINDOW) return rows.slice(i)
  }
  return rows
}

type MirrorState = { spiral: Spiral | null; dismissedAt: number; expandedAt: number }

const EMPTY: MirrorState = { spiral: null, dismissedAt: -1, expandedAt: -1 }

const mirror: Mod<MirrorState> = {
  id: 'mirror',
  layers: [
    {
      id: 'spiral',
      z: 80,
      priority: 90,
      rows: ({ state }) => (state?.spiral && state.expandedAt === state.spiral.at ? 2 : 1),
      visible: state => Boolean(state?.spiral && state.spiral.at !== state.dismissedAt),
      node({ ui, state, fx }) {
        const { Box, Button, Text } = ui
        const found = state?.spiral
        if (!found) return <Box />
        const isExpanded = state.expandedAt === found.at
        const dismiss = () => fx.setState<MirrorState>(current => ({ ...EMPTY, ...current, dismissedAt: found.at }))
        return (
          <Box flexDirection="column">
            <Box>
              <Text color="magenta">🪞 Spiral: {found.reason} </Text>
              <Button
                key="break"
                hotkey="b"
                label="Break the loop"
                onPress={async () => {
                  const draft = (await fx.prompt.read()).trim()
                  await fx.prompt.fill(draft ? `\n${BREAK}` : BREAK, draft ? 'append' : 'replace')
                  await dismiss()
                }}
              />
              <Button key="dismiss" hotkey="d" label="Dismiss" onPress={dismiss} />
              <Button
                key="why"
                hotkey="x"
                label={isExpanded ? '▾ What repeats' : '▸ What repeats'}
                onPress={() => fx.setState<MirrorState>(current => ({ ...EMPTY, ...current, expandedAt: isExpanded ? -1 : found.at }))}
              />
            </Box>
            {isExpanded && <Text key="detail" dimColor>{`   ${found.detail}`}</Text>}
          </Box>
        )
      },
    },
  ],
}

const KIT: Kit = { plugin: 'mirror', mods: [mirror] }

async function look($: EngineInterface) {
  const [rows, at] = await Promise.all([$.session.messages(), $.session.turns()])
  const seen = spiralOf(turnsOf(recentRows(rows)))
  const found: Spiral | null = seen ? { ...seen, at } : null
  const fx = modFx($, KIT, 'mirror')
  const before = (await fx.state<MirrorState>())?.spiral ?? null
  if (found?.reason === before?.reason) return
  await fx.setState<MirrorState>(current => ({ ...EMPTY, ...current, spiral: found }))
  if (found) $.ui.toast(`🪞 ${found.reason}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.after(0, () => void look($).catch(() => undefined))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) $.clock.after(0, () => void look($).catch(() => undefined))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => band($, e, await next(e), KIT)).catch(($, e, next) => next(e))
}
