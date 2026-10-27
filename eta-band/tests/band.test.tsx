import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cells, extract, type TurnRecord } from '../hooks/estimate'
import { decode } from '../hooks/modkit/grid'

const T0 = 1_800_000_000_000
const PROMPT = 'implement the list page and add the tests'
const AGENT_PROMPT = 'Explore the documents module and list its entry points'
const BEADS = [
  { id: 'a', title: 'Review the documents filter PR', status: 'open', priority: 1, issue_type: 'task' },
  { id: 'b', title: 'Archived epic', status: 'open', priority: 0, issue_type: 'epic' },
]
  .map(b => JSON.stringify(b))
  .join('\n') + '\n{truncated'

const past = (n: number): TurnRecord[] =>
  Array.from({ length: n }, () => ({ f: extract(PROMPT), project: '/w', model: 'opus', durS: 600, endedAt: T0 / 1000 - 3600, predP50: 600 }))
const pastAgents = (n: number): TurnRecord[] =>
  Array.from({ length: n }, () => ({ f: extract(AGENT_PROMPT), agent: 'Explore', model: 'claude-haiku-5-5', durS: 120, endedAt: T0 / 1000 - 3600 }))

type Listed = { id: string; status: string }
type Options = { below?: boolean; background?: boolean; tasks?: number[] }

function stage(on: On, history: TurnRecord[], agentHistory: TurnRecord[] = [], options: Options = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, { history, agents: agentHistory, tasks: options.tasks ?? [] })
  const seen = { prompts: [] as string[], blits: [] as { key: string; cells: string }[] }
  const listed: Listed[] = []
  const holds = new Map<string, () => void>()
  let taskId = 0
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.blit', (_, e) => {
    if ('cells' in e) seen.blits.push({ key: e.key, cells: e.cells })
    return { value: {} }
  })
  on('ui.render', ($, e) => {
    if (!options.below) return { type: 'engine' as const, ref: 0 }
    const { Text } = $.ui.resolve(e)
    return <Text>other band</Text>
  })
  on('classic.PermissionRequest', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer, reason: 'answer' as const }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'opus' }))
  on('agent.list', () => ({ value: listed.map(l => ({ id: l.id, description: 'x', type: 'Explore', status: l.status })) as never }))
  on('agent.spawn', (_, e) => (options.background ? { model: 'claude-haiku-5-5' } : { model: 'claude-haiku-5-5', agentId: `agent-${e.tool_use_id}` }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: BEADS.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: BEADS }))
  on('model.complete', (_, e) => {
    seen.prompts.push(String(e.prompt))
    return { value: { isAnswered: true as const, text: 'Review the documents filter PR', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('tool.call', async (_, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++taskId), subject: e.subject } } }
    if (e.tool === 'TaskUpdate') {
      const from = e.status === 'completed' ? 'in_progress' : 'pending'
      return { result: { success: true, taskId: e.taskId, updatedFields: ['status'], statusChange: { from, to: e.status ?? 'pending' } } }
    }
    if (e.tool === 'Agent') return { result: { status: 'async_launched', agentId: `agent-${e.tool_use_id}`, description: e.description, prompt: '' } as never }
    if (e.tool === 'AskUserQuestion' || e.tool === 'Bash') await new Promise<void>(resolve => holds.set(e.tool, resolve))
    return { result: {} }
  })
  let ui: { findAll: (query: { key: string }) => Promise<unknown> } | null = null
  const mount = async ($: Engine, bodyColumns = 100) => {
    const mounted = await $.ui.mount({
      plugin: 'eta-band',
      component: 'AbovePrompt',
      surface: 'terminal',
      props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 9 }, view: {} },
    })
    ui = mounted
    return mounted
  }
  const look = async (columns = 100) => {
    await ui?.findAll({ key: 'modkit-flow' })
    await clock.advance(66)
    const blit = [...seen.blits].reverse().find(one => one.key.startsWith('modkit-eta-band-'))
    return blit ? decode(blit.cells, columns).map(row => row.trimEnd()) : []
  }
  const release = (tool: string) => holds.get(tool)?.()
  return { clock, seen, listed, mount, look, release }
}
const log = (s: string) => (globalThis as { console?: { log: (s: string) => void } }).console?.log(s)

