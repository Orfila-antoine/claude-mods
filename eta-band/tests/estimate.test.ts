import { expect, test } from 'claude-code/testing'

import {
  bucketOf,
  calibration,
  costOf,
  estimate,
  extract,
  hms,
  isReliable,
  remaining,
  remainingOfMax,
  taskRemaining,
  weightedQuantile,
  type Features,
  type TurnRecord,
} from '../hooks/estimate'

const NOW = 1_800_000_000
const f = extract('implement the list page and add the tests')
const record = (durS: number, predP50?: number): TurnRecord => ({ f, project: '/w', model: 'opus', durS, endedAt: NOW, predP50 })
const near = (a: number, b: number, tolerance = 0.5) => Math.abs(a - b) < tolerance

test('known answers of the building blocks', async () => {
  expect(weightedQuantile([[10, 1], [20, 1]], 0.5)).toBe(15)
  expect(hms(3725)).toBe('01:02:05')
  expect(hms(59.6)).toBe('00:01:00')
  expect(f.kind).toBe('task')
  expect(extract('why does it break?').kind).toBe('question')
  expect(extract('/review').command).toBe('review')
  expect(bucketOf(30)).toBe(null)
  expect(bucketOf(240)).toBe('short')
  expect(bucketOf(4000)).toBe('very-long')
})

test('a question word inside the prompt does not make it a question', async () => {
  expect(extract('thanks, so the ticket is closed now').kind).toBe('chat')
  expect(extract('who wrote this module').kind).toBe('question')
})

test('French prompts are classified too', async () => {
  expect(extract('implémente la page de liste').kind).toBe('task')
  expect(extract('pourquoi ça casse').kind).toBe('question')
  expect(extract('merci, le ticket qui traîne est fermé').kind).toBe('chat')
})

test('parity with et-ay 051b680 estimator.py on the start-of-turn estimate', async () => {
  const task = (chars: number): Features => ({ chars, kind: 'task', command: null, broad: false, mentions: 0 })
  const hist: TurnRecord[] = Array.from({ length: 8 }, (_, i) => ({
    f: task(100 + 10 * i),
    project: '/w',
    model: 'opus',
    durS: 200 + 25 * i,
    endedAt: NOW - 86400 * i,
  }))
  const current = { f: task(120), project: '/w', model: 'opus' }
  const est = estimate(current, hist, NOW)
  expect(near(est.similar, 7.98, 0.01)).toBe(true)
  expect(near(est.p50Raw, 274.4)).toBe(true)
  expect(near(estimate(current, [], NOW).p50Raw, 151.9)).toBe(true)
})

test('dissimilar history does not count as similar turns', async () => {
  const chats: TurnRecord[] = Array.from({ length: 10 }, () => ({ f: extract('thanks'), durS: 20, endedAt: NOW }))
  expect(estimate({ f: extract('/review') }, chats, NOW).similar).toBe(0)
})

test('the remaining time never jumps while the turn runs, it only drifts smoothly (reported 2:35 → 2:00 → 2:35 loop)', async () => {
  const est = estimate({ f, project: '/w', model: 'opus' }, [150, 155, 190].map(durS => record(durS)), NOW)
  let worstJump = 0
  let previous = remaining(est.sample, 0).p50
  for (let elapsed = 1; elapsed <= 400; elapsed++) {
    const current = remaining(est.sample, elapsed).p50
    worstJump = Math.max(worstJump, current - previous)
    previous = current
  }
  expect(worstJump < 2).toBe(true)
})

test('a single past duration is the median of the remaining time at the start', async () => {
  expect(near(remaining([[300, 1]], 0).p50, 300)).toBe(true)
})

test('ten identical turns: ten similar, median close to their duration', async () => {
  const est = estimate({ f, project: '/w', model: 'opus' }, Array.from({ length: 10 }, () => record(300)), NOW)
  expect(Math.round(est.similar)).toBe(10)
  const p50 = remaining(est.sample, 0).p50
  expect(p50 > 260 && p50 <= 300).toBe(true)
})

test('a turn past every comparable one grows with elapsed time', async () => {
  const r = remaining([[100, 1], [120, 1]], 1000)
  expect(r.overdue).toBe(true)
  expect(r.p50).toBe(350)
})

test('calibration learns a systematic underestimate', async () => {
  expect(calibration(Array.from({ length: 4 }, () => record(300, 150)), NOW)).toBe(1)
  expect(Math.round(calibration(Array.from({ length: 10 }, () => record(300, 150)), NOW) * 1000) / 1000).toBe(2)
  const calibrated = estimate({ f, project: '/w', model: 'opus' }, Array.from({ length: 10 }, () => record(300, 150)), NOW)
  expect(Math.round(calibrated.p50Raw)).toBe(300)
  expect(Math.round(weightedQuantile(calibrated.sample, 0.5) ?? 0)).toBe(600)
})

test('parallel agents: the end of all is later than the end of one', async () => {
  const one = { sample: [[300, 1]] as [number, number][], elapsedS: 0 }
  const single = remainingOfMax([one])
  const pair = remainingOfMax([one, one])
  expect(single !== null && near(single.p50, 300)).toBe(true)
  expect(pair !== null && single !== null && pair.p50 > single.p50 + 10).toBe(true)
})

test('task pace comes from real task durations', async () => {
  expect(taskRemaining([], 2, null)).toBe(null)
  expect(taskRemaining([60, 60], 2, 20)).toBe(160)
})

test('a prompt-based estimate counts only once it has proven close on your own turns', async () => {
  const judged = (ratio: number): TurnRecord => ({ ...record(100 * ratio), predP50: 100 })
  expect(isReliable(Array.from({ length: 9 }, () => judged(1)))).toBe(false)
  expect(isReliable(Array.from({ length: 10 }, () => judged(1.2)))).toBe(true)
  expect(isReliable([...Array.from({ length: 6 }, () => judged(1)), ...Array.from({ length: 4 }, () => judged(8))])).toBe(false)
  const notifications: TurnRecord[] = Array.from({ length: 10 }, () => ({ f: extract('<task-notification>done'), durS: 5, endedAt: NOW, predP50: 5 }))
  expect(isReliable(notifications)).toBe(false)
})

test('cost uses the model price, unknown models give no amount', async () => {
  const million = { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(costOf('claude-opus-5-5[1m]', million)).toBe(4)
  expect(costOf('claude-haiku-5-5', { ...million, input_tokens: 0, output_tokens: 1e6 })).toBe(0.5)
  expect(costOf('gpt-5', million)).toBe(null)
})
