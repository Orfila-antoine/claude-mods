import { expect, test } from 'claude-code/testing'

import { mountBand, press, stage, turn, typed } from './harness'

const SETTLE = 1200
const THREE = '1. Go, ship it\n- Also run the tests first\n"What about the logout?"\nA fourth one'

test('after an answer, Opus proposes 3 next prompts from the conversation; one click sends one', async ($, on) => {
  const { clock, asked, forks, sent } = stage(on, {
    reply: THREE,
    messages: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? ('assistant' as const) : ('user' as const), text: `row ${i}` })),
  })
  await $.turn.complete(turn('Done: login fixed. Next step: run the tests.', 't1'))
  await clock.advance(SETTLE)
  expect(forks).toEqual([])
  expect(asked[0]?.model).toBe('opus')
  expect(asked[0]?.prompt).toContain('Done: login fixed. Next step: run the tests.')
  expect(asked[0]?.prompt).toContain('1. the next step this answer proposes')
  expect(asked[0]?.prompt).toContain('shortest effective prompt for Claude Code')
  expect(asked[0]?.prompt).toContain('Developer: row 2')
  expect(asked[0]?.prompt).not.toContain('row 1\n')

  const band = await mountBand($)
  expect((await band.findAll({ key: 'next-1' }))[0]?.text).toBe('1')
  expect(await band.findAll({ type: 'Text', text: ' Go, ship it' })).not.toEqual([])
  expect(await band.findAll({ type: 'Text', text: ' Also run the tests first' })).not.toEqual([])
  expect(await band.findAll({ type: 'Text', text: ' What about the logout?' })).not.toEqual([])
  expect(await band.findAll({ key: 'next-4' })).toEqual([])
  expect(await band.findAll({ type: 'Text', text: /^─+$/ })).not.toEqual([])

  await press($, 'next-2')
  expect(sent).toEqual(['Also run the tests first'])
  expect(await band.findAll({ key: 'next-1' })).toEqual([])
})

test('no suggestions after an aborted turn, and a typed prompt clears them', async ($, on) => {
  const { clock } = stage(on, { reply: THREE })
  await $.turn.complete(turn('half an answer', 't1', 'aborted'))
  await clock.advance(10)
  const band = await mountBand($)
  expect(await band.findAll({ key: 'next-1' })).toEqual([])

  await $.turn.complete(turn('Done.', 't2'))
  await clock.advance(SETTLE)
  expect(await band.findAll({ key: 'next-1' })).not.toEqual([])
  await $.prompt.submit(typed('something else'))
  expect(await band.findAll({ key: 'next-1' })).toEqual([])
})

test('alphanumeric rain stands in for the choices, then each row decodes into its prompt', async ($, on) => {
  const { clock } = stage(on, { reply: THREE, replyDelayMs: 1000 })
  const band = await mountBand($)
  await $.turn.complete(turn('Done.', 't1'))
  await clock.advance(10)
  const rain = async () => (await band.findAll({ type: 'Text' })).map(found => found.text).join('|')
  const first = await rain()
  expect(first).toMatch(/\[ 1 \] /)
  expect(first).toMatch(/\[ 1 \] [A-Za-z0-9]{5}/)
  expect(first).not.toMatch(/[⠀-⣿]/)
  await clock.advance(300)
  expect(await rain()).not.toBe(first)
  expect(await band.findAll({ key: 'next-1' })).toEqual([])

  await clock.advance(1000)
  await clock.advance(500)
  const midway = await rain()
  expect(midway).toMatch(/\[ 1 \] Go,/)
  expect(await band.findAll({ key: 'next-1' })).toEqual([])

  await clock.advance(SETTLE)
  expect(await band.findAll({ key: 'next-1' })).not.toEqual([])
  expect(await band.findAll({ type: 'Text', text: ' Go, ship it' })).not.toEqual([])
})

test('a loading state left by a reload is cleared when the mod starts again', async ($, on) => {
  const { clock } = stage(on, { reply: THREE, replyDelayMs: 60_000 })
  on('command.register', () => ({ value: { command: 'refute' } }))
  on('agent.register', () => ({ value: { agent: 'backstage:scout' } }))
  on('session.start', ($, e) => e)
  const band = await mountBand($)
  await $.turn.complete(turn('Done.', 't1'))
  await clock.advance(10)
  expect(await band.findAll({ type: 'Text', text: /^\[ 1 \] / })).not.toEqual([])

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  expect(await band.findAll({ type: 'Text', text: /^\[ 1 \] / })).toEqual([])
})

test('after a reload, the 3 prompts are written again for the last answer', async ($, on) => {
  const { clock, asked } = stage(on, {
    reply: THREE,
    messages: [
      { role: 'user', text: 'fix the login' },
      { role: 'assistant', text: 'Done: login fixed.' },
    ],
  })
  on('command.register', () => ({ value: { command: 'refute' } }))
  on('agent.register', () => ({ value: { agent: 'backstage:scout' } }))
  on('session.start', ($, e) => e)
  const band = await mountBand($)

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await clock.advance(SETTLE)
  expect(asked[0]?.prompt).toContain('Done: login fixed.')
  expect(await band.findAll({ key: 'next-1' })).not.toEqual([])
})

const LONG = `${'word '.repeat(40).trim()}\nsecond choice\nthird choice`

test('the band keeps its buttons when the prompt leaves little room', async ($, on) => {
  const { clock } = stage(on, { reply: LONG })
  await $.turn.complete(turn('Done.', 't1'))
  await clock.advance(SETTLE)

  const roomy = await mountBand($, false, 10)
  expect(await roomy.findAll({ key: 'next-3' })).not.toEqual([])
  expect(await roomy.findAll({ type: 'Text', text: /^ word/ })).toMatchObject([{ props: { wrap: 'wrap' } }])

  const tight = await mountBand($, false, 5)
  expect(await tight.findAll({ key: 'next-3' })).not.toEqual([])
  expect(await tight.findAll({ type: 'Text', text: /^ word/ })).toMatchObject([{ props: { wrap: 'truncate-end' } }])

  const cramped = await mountBand($, false, 2)
  expect(await cramped.findAll({ key: 'rewrite' })).not.toEqual([])
  expect(await cramped.findAll({ key: 'next-1' })).toEqual([])
})

test('the context sent to the model leaves out command records', async ($, on) => {
  const { clock, asked } = stage(on, {
    reply: THREE,
    messages: [
      { role: 'user', text: '<command-name>/plugin</command-name>' },
      { role: 'user', text: 'fix the login' },
    ],
  })
  await $.turn.complete(turn('Done.', 't1'))
  await clock.advance(10)
  expect(asked[0]?.prompt).toContain('Developer: fix the login')
  expect(asked[0]?.prompt).not.toContain('command-name')
})
