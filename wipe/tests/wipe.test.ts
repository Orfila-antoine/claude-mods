import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { EFFECT_NAMES, EFFECTS, encode, glyphsOf, linesOf, screenText } from '../hooks/effects'

const decode = (cells: string) => {
  const bytes = Uint8Array.from(atob(cells), ch => ch.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  return Array.from({ length: words.length / 3 }, (_, k) => String.fromCodePoint(words[k * 3] ?? 32)).join('')
}

const pane = ($: Engine) =>
  $.ui.mount({
    plugin: 'wipe', surface: 'terminal', component: 'Pane', requestId: 'wipe',
    props: { title: ' ', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })

const output = ($: Engine, text: string, command = 'wipe') =>
  $.ui.mount({ plugin: 'wipe', surface: 'terminal', component: 'CommandOutput', props: { command, args: '', text, isErrored: false } })

const stage = (on: On) => {
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'some answer on screen', toolUses: [] }] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }) as never)
  return clock
}

const run = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 80 } })

test('every effect starts with the screen text in place and ends with an empty screen', () => {
  const glyphs = glyphsOf('hello world\nsecond line', 30, 10)
  for (const name of EFFECT_NAMES) {
    const effect = EFFECTS[name]
    expect(effect && decode(encode(effect(glyphs, 30, 10, 0), 30, 0, 10))).toContain('hello')
    expect(effect && decode(encode(effect(glyphs, 30, 10, 1), 30, 0, 10)).trim()).toBe('')
  }
})

test('the source text reads like the chat: prompt marks, reply dots, tool rows, no markdown', () => {
  const text = screenText([
    { role: 'user', text: 'fix the **bug**', toolUses: [] },
    { role: 'assistant', text: '## Done\nline two with `code`', toolUses: [{ tool: 'Edit', input: { file_path: 'C:\\repo\\src\\token.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{}] },
  ])
  expect(text).toBe('❯ fix the bug\n\n● Done\n  line two with code\n\n● Edit(src/token.ts)')
})

test('wide characters are left out, the raster only takes width-1 cells', () => {
  expect(glyphsOf('a🙂b漢c', 30, 5).map(one => one.ch).join('')).toBe('abc')
  expect(glyphsOf('❯ ● … ─', 30, 5).map(one => one.ch).join('')).toBe('❯●…─')
})

test('/wipe dust plays in the chat row and the pane, clears nothing, then the row folds', async ($, on) => {
  const clock = stage(on)
  const { text } = await $.command.run(run('wipe', 'dust'))
  expect(text).toMatch(/^dust #\d+$/)
  await clock.advance(100)
  const chat = await output($, text ?? '')
  const older = await output($, 'fade #1')
  const side = await pane($)
  expect(await chat.findAll({ key: 'wipe-chat' })).toHaveLength(1)
  expect(await older.findAll({ key: 'wipe-chat' })).toEqual([])
  expect(await side.findAll({ key: 'wipe' })).toHaveLength(1)
  await clock.advance(5000)
  expect(await chat.findAll({ key: 'wipe-chat' })).toEqual([])
  expect((await chat.findAll({ type: 'Text' }))[0]?.text).toBe('◌ wiped')
})

test('/wipe with an unknown name still plays one of the effects', async ($, on) => {
  stage(on)
  const { text } = await $.command.run(run('wipe', 'nope'))
  expect(EFFECT_NAMES).toContain(text?.split(' ')[0])
})

test('/clear plays a wipe in the chat row and the pane, then clears without the chat coming back', async ($, on) => {
  const clock = stage(on)
  let cleared = false
  let isHeldAtClear = false
  let chat: Awaited<ReturnType<typeof output>> | undefined
  on('command.run', async () => {
    cleared = true
    isHeldAtClear = (await chat?.findAll({ key: 'wipe-chat' }))?.length === 1
    return { text: '' }
  })
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  const { text } = await $.command.run(run('clear'))
  await clock.advance(100)
  chat = await output($, text ?? '', 'clear')
  const side = await pane($)
  expect(await chat.findAll({ key: 'wipe-chat' })).toHaveLength(1)
  expect(await side.findAll({ key: 'wipe' })).toHaveLength(1)
  expect(cleared).toBe(false)
  await clock.advance(5000)
  expect(cleared).toBe(true)
  expect(isHeldAtClear).toBe(true)
  expect(await chat.findAll({ key: 'wipe-chat' })).toEqual([])
})

test('a /new another mod runs plays in the pane and clears before it resolves', async ($, on) => {
  const clock = stage(on)
  let cleared = false
  on('command.run', () => {
    cleared = true
    return { text: '' }
  })
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  const running = $.command.run({ ...run('new'), origin: { kind: 'plugin' as const, name: 'backstage' } })
  await clock.advance(100)
  expect(await (await pane($)).findAll({ key: 'wipe' })).toHaveLength(1)
  expect(cleared).toBe(false)
  await clock.advance(5000)
  await running
  expect(cleared).toBe(true)
})

test('a band tree reads as its lines, buttons by their label', () => {
  const tree = { type: 'Box', props: { flexDirection: 'column' }, children: [
    { type: 'Text', props: {}, children: ['Spiral: same answer'] },
    { type: 'Box', props: {}, children: [{ type: 'Button', props: { key: 'b', label: 'Break' } }, { type: 'Text', props: {}, children: ['x'] }] },
  ] }
  expect(linesOf(tree)).toEqual(['Spiral: same answer', '[Break] x'])
  expect(linesOf({ type: 'engine', ref: 0 })).toEqual([])
})

test('during a wipe the band of other mods and the hint line play the same effect', async ($, on) => {
  const clock = stage(on)
  on('ui.render', ($, e) =>
    (e.component === 'AbovePrompt'
      ? { type: 'Box', props: { flexDirection: 'column' }, children: [{ type: 'Text', props: {}, children: ['a band of another mod'] }] }
      : { type: 'engine' as const, ref: 0 }) as never,
  )
  await $.command.run(run('wipe', 'fade'))
  await clock.advance(100)
  const band = await $.ui.mount({
    plugin: 'wipe', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  const hint = await $.ui.mount({ plugin: 'wipe', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } })
  expect(await band.findAll({ key: 'wipe-band' })).toHaveLength(1)
  expect(await hint.findAll({ key: 'wipe-hint' })).toHaveLength(1)
  await clock.advance(5000)
  expect(await band.findAll({ key: 'wipe-band' })).toEqual([])
  expect(await hint.findAll({ key: 'wipe-hint' })).toEqual([])
})
