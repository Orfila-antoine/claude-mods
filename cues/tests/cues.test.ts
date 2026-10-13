import { expect, mock, test } from 'claude-code/testing'

import { isPush, isoWeek, nextStepOf, pushLabel, startLine, weeksInARow } from '../hooks/logic'

test('a push only counts as a command of its own', () => {
  expect(isPush('cd repo && git push origin main')).toBe(true)
  expect(isPush('echo "git push"')).toBe(false)
})

test('the last "Next:" line of an answer becomes the hint', () => {
  expect(nextStepOf('Done.\n\nNext: run `npm test` and paste the first failing line.')).toBe('run npm test and paste the first failing line.')
  expect(nextStepOf('**Next:** run /gate')).toBe('run /gate')
  expect(nextStepOf('No next step here.')).toBeNull()
})

test('a push output gives the new hash and the branch', () => {
  expect(pushLabel('To github.com:me/x.git\n   af68d1d..9199dfc  main -> main')).toBe('pushed 9199dfc -> main')
  expect(pushLabel(' * [new branch]      feature/x -> feature/x')).toBe('pushed new branch feature/x')
})

test('weeks in a row stop at the first missing week', () => {
  const now = Date.UTC(2026, 9, 13)
  const week = 7 * 86400000
  expect(weeksInARow([isoWeek(now), isoWeek(now - week), isoWeek(now - 3 * week)], now)).toBe(2)
})

test('the start line prefers the bead in progress', () => {
  const ready = JSON.stringify({ title: 'Ready one', status: 'open', priority: 1 })
  expect(startLine([ready, JSON.stringify({ title: 'Doing one', status: 'in_progress', updated_at: '2026-10-12' })].join('\n'))).toBe('Resume: Doing one')
  expect(startLine(ready)).toBe('Start: Ready one')
})

test('a successful git push draws the sparks above the band, then goes away', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  on('tool.call', () => ({ result: {}, text: 'To github.com:me/x.git\n   af68d1d..9199dfc  main -> main' }))
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  const band = await $.ui.mount({
    plugin: 'cues', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  expect(await band.findAll({ key: 'push-sparks' })).toHaveLength(1)
  expect(await band.findAll({ type: 'engine' })).toHaveLength(1)
  await clock.advance(60 * 40)
  expect(await band.findAll({ key: 'push-sparks' })).toEqual([])
})

test('the hint line shows the last Next step once the prompt is empty', async ($, on) => {
  const seen: string[] = []
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    seen.push(String((e.props as { hint?: unknown }).hint))
    return { type: 'engine' as const, ref: 0 }
  })
  await $.turn.complete({ answer: 'Done.\n\nNext: run the gate', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await $.ui.mount({ plugin: 'cues', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } })
  expect(seen).toContain('next: run the gate')
})
