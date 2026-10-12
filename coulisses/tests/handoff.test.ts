import { expect, test } from 'claude-code/testing'

import { mountBand, press, stage, turn } from './harness'

const SUMMARY = '# Session Handoff — coulisses\n\n## Where it started\nResume phase 2.'

test('Handoff stays hidden under 50 % of context', async ($, on) => {
  stage(on, { percent: 40 })
  await $.turn.complete(turn('ok', 't0'))
  expect(await (await mountBand($)).findAll({ key: 'handoff' })).toEqual([])
})

test('Handoff stays hidden while a turn runs', async ($, on) => {
  stage(on, { percent: 60 })
  await $.turn.complete(turn('ok', 't0'))
  expect(await (await mountBand($, true)).findAll({ key: 'handoff' })).toEqual([])
})

test('Handoff runs the handoff skill, then /new, then fills the summary', async ($, on) => {
  const { clock, commands, filled } = stage(on, { percent: 60 })
  await $.turn.complete(turn('ok', 't0'))
  await mountBand($)
  await press($, 'handoff')
  expect(commands).toEqual(['session-handoff'])

  await $.turn.complete(turn(SUMMARY, 't1'))
  await clock.advance(10)
  expect(commands).toEqual(['session-handoff', 'new'])
  expect(filled).toEqual([SUMMARY])
})

test('Handoff never runs /new on a turn that is not a handoff summary', async ($, on) => {
  const { clock, commands, toasts } = stage(on, { percent: 60 })
  await $.turn.complete(turn('ok', 't0'))
  await mountBand($)
  await press($, 'handoff')

  await $.turn.complete(turn('Here is the unrelated answer of the running turn.', 't1'))
  await clock.advance(10)
  expect(commands).toEqual(['session-handoff'])
  expect(toasts).toEqual(['Handoff stopped: that turn was not a handoff summary'])
})
