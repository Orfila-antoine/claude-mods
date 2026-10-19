import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SESSION = '/work'
const ROOT = '/work/repo'
const OPEN = { command: 'ripple', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

function stage(on: On, session = SESSION, stored: Record<string, unknown> = {}) {
  const clock = mock.clock(on)
  mock.store(on, stored)
  const gone = new Set<string>()
  const failing = new Set<string>()
  const aborting = new Set<string>()
  const held = new Map<string, Promise<void>>()
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  on('session.root', () => ({ value: session }))
  on('fs.exists', ($, e) => {
    const path = e.path.replace(/\\/g, '/')
    return { value: path.endsWith('/.git') ? path.endsWith(`${ROOT}/.git`) : ![...gone].some(one => path.endsWith(one)) }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', async ($, e) => {
    const call = e as unknown as { tool: string; tool_use_id: string }
    await held.get(call.tool_use_id)
    if (aborting.has(call.tool_use_id)) throw new Error('aborted')
    if (failing.has(call.tool_use_id)) return { result: 'String not found', text: 'String not found', isError: true }
    if (call.tool === 'Edit') return { result: { structuredPatch: [{ lines: [' import x', '-const ttl = 60', '+const ttl = 3600'] }] }, text: 'ok' }
    if (call.tool === 'Write') return { result: { type: 'create', content: 'a', structuredPatch: [] }, text: 'ok' }
    if (call.tool === 'Grep') return { result: { filenames: [`${ROOT}/src/auth.ts`, `${ROOT}/src/token.ts`, `${ROOT}/api/client.ts`] }, text: '' }
    return { result: {}, text: 'ok' }
  })
  return { clock, gone, failing, aborting, held }
}

const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as Parameters<Engine['tool']['call']>[0])

const edit = ($: Engine, id: string, file = `${ROOT}/src/token.ts`) => call($, { tool: 'Edit', tool_use_id: id, file_path: file, old_string: 'a', new_string: 'b' })

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

test('a pane left open in an earlier session reopens and tracks edits without /ripple', async ($, on) => {
  on('session.start', ($, e) => e)
  const { clock } = stage(on, SESSION, { isOpen: true })
  await $.session.start({ cwd: SESSION, surface: 'terminal', isInteractive: true })
  const view = await pane($)
  await edit($, 'e-reopen')
  await clock.advance(60 * 40)
  expect(await textOf(view)).toContain('  token.ts')
})

test('an open pane keeps tracking edits after /clear', async ($, on) => {
  on('classic.SessionStart', () => ({}))
  const { clock } = stage(on, SESSION, { isOpen: true })
  await $.classic.SessionStart({ source: 'clear' })
  const view = await pane($)
  await edit($, 'e-clear')
  await clock.advance(60 * 40)
  expect(await textOf(view)).toContain('  token.ts')
})

test('dependents are found when the session is the repo itself', async ($, on) => {
  const { clock } = stage(on, ROOT)
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await clock.advance(60 * 40)
  expect(await textOf(view)).toContain('  client.ts')
})

test('a file edited twice is one line, lit, with the counts summed', async ($, on) => {
  const { clock } = stage(on)
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'b', new_string: 'a' })
  await clock.advance(60 * 40)
  const name = (await view.findAll({ type: 'Text' })).find(found => found.text === '  token.ts' && 'color' in found.props)
  expect(name?.props.bold).toBe(true)
  expect(name?.props.color).toBe('#d5d550')
  const text = await textOf(view)
  expect(text).toContain('  token.ts +2 -2 x2')
  expect(text.split('  token.ts +').length).toBe(2)
})

function git(on: On, answers: Record<string, string>) {
  on('process.run', ($, e) => {
    const verb = e.argv[1] ?? ''
    return { value: { exitCode: 0, stdout: answers[verb] ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: 'one\ntwo\nthree\n' }))
}

test('in a git repo, the counts are the net diff against HEAD, not the sum of edits', async ($, on) => {
  const { clock } = stage(on)
  git(on, { diff: '3\t1\tsrc/token.ts\n' })
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'b', new_string: 'c' })
  await clock.advance(60 * 40)
  expect(await textOf(view)).toContain('  token.ts +3 -1 x2')
})

test('an edit undone reads +0 -0 against HEAD', async ($, on) => {
  const { clock } = stage(on)
  git(on, { diff: '', 'ls-files': 'src/token.ts\n' })
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await clock.advance(60 * 40)
  expect(await textOf(view)).toContain('  token.ts +0 -0')
})

test('an untracked file counts all its lines as new', async ($, on) => {
  const { clock } = stage(on)
  git(on, { diff: '', 'ls-files': '' })
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await clock.advance(60 * 40)
  expect(await textOf(view)).toContain('  token.ts +3 -0')
  expect(await colorOf(view, '  token.ts')).toBe('#50d550')
})

