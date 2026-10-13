import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage, ToolUseSummary } from 'claude-code'

function stage(on: On, rows: SessionMessage[], draft = '') {
  const clock = mock.clock(on)
  const seen = { toasts: [] as string[], filled: [] as { text: string; mode?: string }[] }
  on('session.messages', () => ({ value: rows }))
  on('session.turns', () => ({ value: rows.filter(row => row.role === 'user').length }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', ($, e) => {
    seen.filled.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  return { seen, settle: () => clock.advance(1) }
}

const done = { answer: 'x', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' as const }

const mount = ($: Engine) =>
  $.ui.mount({
    plugin: 'mirror',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })

const exchange = (prompt: string, answer: string): SessionMessage[] => [
  { role: 'user', text: prompt, toolUses: [] },
  { role: 'assistant', text: answer, toolUses: [] },
]

const LOOP = [
  ...exchange('push it', 'Waiting for your force-push to main.'),
  ...exchange('still not done', 'Still waiting for your force-push to main.'),
  ...exchange('check again', 'Waiting for your force-push to main, nothing moved.'),
]

test('three near-identical answers raise the spiral line, and Break the loop fills the empty prompt', async ($, on) => {
  const { seen, settle } = stage(on, [...exchange('hello there my friend', 'Hi.'), ...LOOP])
  await $.turn.complete(done)
  await settle()
  const band = await mount($)
  expect(await band.findAll({ key: 'break' })).toHaveLength(1)
  expect(seen.toasts).toEqual(['🪞 The last 3 answers say the same thing.'])
  await $.ui.press({ plugin: 'mirror', key: 'break' })
  expect(seen.filled[0]).toMatchObject({ mode: 'replace' })
  expect(seen.filled[0]?.text).toMatch(/^Stop iterating/)
  expect(await (await mount($)).findAll({ key: 'break' })).toEqual([])
})

test('What repeats unfolds one line naming the repeated words, and folds back', async ($, on) => {
  const { settle } = stage(on, LOOP)
  await $.turn.complete(done)
  await settle()
  const band = await mount($)
  expect(await band.findAll({ type: 'Text', text: /^ {3}\S/ })).toEqual([])
  await $.ui.press({ plugin: 'mirror', key: 'why' })
  expect((await band.findAll({ type: 'Text', text: /^ {3}\S/ }))[0]?.text).toBe('   Repeated: "Waiting for your force push to main"')
  await $.ui.press({ plugin: 'mirror', key: 'why' })
  expect(await band.findAll({ type: 'Text', text: /^ {3}\S/ })).toEqual([])
})

test('Break the loop keeps a draft and appends to it', async ($, on) => {
  const { seen, settle } = stage(on, LOOP, 'my half-written idea')
  await $.turn.complete(done)
  await settle()
  await mount($)
  await $.ui.press({ plugin: 'mirror', key: 'break' })
  expect(seen.filled[0]).toMatchObject({ mode: 'append' })
})

test('three short "continue" prompts are not a spiral', async ($, on) => {
  const { settle } = stage(on, [...exchange('continue', 'Step 1 done.'), ...exchange('continue', 'Step 2: the schema.'), ...exchange('continue', 'All tests pass now.')])
  await $.turn.complete(done)
  await settle()
  expect(await (await mount($)).findAll({ key: 'break' })).toEqual([])
})

test('the same tool failing three times in the last turn is a spiral', async ($, on) => {
  const failing = (id: string): ToolUseSummary => ({ tool_use_id: id, tool: 'Bash', input: { command: 'npm run build' }, isError: true })
  const { seen, settle } = stage(on, [
    { role: 'user', text: 'run the build', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [failing('a'), failing('b'), failing('c')] },
  ])
  await $.turn.complete(done)
  await settle()
  expect(seen.toasts).toEqual(['🪞 Bash failed 3 times in the last turn.'])
  await mount($)
  await $.ui.press({ plugin: 'mirror', key: 'why' })
  expect((await (await mount($)).findAll({ type: 'Text', text: /^ {3}\S/ }))[0]?.text).toBe('   Last failing call: npm run build')
})
