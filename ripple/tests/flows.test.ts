import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SESSION = '/work'
const ROOT = '/work/repo'
const OPEN = { command: 'ripple', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

function stage(on: On, session = SESSION) {
  const clock = mock.clock(on)
  on('session.root', () => ({ value: session }))
  on('fs.exists', ($, e) => ({ value: e.path.replace(/\\/g, '/').endsWith(`${ROOT}/.git`) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', ($, e) => {
    const call = e as unknown as { tool: string }
    if (call.tool === 'Edit') return { result: { structuredPatch: [{ lines: [' import x', '-const ttl = 60', '+const ttl = 3600'] }] }, text: 'ok' }
    if (call.tool === 'Write') return { result: { type: 'create', content: 'a', structuredPatch: [] }, text: 'ok' }
    if (call.tool === 'Grep') return { result: { filenames: [`${ROOT}/src/auth.ts`, `${ROOT}/src/token.ts`, `${ROOT}/api/client.ts`] }, text: '' }
    return { result: {}, text: 'ok' }
  })
  return { clock }
}

const pane = ($: Engine) =>
  $.ui.mount({
    plugin: 'ripple', surface: 'terminal', component: 'Pane', requestId: 'ripple',
    props: { title: 'Ripple', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })

const textOf = async (view: Awaited<ReturnType<typeof pane>>) => (await view.findAll({ type: 'Text' })).map(found => found.text).join('|')

test('with /ripple open, an edit shows the tree of the files that use it', async ($, on) => {
  const { clock } = stage(on)
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await clock.advance(60 * 40)
  const text = await textOf(view)
  expect(text).toContain('src/')
  expect(text).toContain('  token.ts')
  expect(text).toContain('+1')
  expect(text).toContain('  auth.ts')
  expect(text).toContain('api/')
  expect(text).toContain('  client.ts')
})

test('dependents are found when the session is the repo itself', async ($, on) => {
  const { clock } = stage(on, ROOT)
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await clock.advance(60 * 40)
  expect(await textOf(view)).toContain('  client.ts')
})

test('a file edited twice stays lit as the latest edit', async ($, on) => {
  const { clock } = stage(on)
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'b', new_string: 'a' })
  await clock.advance(60 * 40)
  const name = (await view.findAll({ type: 'Text' })).find(found => found.text === '  token.ts' && 'color' in found.props)
  expect(name?.props.bold).toBe(true)
  expect(name?.props.color).toBe('#d5d550')
})

test('a new file reads green, a removed one grey', async ($, on) => {
  const { clock } = stage(on)
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/fresh.ts`, content: 'a' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await clock.advance(60 * 40)
  await $.tool.call({ tool: 'Bash', command: `cd ${ROOT} && rm src/token.ts` })
  await clock.advance(60 * 40)
  const colorOf = async (text: string) => (await view.findAll({ type: 'Text' })).find(found => found.text === text && 'color' in found.props)?.props.color
  expect(await colorOf('  fresh.ts')).toBe('#50d550')
  expect(await colorOf('  token.ts')).toBe('gray')
})

test('the tree grows as the wave reaches each dependent', async ($, on) => {
  const { clock } = stage(on)
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await clock.advance(400)
  const early = await textOf(view)
  expect(early).toContain('auth.ts  ~ uses token.ts')
  expect(early).not.toContain('client.ts')
  await clock.advance(60 * 40)
  const late = await textOf(view)
  expect(late).toContain('client.ts')
  expect(late).not.toContain('~ uses')
})

test('each agent gets its own section, labelled with its brief', async ($, on) => {
  const { clock } = stage(on)
  on('agent.list', () => ({ value: [{ id: 'agent-42', description: 'Refactor auth' }] }) as never)
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/auth.ts`, old_string: 'a', new_string: 'b', agentId: 'agent-42' } as never)
  await clock.advance(60 * 40)
  const text = await textOf(view)
  expect(text.indexOf('Claude')).toBeGreaterThanOrEqual(0)
  expect(text.indexOf('Claude')).toBeLessThan(text.indexOf('agent: Refactor auth'))
})

test('an edit collapses to one line in the conversation, with its counts', async ($, on) => {
  stage(on)
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  const row = await $.ui.mount({
    plugin: 'ripple', surface: 'terminal', component: 'ToolUse',
    props: { tool_use_id: 'toolu_1', tool: 'Edit', input: { file_path: `${ROOT}/src/token.ts` }, output: { structuredPatch: [{ lines: ['-a', '+b', '+c'] }] }, isRunning: false, isErrored: false, isInterrupted: false },
  })
  const text = (await row.findAll({ type: 'Text' })).map(found => found.text).join('|')
  expect(text).toContain('Edit(src/token.ts)')
  expect(text).toContain('+2')
  expect(text).toContain('-1')
})

test('the diff under a collapsed edit is hidden, a sensitive file keeps it', async ($, on) => {
  stage(on)
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  const ok = await $.ui.mount({
    plugin: 'ripple', surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: 'toolu_2', tool: 'Edit', output: { filePath: `${ROOT}/src/token.ts`, structuredPatch: [] }, isErrored: false },
  })
  expect(await ok.findAll({ type: 'Box' })).toHaveLength(1)
  const sensitive = await $.ui.mount({
    plugin: 'ripple', surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: 'toolu_3', tool: 'Edit', output: { filePath: `${ROOT}/.env.local`, structuredPatch: [] }, isErrored: false },
  })
  expect(await sensitive.findAll({ type: 'Box' })).toEqual([])
})
