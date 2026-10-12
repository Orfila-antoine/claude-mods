import { expect, test } from 'claude-code/testing'

import { mountBand, press, stage, turn, typed } from './harness'

const THREE = '1. Go, ship it\n- Also run the tests first\n"What about the logout?"\nA fourth one'

test('after an answer, Opus proposes 3 next prompts from the conversation; one click sends one', async ($, on) => {
  const { clock, asked, forks, sent } = stage(on, {
    reply: THREE,
    messages: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? ('assistant' as const) : ('user' as const), text: `row ${i}` })),
  })
  await $.turn.complete(turn('Done: login fixed. Next step: run the tests.', 't1'))
  await clock.advance(10)
  expect(forks).toEqual([])
  expect(asked[0]?.model).toBe('opus')
  expect(asked[0]?.prompt).toContain('Done: login fixed. Next step: run the tests.')
  expect(asked[0]?.prompt).toContain('1. The next step')
  expect(asked[0]?.prompt).toContain('Write exactly like the developer writes')
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
  await clock.advance(10)
  expect(await band.findAll({ key: 'next-1' })).not.toEqual([])
  await $.prompt.submit(typed('something else'))
  expect(await band.findAll({ key: 'next-1' })).toEqual([])
})

test('a loading effect stands in for the choices while they are written', async ($, on) => {
  const { clock } = stage(on, { reply: THREE, replyDelayMs: 1000 })
  const band = await mountBand($)
  await $.turn.complete(turn('Done.', 't1'))
  await clock.advance(10)
  expect(await band.findAll({ text: /⠋ Decoding 3 next prompts/ })).not.toEqual([])
  const firstRain = (await band.findAll({ type: 'Text', text: /[ｱ-ﾝ0-9]{10}/ })).map(found => found.text).join('|')
  await clock.advance(300)
  expect(await band.findAll({ text: /⠸ Decoding 3 next prompts/ })).not.toEqual([])
  const laterRain = (await band.findAll({ type: 'Text', text: /[ｱ-ﾝ0-9]{10}/ })).map(found => found.text).join('|')
  expect(firstRain).not.toBe('')
  expect(laterRain).not.toBe(firstRain)

  await clock.advance(1000)
  expect(await band.findAll({ text: /Decoding 3 next prompts/ })).toEqual([])
  expect(await band.findAll({ key: 'next-1' })).not.toEqual([])
})

test('a loading state left by a reload is cleared when the mod starts again', async ($, on) => {
  const { clock } = stage(on, { reply: THREE, replyDelayMs: 60_000 })
  on('command.register', () => ({ value: { command: 'refute' } }))
  on('agent.register', () => ({ value: { agent: 'backstage:scout' } }))
  on('session.start', ($, e) => e)
  const band = await mountBand($)
  await $.turn.complete(turn('Done.', 't1'))
  await clock.advance(10)
  expect(await band.findAll({ text: /Decoding/ })).not.toEqual([])

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  expect(await band.findAll({ text: /Decoding/ })).toEqual([])
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
  await clock.advance(10)
  expect(asked[0]?.prompt).toContain('Done: login fixed.')
  expect(await band.findAll({ key: 'next-1' })).not.toEqual([])
})