const start = async ($: Engine, turnId = 't1') => {
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: PROMPT, turnId })
}
const doTask = ($: Engine, taskId: string, status: 'in_progress' | 'completed') => $.tool.call({ tool: 'TaskUpdate', taskId, status })
const spawn = ($: Engine, id: string, description: string, background = false) =>
  $.agent.spawn({ tool_use_id: id, prompt: AGENT_PROMPT, description, subagentType: 'Explore', parentModel: 'opus', background, fork: false } as never)

test('emoji and wide characters count as two cells', async () => {
  expect(cells('00:07:08 left')).toBe(13)
  expect(cells('☕ break')).toBe(8)
})

test('a turn with a list of 3 tasks: the hh:mm:ss ETA leads and updates, a suggestion appears', async ($, on) => {
  const { clock, seen, look, mount } = stage(on, past(10))
  await start($)
  for (const subject of ['write the page', 'wire the API', 'tests']) await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
  await mount($)

  await doTask($, '1', 'in_progress')
  await clock.advance(60_000)
  await doTask($, '1', 'completed')
  await doTask($, '2', 'in_progress')
  await clock.advance(1_000)
  const firstRows = await look()
  const first = firstRows[0]
  expect(first).toMatch(/^00:01:5\d left · tasks 1\/3$/)
  expect(firstRows).toContain('  meanwhile: Review the documents filter PR')

  await clock.advance(5_000)
  const later = (await look())[0]
  expect(later).not.toBe(first)

  await clock.advance(55_000)
  await doTask($, '2', 'completed')
  await clock.advance(1_000)
  const rows = await look()
  expect(rows[0]).toMatch(/^\d\d:\d\d:\d\d left · tasks 2\/3$/)
  expect(seen.prompts.length >= 1 && seen.prompts.length <= 2).toBe(true)
  expect(seen.prompts[0]).toContain('Review the documents filter PR')
  expect(seen.prompts[0]).not.toContain('Archived epic')
  log(['', ...firstRows, later, ...rows].join('\n'))
})

test('half a screen (60 columns): the ETA stays readable and every line fits', async ($, on) => {
  const { clock, look, mount } = stage(on, past(10), pastAgents(5))
  await start($)
  for (const subject of ['a', 'b', 'c']) await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
  await spawn($, 'x1', 'Explore the documents module in depth')
  await mount($, 60)
  await doTask($, '1', 'in_progress')
  await clock.advance(30_000)
  await doTask($, '1', 'completed')
  await clock.advance(1_000)
  const rows = (await look(60))
  expect(rows[0]).toMatch(/^\d\d:\d\d:\d\d left · tasks 1\/3( · until the agents finish)?$/)
  expect(rows[1]).toMatch(/^ {2}● Explore the documents… .*\d\d:\d\d:\d\d left$/)
  expect(rows.every(row => cells(row) <= 60)).toBe(true)
  log(['', ...rows].join('\n'))
})

test('first launch with an empty history shows no invented ETA', async ($, on) => {
  const { clock, look, mount } = stage(on, [])
  await start($)
  await mount($)
  await clock.advance(2_000)
  expect(await look()).toEqual(['working · 00:00:02 elapsed'])
})

test('a history whose predictions were far off gives no countdown (reported: 59 s announced, minutes taken)', async ($, on) => {
  const scattered = past(12).map((record, i) => ({ ...record, durS: i % 2 ? 60 : 2400 }))
  const { clock, look, mount } = stage(on, scattered)
  await start($)
  await mount($)
  await clock.advance(5_000)
  expect(await look()).toEqual(['working · 00:00:05 elapsed'])
})

test('with a task list the countdown comes from learnt task durations, even with no history', async ($, on) => {
  const { clock, look, mount } = stage(on, [], [], { tasks: [60, 60, 60] })
  await start($)
  for (const subject of ['a', 'b', 'c']) await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
  await doTask($, '1', 'in_progress')
  await mount($)
  await clock.advance(20_000)
  expect((await look())[0]).toMatch(/^00:02:\d\d left · tasks 0\/3$/)
})