test("an edit to Claude's memory never reaches the pane", async ($, on) => {
  const { clock } = stage(on)
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Edit', file_path: '/home/me/.claude/projects/x/memory/fact.md', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await clock.advance(60 * 40)
  const text = await textOf(view)
  expect(text).toContain('token.ts')
  expect(text).not.toContain('fact.md')
})

test('every edited file stays in the tree, not only the last few', async ($, on) => {
  const { clock } = stage(on)
  await $.command.run(OPEN)
  const view = await pane($)
  const names = Array.from({ length: 25 }, (_, k) => `file${k}`)
  for (const name of names) {
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/lib/${name}.ts`, old_string: 'a', new_string: 'b' })
    await clock.advance(60 * 40)
  }
  const text = await textOf(view)
  for (const name of names) expect(text).toContain(`  ${name}.ts`)
})

const colorOf = async (view: Awaited<ReturnType<typeof pane>>, text: string) =>
  (await view.findAll({ type: 'Text' })).find(found => found.text === text && 'color' in found.props)?.props.color

test('a new file reads green, a removed one grey', async ($, on) => {
  const { clock, gone } = stage(on)
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/fresh.ts`, content: 'a' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/token.ts`, old_string: 'a', new_string: 'b' })
  await clock.advance(60 * 40)
  gone.add(`${ROOT}/src/token.ts`)
  await $.tool.call({ tool: 'Bash', command: `cd ${ROOT} && rm src/token.ts` })
  await clock.advance(60 * 40)
  expect(await colorOf(view, '  fresh.ts')).toBe('#50d550')
  expect(await colorOf(view, '  token.ts')).toBe('gray')
})

test('a removal elsewhere leaves the files still on disk in color', async ($, on) => {
  const { clock } = stage(on)
  await $.command.run(OPEN)
  const view = await pane($)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/fresh.ts`, content: 'a' })
  await clock.advance(60 * 40)
  await $.tool.call({ tool: 'Bash', command: 'cd /elsewhere && rm -rf src repo' })
  await clock.advance(60 * 40)
  expect(await colorOf(view, '  fresh.ts')).toBe('#50d550')
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
  await call($, { tool: 'Edit', file_path: `${ROOT}/src/auth.ts`, old_string: 'a', new_string: 'b', agentId: 'agent-42' })
  await clock.advance(60 * 40)
  const text = await textOf(view)
  expect(text.indexOf('Claude')).toBeGreaterThanOrEqual(0)
  expect(text.indexOf('Claude')).toBeLessThan(text.indexOf('agent: Refactor auth'))
})


type RowProps = { output?: unknown; isRunning?: boolean; file?: string }

const row = ($: Engine, id: string, { output = { structuredPatch: [{ lines: ['-a', '+b'] }] }, isRunning = false, file = `${ROOT}/src/token.ts` }: RowProps = {}) =>
  $.ui.mount({
    plugin: 'ripple', surface: 'terminal', component: 'ToolUse',
    props: { tool_use_id: id, tool: 'Edit', input: { file_path: file }, output, isRunning, isErrored: false, isInterrupted: false },
  })

const lineOf = async (mounted: Awaited<ReturnType<typeof row>>) => (await mounted.findAll({ type: 'Text' }))[0]?.text ?? null

test('an edit collapses to one line in the conversation, with its counts', async ($, on) => {
  stage(on)
  expect(await lineOf(await row($, 'toolu_1', { output: { structuredPatch: [{ lines: ['-a', '+b', '+c'] }] } }))).toBe('● Edit  src/token.ts  +2 -1')
})

test('edits in a row on one file fold into the last row, with the counts summed', async ($, on) => {
  stage(on)
  await edit($, 'e1')
  await edit($, 'e2')
  await edit($, 'e3')
  expect(await lineOf(await row($, 'e1'))).toBeNull()
  expect(await lineOf(await row($, 'e2'))).toBeNull()
  expect(await lineOf(await row($, 'e3'))).toBe('● Edit  src/token.ts  +3 -3 x3')
})

test('an edit joining a run shows the run counts at once, not a pending line', async ($, on) => {
  const { clock, held } = stage(on)
  await edit($, 'e1')
  expect(await lineOf(await row($, 'e2', { output: null, isRunning: true }))).toBeNull()
  let release = () => {}
  held.set('e2', new Promise(resolve => (release = resolve)))
  const running = edit($, 'e2')
  await clock.advance(1)
  expect(await lineOf(await row($, 'e2', { output: null, isRunning: true }))).toBe('● Edit  src/token.ts  +1 -1 x2')
  expect(await lineOf(await row($, 'e1'))).toBeNull()
  release()
  await running
  expect(await lineOf(await row($, 'e2'))).toBe('● Edit  src/token.ts  +2 -2 x2')
})

