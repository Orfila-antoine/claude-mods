import { expect, test } from 'claude-code/testing'

import { HAIKU, mountBand, press, stage, typed } from './harness'

test('without a draft, Haiku writes a prompt of the chosen type', async ($, on) => {
  const { asked, filled } = stage(on)
  await mountBand($)
  await press($, 'pick')
  await press($, 'type-bug')
  expect(asked[0]?.model).toBe('haiku')
  expect(asked[0]?.system).toContain('A good Bug fix prompt')
  expect(asked[0]?.prompt).toContain('There is no draft')
  expect(filled).toEqual([HAIKU])
})

test('Haiku is given the recent conversation', async ($, on) => {
  const { asked } = stage(on, {
    draft: 'fix it',
    messages: [
      { role: 'user', text: 'the Verify button does nothing' },
      { role: 'user', text: '' },
      { role: 'assistant', text: 'the scout id was lost on reload' },
    ],
  })
  await mountBand($)
  await press($, 'rewrite')
  expect(asked[0]?.prompt).toContain('Developer: the Verify button does nothing\n\nAssistant: the scout id was lost on reload')
  expect(asked[0]?.system).toContain('no placeholder')
})

test('✨✏️ rewrites the draft and Undo Haiku restores it', async ($, on) => {
  const { asked, box } = stage(on, { draft: 'login broken' })
  const band = await mountBand($)
  await press($, 'rewrite')
  expect(asked[0]?.system).toContain('clear and precise')
  expect(asked[0]?.prompt).toContain('Rewrite this draft:\n<<<\nlogin broken')
  expect(box.text).toBe(HAIKU)

  await press($, 'undo')
  expect(box.text).toBe('login broken')
  expect(await band.findAll({ key: 'undo' })).toEqual([])
})

test('chained rewrites keep the original draft for Undo', async ($, on) => {
  const { asked, box } = stage(on, { draft: 'login broken' })
  await mountBand($)
  await press($, 'rewrite')
  await press($, 'ideas')
  await press($, 'idea-overdrive')
  expect(asked[1]?.system).toContain('more ambitious')

  await press($, 'undo')
  expect(box.text).toBe('login broken')
})

test('Undo Haiku goes away once the prompt is sent or edited', async ($, on) => {
  const { type } = stage(on, { draft: 'login broken' })
  const band = await mountBand($)

  await press($, 'rewrite')
  await $.prompt.submit(typed(HAIKU))
  expect(await band.findAll({ key: 'undo' })).toEqual([])

  await type($, 'login broken again')
  await press($, 'rewrite')
  await type($, ' and the logout too')
  expect(await band.findAll({ key: 'undo' })).toEqual([])
})

test('refining an empty draft does not call Haiku', async ($, on) => {
  const { asked, toasts } = stage(on)
  await mountBand($)
  await press($, 'rewrite')
  expect(asked).toEqual([])
  expect(toasts).toEqual(['Type a draft first'])
})