test('a turn the system starts (a task notification) is not shown and not learnt', async ($, on) => {
  const { clock, look, mount } = stage(on, past(10))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '<task-notification>agent finished</task-notification>', turnId: 'n1' })
  await mount($)
  await clock.advance(2_000)
  expect(await look()).toEqual([])
})

test('without a task list the ETA says it comes from past turns', async ($, on) => {
  const { clock, seen, look, mount } = stage(on, past(10))
  await start($)
  await mount($)
  await clock.advance(2_000)
  expect((await look())[0]).toMatch(/^\d\d:\d\d:\d\d left · from 10 past turns$/)
})

test('past every comparable turn: no invented countdown and no suggestion', async ($, on) => {
  const quick = past(10).map(record => ({ ...record, durS: 30, predP50: 30 }))
  const { clock, look, mount } = stage(on, quick)
  await start($)
  await mount($, 60)
  for (let i = 0; i < 5; i++) await clock.advance(30_000)
  expect(await look(60)).toEqual(['longer than usual · 00:02:30 elapsed'])
})

test('waiting for the person shows neither countdown nor suggestion, and a sub-agent tool does not end the wait', async ($, on) => {
  const { clock, look, mount, release } = stage(on, past(10), pastAgents(5))
  await start($)
  await spawn($, 'x1', 'explore', true)
  await mount($)
  await clock.advance(120_000)
  const asking = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Read', file_path: '/w/a.ts', agentId: 'agent-x1' } as never)
  await clock.advance(9_000)
  const rows = await look()
  expect(rows[0]).toBe('! waiting for your answer · 00:02:00 elapsed')
  expect(rows.some(row => row.includes('meanwhile'))).toBe(false)
  release('AskUserQuestion')
  asking.catch(() => undefined)
})

test('sub-agents: aligned columns with tool, model and ETA; a permission puts only that agent on hold', async ($, on) => {
  const { clock, listed, look, mount, release } = stage(on, past(10), pastAgents(5))
  await start($)
  await spawn($, 'x1', 'explore documents')
  await spawn($, 'x2', 'explore registration')
  listed.push({ id: 'agent-x1', status: 'running' }, { id: 'agent-x2', status: 'running' })
  await mount($)
  await $.tool.call({ tool: 'Read', file_path: '/w/src/documents/index.ts', agentId: 'agent-x1' } as never)
  await clock.advance(10_000)
  const busy = (await look()).find(row => row.includes('explore documents'))
  expect(busy).toMatch(/^ {2}● explore documents +Read index\.ts +haiku 5\.5 {2}\d\d:\d\d:\d\d left$/)

  const bash = $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'agent-x2' } as never)
  await clock.settle()
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {}, agent_id: 'agent-x2' } as never)
  await clock.advance(1_000)
  const rows = await look()
  const held = rows.find(row => row.includes('explore registration'))
  expect(held).toMatch(/^ {2}! explore registration {2}needs your approval +haiku 5\.5 {2}\d\d:\d\d:\d\d elapsed$/)
  expect(rows.find(row => row.includes('explore documents'))).toMatch(/^ {2}● /)
  log(['', ...rows].join('\n'))
  release('Bash')
  bash.catch(() => undefined)
})

test('sub-agents end by their own report or by the engine list', async ($, on) => {
  const { clock, listed, look, mount } = stage(on, past(10), pastAgents(5))
  await start($)
  await spawn($, 'x1', 'explore documents')
  await spawn($, 'x2', 'explore registration')
  listed.push({ id: 'agent-x1', status: 'running' }, { id: 'agent-x2', status: 'running' })
  await mount($)
  await clock.advance(10_000)
  await $.turn.complete({ answer: 'ok', durationMs: 45_000, isAborted: false, turnId: 'a1', reason: 'answer', agentId: 'agent-x1' } as never)
  listed[1]!.status = 'completed'
  await clock.advance(1_000)
  const ended = await look()
  expect(ended.some(row => row.startsWith('  ✓ explore documents'))).toBe(true)
  expect(ended.some(row => row.startsWith('  ✓ explore registration'))).toBe(true)
})