test('a queued edit with no result yet stays hidden, not +0 -0', async ($, on) => {
  stage(on)
  expect(await lineOf(await row($, 'e9', { output: null }))).toBeNull()
})

test('a new turn starts a new run', async ($, on) => {
  stage(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await edit($, 'e1')
  await $.turn.start({ text: 'again', turnId: 't2' })
  await edit($, 'e2')
  expect(await lineOf(await row($, 'e1'))).toBe('● Edit  src/token.ts  +1 -1')
  expect(await lineOf(await row($, 'e2'))).toBe('● Edit  src/token.ts  +1 -1')
})

test('another call in between starts a new run', async ($, on) => {
  stage(on)
  await edit($, 'e1')
  await call($, { tool: 'Read', tool_use_id: 'r1', file_path: `${ROOT}/src/token.ts` })
  await edit($, 'e2')
  await edit($, 'e3', `${ROOT}/src/auth.ts`)
  expect(await lineOf(await row($, 'e1'))).toBe('● Edit  src/token.ts  +1 -1')
  expect(await lineOf(await row($, 'e2'))).toBe('● Edit  src/token.ts  +1 -1')
})

test("ripple's own search with the pane open does not break a run", async ($, on) => {
  const { clock } = stage(on)
  await $.command.run(OPEN)
  await pane($)
  await edit($, 'e1')
  await clock.advance(60 * 40)
  await edit($, 'e2')
  expect(await lineOf(await row($, 'e2'))).toBe('● Edit  src/token.ts  +2 -2 x2')
})

test('a failed or aborted edit leaves the run, the one before shows again', async ($, on) => {
  const { failing, aborting } = stage(on)
  failing.add('e2')
  aborting.add('e4')
  await edit($, 'e1')
  await edit($, 'e2')
  expect(await lineOf(await row($, 'e1'))).toBe('● Edit  src/token.ts  +1 -1')
  await edit($, 'e3')
  await edit($, 'e4').catch(() => undefined)
  expect(await lineOf(await row($, 'e3'))).toBe('● Edit  src/token.ts  +1 -1')
})

test('an edit waits hidden until it starts, then runs as one line, so no diff flashes', async ($, on) => {
  const { clock, held } = stage(on)
  expect(await lineOf(await row($, 'e1', { output: null, isRunning: true }))).toBeNull()
  let release = () => {}
  held.set('e1', new Promise(resolve => (release = resolve)))
  const running = edit($, 'e1')
  await clock.advance(1)
  const started = await row($, 'e1', { output: null, isRunning: true })
  expect(await lineOf(started)).toBe('● Edit  src/token.ts  …')
  expect(await started.findAll({ type: 'engine' })).toEqual([])
  release()
  await running
  expect(await lineOf(await row($, 'e1'))).toBe('● Edit  src/token.ts  +1 -1')
})

test('the diff under a collapsed edit is hidden, a sensitive file keeps it', async ($, on) => {
  stage(on)
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

test('a shell command that edits files shows one line per file, not its diff', async ($, on) => {
  stage(on)
  const files = [
    { filePath: `${ROOT}/src/token.ts`, hunks: [{ lines: [' a', '-b', '+c', '+d'] }] },
    { filePath: `${ROOT}/src/new.ts`, hunks: [{ lines: ['+x'] }], created: true as const },
  ]
  const quiet = await $.ui.mount({
    plugin: 'ripple', surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: 'toolu_4', tool: 'Bash', output: { stdout: '', stderr: '', bashEditDiff: { files, moreFiles: 2 } }, isErrored: false },
  })
  expect(await quiet.findAll({ type: 'engine' })).toEqual([])
  const shown = async (view: typeof quiet) => (await view.findAll({ type: 'Text' })).map(found => found.text).join('|')
  expect(await shown(quiet)).toContain('token.ts|  +2| -1')
  expect(await shown(quiet)).toContain('new.ts|  +1| -0')
  expect(await shown(quiet)).toContain('+2 more files')
  const loud = await $.ui.mount({
    plugin: 'ripple', surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: 'toolu_5', tool: 'Bash', output: { stdout: 'done', stderr: '', bashEditDiff: { files, moreFiles: 0 } }, isErrored: false },
  })
  expect(await loud.findAll({ type: 'engine' })).toHaveLength(1)
  const sensitive = await $.ui.mount({
    plugin: 'ripple', surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: 'toolu_6', tool: 'Bash', output: { stdout: '', stderr: '', bashEditDiff: { files: [{ filePath: `${ROOT}/.env.local`, hunks: [] }], moreFiles: 0 } }, isErrored: false },
  })
  expect(await sensitive.findAll({ type: 'Box' })).toEqual([])
})
