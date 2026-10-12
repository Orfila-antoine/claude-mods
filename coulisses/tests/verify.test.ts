import { expect, test } from 'claude-code/testing'

import { mountBand, press, stage } from './harness'

test('Verify without a selection checks the weakest claim of the last answer', async ($, on) => {
  const { briefs, toasts } = stage(on, { messages: [{ role: 'assistant', text: 'the cache is cold, so the page is slow' }] })
  await mountBand($)
  await press($, 'verify')
  expect(briefs).toHaveLength(1)
  expect(briefs[0]).toContain('Claim to verify: "the cache is cold"')
  expect(briefs[0]).toContain('Suggested check: read the logs')
  expect(toasts).toEqual(['Scout spawn refused'])
})

test('Verify with a selection checks the selection', async ($, on) => {
  const { briefs } = stage(on, { selection: 'port 5010 is free' })
  await mountBand($)
  await press($, 'verify')
  expect(briefs).toHaveLength(1)
  expect(briefs[0]).toContain('Claim to verify: "port 5010 is free"')
})

test('Verify with nothing to check says so', async ($, on) => {
  const { briefs, toasts } = stage(on)
  await mountBand($)
  await press($, 'verify')
  expect(briefs).toEqual([])
  expect(toasts).toEqual(['Nothing to verify: select a sentence first'])
})