test('a background agent launched without an id is tracked from its launch, not adopted', async ($, on) => {
  const { clock, seen, look, mount } = stage(on, past(10), pastAgents(5), { background: true })
  await start($)
  await spawn($, 'bg1', 'background scan', true)
  await $.tool.call({ tool: 'Agent', description: 'background scan', prompt: AGENT_PROMPT, subagent_type: 'Explore', run_in_background: true, tool_use_id: 'bg1' } as never)
  await clock.advance(5_000)
  await $.tool.call({ tool: 'Grep', pattern: 'eta', agentId: 'agent-bg1' } as never)
  await mount($)
  await clock.advance(1_000)
  const line = (await look()).find(row => row.includes('background scan'))
  expect(line).toMatch(/left$/)
  expect(line).not.toMatch(/running/)
})

test('a sub-agent whose end never arrives is marked lost after two minutes of silence', async ($, on) => {
  const { clock, seen, look, mount } = stage(on, past(10))
  await start($)
  await spawn($, 'x9', 'ghost', true)
  await mount($)
  await clock.advance(125_000)
  expect((await look()).find(row => row.includes('ghost'))).toMatch(/^ {2}\? ghost {2}end never received/)
})

test('the band keeps the bands of other mods', async ($, on) => {
  const { clock, seen, look, mount } = stage(on, past(10), [], { below: true })
  await start($)
  const ui = await mount($)
  await clock.advance(2_000)
  expect((await look())[0]).toMatch(/left/)
  expect((await ui.find({ type: 'Text', text: /other band/ }))?.text).toBe('other band')
})

test('a finished turn is learnt: the tenth well-predicted turn unlocks the prompt-based countdown', async ($, on) => {
  const { clock, look, mount } = stage(on, past(9))
  await start($)
  await mount($)
  await clock.advance(2_000)
  expect(await look()).toEqual(['working · 00:00:02 elapsed'])
  await $.turn.complete({ answer: 'ok', durationMs: 600_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: PROMPT, turnId: 't2' })
  await clock.advance(2_000)
  expect((await look())[0]).toMatch(/^\d\d:\d\d:\d\d left · from 10 past turns$/)
})

test('the countdown only counts down, and past its own promise it says longer than usual (reported: the timer only goes up)', async ($, on) => {
  const quick = past(10).map(record => ({ ...record, durS: 40, predP50: 40 }))
  const { clock, look, mount } = stage(on, quick)
  await start($)
  await mount($)
  await clock.advance(20_000)
  const shown: string[] = []
  for (let i = 0; i < 40; i++) {
    await clock.advance(1_000)
    shown.push((await look())[0] ?? '')
  }
  const lefts = shown.map(row => /^(\d\d):(\d\d):(\d\d) left/.exec(row)).map(m => (m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null))
  const rises = lefts.filter((left, i) => i > 0 && left !== null && lefts[i - 1] !== null && left > (lefts[i - 1] as number)).length
  log(`rises: ${rises} · first ${shown[0]} · last ${shown.at(-1)}`)
  expect(rises).toBe(0)
  expect(shown.at(-1)).toMatch(/^longer than usual · 00:01:0\d elapsed$/)
})

test('tasks left from an earlier turn are not counted in the next one', async ($, on) => {
  const { clock, look, mount } = stage(on, [], [], { tasks: [60, 60, 60] })
  await start($, 't1')
  for (const subject of ['old a', 'old b', 'old c']) await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
  await doTask($, '1', 'in_progress')
  await doTask($, '1', 'completed')
  await $.turn.complete({ answer: 'ok', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: PROMPT, turnId: 't2' })
  for (const subject of ['new a', 'new b']) await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
  await doTask($, '4', 'in_progress')
  await mount($)
  await clock.advance(2_000)
  expect((await look())[0]).toMatch(/ · tasks 0\/2$/)
})
