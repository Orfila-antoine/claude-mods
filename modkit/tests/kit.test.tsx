import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { decode } from '../hooks/modkit/grid'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} }
const CLOCK = 'modkit-modkit-clock'

const stage = (on: On) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.store(on)
  const seen = { logs: [] as string[], blits: [] as { key: string; cells: string }[], renders: 0, denyNext: false, sessionId: 's1' }
  on('session.id', () => ({ value: seen.sessionId }))
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.blit', ($, e) => {
    if (seen.denyNext) {
      seen.denyNext = false
      return { value: { deny: 'another size' } }
    }
    if ('cells' in e) seen.blits.push({ key: e.key, cells: e.cells })
    return { value: {} }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', () => {
    seen.renders += 1
    return { type: 'engine' as const, ref: 0 }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.run', ($, e) => ({ text: `core ran /${e.command}` }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return { clock, seen }
}

const band = ($: Engine, bodyColumns = 80) =>
  $.ui.mount({ plugin: 'modkit', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, bodyColumns } })
const submit = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
const answer = ($: Engine, agentId?: string) =>
  $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...(agentId ? { agentId } : {}) })
const command = ($: Engine, name: string) =>
  $.command.run({ command: name, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)
const keysOf = (tree: unknown) =>
  ((tree as { children?: { type: string; props?: { key?: string } }[] }).children ?? []).map(child => child.props?.key ?? child.type)
const fgAt = (cells: string, x: number) => new Uint32Array(Uint8Array.from(atob(cells), ch => ch.charCodeAt(0)).buffer)[x * 3 + 1] ?? 0
const brightness = (color: number) => ((color >> 16) & 0xff) + ((color >> 8) & 0xff) + (color & 0xff)

test('a prompt goes through every mod in order and reaches the engine transformed', async ($, on) => {
  stage(on)
  const ui = await band($)
  const sent = await submit($, 'hi :shrug:')
  expect('text' in sent ? sent.text : '').toBe('hi ¯\\_(ツ)_/¯')
  expect((await ui.find({ type: 'Text', text: /modkit · 1 messages/ }))).toBeDefined()
  expect(await ui.findAll({ key: CLOCK })).toHaveLength(1)
})

test('a step and a layer that throw are skipped and named, the other steps and layers carry on', async ($, on) => {
  const { seen } = stage(on)
  const ui = await band($)
  await submit($, 'start the clock')
  const ran = await command($, 'kit-boom')
  expect(ran.text).toMatch(/this step still answered/)
  await ui.redraw()
  await ui.redraw()
  expect(seen.logs.filter(line => line.includes('step boom failed: boom, on purpose'))).toHaveLength(1)
  expect(seen.logs.filter(line => line.includes('layer boom grid failed: boom layer, on purpose'))).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /modkit · 1 messages/ })).toBeDefined()
  expect(await ui.findAll({ key: CLOCK })).toHaveLength(1)
})

test('an event no mod handles reaches the engine as it came, and an agent turn is not the main turn', async ($, on) => {
  const { clock } = stage(on)
  const ui = await band($)
  expect((await command($, 'something-else')).text).toBe('core ran /something-else')
  await submit($, 'go')
  await answer($, 'agent-1')
  await clock.advance(1000)
  expect(await ui.findAll({ key: CLOCK })).toHaveLength(1)
  await answer($)
  await clock.advance(1000)
  expect(await ui.findAll({ key: CLOCK })).toEqual([])
})

test(
  'layers stack by z above the engine band, and a plugin beneath slots in by its own z',
  {
    plugins: [
      {
        name: 'beneath',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
            const below = await next(e)
            const { Box, Text } = $.ui.resolve(e)
            return (
              <Box key="modkit-stack" flexDirection="column">
                <Box key="modkit:7:beneath:x">
                  <Text>beneath</Text>
                </Box>
                {below}
              </Box>
            )
          })
        },
      },
    ],
  },
  async ($, on) => {
    stage(on)
    await submit($, 'go')
    const ui = await band($)
    expect(keysOf(await ui.drawn())).toEqual(['modkit:11:modkit:clock', 'modkit:7:beneath:x', 'modkit:5:modkit:echo/line', 'engine'])
  },
)

test('the clock fades in and out through blits, the tree drawn only when its state changes', async ($, on) => {
  const { clock, seen } = stage(on)
  const ui = await band($)
  await submit($, 'go')
  await ui.drawn()
  const renders = seen.renders
  await clock.advance(330)
  const frames = seen.blits.filter(blit => blit.key === CLOCK)
  expect(frames.length).toBeGreaterThan(5)
  expect(seen.renders).toBe(renders)
  const first = frames[0]
  const last = frames.at(-1)
  expect(first && last && brightness(fgAt(first.cells, 0)) < brightness(fgAt(last.cells, 0))).toBe(true)

  await answer($)
  await clock.advance(250)
  expect(await ui.findAll({ key: CLOCK })).toHaveLength(1)
  await clock.advance(400)
  expect(await ui.findAll({ key: CLOCK })).toEqual([])
})

test('a resize during the animation remounts the raster at the new width and the clock goes on', async ($, on) => {
  const { clock, seen } = stage(on)
  const ui = await band($)
  await submit($, 'go')
  await clock.advance(100)
  expect(decode(seen.blits.at(-1)?.cells ?? '', 80)[0]).toHaveLength(80)

  await ui.redraw({ ...PROPS, bodyColumns: 40 })
  expect((await ui.find({ key: CLOCK }))?.props.columns).toBe(40)
  await clock.advance(100)
  expect(decode(seen.blits.at(-1)?.cells ?? '', 40)).toHaveLength(1)

  seen.denyNext = true
  const renders = seen.renders
  await clock.advance(100)
  expect(seen.renders).toBeGreaterThan(renders)
  const count = seen.blits.length
  await clock.advance(100)
  expect(seen.blits.length).toBeGreaterThan(count)
})

test('a mod switched off in /config does not load, the others do', { options: { clock: false } }, async ($, on) => {
  stage(on)
  const ui = await band($)
  const sent = await submit($, ':shrug:')
  expect('text' in sent ? sent.text : '').toBe('¯\\_(ツ)_/¯')
  expect(await ui.findAll({ key: CLOCK })).toEqual([])
  expect(await ui.find({ type: 'Text', text: /modkit · 1 messages/ })).toBeDefined()
})

test('/clear resets every mod to its start, as a new session does', async ($, on) => {
  const { seen } = stage(on)
  const ui = await band($)
  await submit($, 'one')
  await submit($, 'two')
  expect(await ui.find({ type: 'Text', text: /modkit · 2 messages/ })).toBeDefined()
  seen.sessionId = 's2'
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  expect(await ui.find({ type: 'Text', text: /modkit · 0 messages/ })).toBeDefined()
})

test('a reload of the plugin within the session keeps every mod state', async ($, on) => {
  stage(on)
  const ui = await band($)
  await submit($, 'one')
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true } as never)
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /modkit · 1 messages/ })).toBeDefined()
})
