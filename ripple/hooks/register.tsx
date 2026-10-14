import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Last, Ripple, Run } from '../types'
import { ADDED, REMOVED, editColor, editStats, foundIn, isHousekeeping, isRemoval, isSensitive, relativeTo, shortPath, toSlash, treeLines } from './logic'

const edits = atom({ plugin: 'ripple', key: 'edits' } as const, [], { shape: 'ripple-v3' })
const wave = atom({ plugin: 'ripple', key: 'wave' } as const, null)
const isOpen = atom({ plugin: 'ripple', key: 'isOpen' } as const, false)
const last = atom({ plugin: 'ripple', key: 'last' } as const, {}, { shape: 'ripple-last-v2' })
const fold = atom({ plugin: 'ripple', key: 'fold' } as const, null, { shape: 'ripple-fold-v2' })
const runs = atom({ plugin: 'ripple', key: 'runs' } as const, null, { shape: 'ripple-runs-v2' })

const PANE = 'ripple'
const OPEN_KEY = 'isOpen'
const WAVE_FRAMES = 33
const WAVE_MS = 120
const GREP_DELAY_MS = 300
const MAIN = 'main'
const EDIT_TOOLS = new Set(['Edit', 'Write'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

let waveTicker: { cancel: () => void } | null = null
const roots = new Map<string, string | null>()

const parent = (path: string) => path.replace(/\/[^/]*$/, '')

async function animateWave($: EngineInterface, id: string) {
  waveTicker?.cancel()
  await update($, wave, () => ({ id, frame: 0 }))
  let frame = 0
  const ticker = $.clock.every(WAVE_MS, () => {
    frame += 1
    if (frame >= WAVE_FRAMES) ticker.cancel()
    void update($, wave, () => (frame < WAVE_FRAMES ? { id, frame } : null)).catch(() => ticker.cancel())
  })
  waveTicker = ticker
}

async function projectOf($: EngineInterface, file: string) {
  const start = parent(toSlash(file))
  if (roots.has(start)) return roots.get(start) ?? null
  const session = toSlash(await $.session.root()).toLowerCase()
  const isAboveSession = (dir: string) => session.startsWith(`${dir.toLowerCase()}/`)
  let found: string | null = null
  for (let dir = start, depth = 0; depth < 8 && dir.includes('/') && !isAboveSession(dir); depth++, dir = parent(dir)) {
    if (await $.fs.exists(`${dir}/.git`)) {
      found = dir
      break
    }
  }
  const isInsideSession = start.toLowerCase().startsWith(`${session}/`)
  const root = found ?? (isInsideSession && !isAboveSession(parent(start)) ? parent(start) : null)
  roots.set(start, root)
  return root
}

async function dependentsOf($: EngineInterface, root: string, file: string) {
  const name = toSlash(file).split('/').pop() ?? ''
  const base = name.replace(/\.[^.]+$/, '')
  if (base.length < 3) return []
  const found = await $.tool.call({ tool: 'Grep', pattern: `\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, path: root, glob: `*${name.slice(base.length)}`, output_mode: 'files_with_matches', head_limit: 9 })
  const files = ((found.result as { filenames?: unknown } | undefined)?.filenames ?? []) as unknown[]
  return files.filter((one): one is string => typeof one === 'string' && !toSlash(one).endsWith(`/${name}`)).slice(0, 8).map(one => relativeTo(root, one))
}

async function netDiff($: EngineInterface, root: string, file: string) {
  const git = (...args: string[]) => $.process.run(['git', ...args], { cwd: root }).catch(() => null)
  const diff = await git('diff', '--numstat', 'HEAD', '--', file)
  if (!diff || diff.exitCode !== 0) return null
  if (diff.stdout.trim()) {
    const [added, removed] = diff.stdout.trim().split('\t').map(Number)
    return Number.isFinite(added) && Number.isFinite(removed) ? { added: added ?? 0, removed: removed ?? 0, isNew: false } : null
  }
  const tracked = await git('ls-files', '--', file)
  if (!tracked || tracked.exitCode !== 0) return null
  if (tracked.stdout.trim()) return { added: 0, removed: 0, isNew: false }
  const content = await $.fs.read(file).catch(() => null)
  if (typeof content !== 'string') return null
  return { added: content.split('\n').length - (content.endsWith('\n') ? 1 : 0), removed: 0, isNew: true }
}

async function labelOf($: EngineInterface, agent: string) {
  if (agent === MAIN) return 'Claude'
  const running = await $.agent.list().catch(() => [])
  return `agent: ${running.find(one => one.id === agent)?.description ?? agent.slice(0, 8)}`
}

async function track($: EngineInterface, id: string, file: string, output: unknown, agent: string) {
  if (!(await read($, isOpen))) return
  const root = await projectOf($, file)
  const entry: Ripple = {
    id,
    agent,
    label: await labelOf($, agent),
    path: toSlash(file),
    file: relativeTo(root, file),
    ...editStats(output),
    isGone: false,
    times: 1,
    dependents: root ? null : [],
  }
  const net = root ? await netDiff($, root, file) : null
  await update($, edits, list => {
    const before = list.find(one => one.agent === agent && one.path === entry.path)
    const summed = before
      ? { ...entry, added: before.added + entry.added, removed: before.removed + entry.removed, isNew: before.isNew || entry.isNew, times: before.times + 1 }
      : entry
    return [{ ...summed, ...net }, ...list.filter(one => one !== before)]
  })
  if (!root) return
  await $.clock.sleep(GREP_DELAY_MS)
  const isLatest = (await read($, edits)).find(one => one.agent === agent)?.id === id
  const dependents = isLatest ? await dependentsOf($, root, file) : []
  await update($, edits, list => list.map(one => (one.id === id ? { ...one, dependents } : one)))
  if (dependents.length > 0) await animateWave($, id)
}

function sections(list: Ripple[]) {
  const groups = new Map<string, Ripple[]>()
  for (const one of list) groups.set(one.agent, [...(groups.get(one.agent) ?? []), one])
  return [...groups.entries()]
    .sort(([a], [b]) => Number(b === MAIN) - Number(a === MAIN))
    .flatMap(([, [latest, ...older]]) => (latest ? [{ latest, older }] : []))
}

type ShellOutput = {
  stdout?: string
  stderr?: string
  bashEditDiff?: { files: { filePath: string; hunks: unknown[]; created?: true; deleted?: true }[]; moreFiles?: number }
}

const collapsible = (tool: string, file: unknown, isBroken: boolean): file is string =>
  EDIT_TOOLS.has(tool) && !isBroken && typeof file === 'string' && !isSensitive(file)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ripple', description: 'Show the files Claude and its agents edit, and the files that use them' }).catch(() => undefined)
    const wasOpen = (await read($, isOpen)) || (await $.store.get(OPEN_KEY).catch(() => undefined)) === true
    if (wasOpen) {
      await update($, isOpen, () => true)
      void $.ui.open({ id: PANE, title: 'Ripple' }).catch(() => undefined)
    }
    return next(e)
  })

  on('command.run', { command: 'ripple' }, async $ => {
    await update($, isOpen, () => true)
    await $.store.set(OPEN_KEY, true)
    await $.ui.open({ id: PANE, title: 'Ripple' })
    return { text: 'Ripple opened: the next edits show their dependents.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'unload') {
      await update($, isOpen, () => false)
      await $.store.set(OPEN_KEY, false)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if ((await read($, last))[MAIN]) await update($, last, all => ({ ...all, [MAIN]: null }))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const agent = e.agentId ?? MAIN
    const id = e.tool_use_id
    const file = 'file_path' in e ? e.file_path : undefined
    const joins = collapsible(e.tool, file, false)
    const path = joins ? toSlash(file) : ''
    const before = (await read($, last))[agent] ?? null
    const continues = joins && before !== null && before.file === path
    const runId = continues ? before.run : id
    let previous: Run | null = null
    if (joins) {
      await update($, memberOf(fold, { requestId: id }), () => ({ run: runId }))
      previous = continues ? await read($, memberOf(runs, { requestId: runId })) : null
      await update($, memberOf(runs, { requestId: runId }), () =>
        previous ? { head: id, times: previous.times + 1, added: previous.added, removed: previous.removed } : { head: id, times: 1, added: 0, removed: 0 },
      )
    }
    let stats: { added: number; removed: number } | null = null
    try {
      const ran = await next(e)
      const isDenied = 'deny' in ran && ran.deny
      if (joins && !isDenied && !ran.isError) stats = editStats(ran.result)
      if (isDenied) return ran
      if (EDIT_TOOLS.has(e.tool) && typeof file === 'string' && !ran.isError && !isHousekeeping(file)) {
        $.clock.after(0, () => void track($, id, file, ran.result, agent).catch(() => undefined))
      }
      const command = 'command' in e ? e.command : undefined
      if (SHELL_TOOLS.has(e.tool) && typeof command === 'string' && !ran.isError && isRemoval(command)) {
        const list = await read($, edits)
        const exists = await Promise.all(list.map(one => (one.isGone ? true : $.fs.exists(one.path))))
        const missing = new Set(list.filter((_, k) => !exists[k]).map(one => one.id))
        if (missing.size > 0) await update($, edits, current => current.map(one => (missing.has(one.id) ? { ...one, isGone: true } : one)))
      }
      return ran
    } finally {
      const done = stats
      if (joins) {
        await update($, memberOf(runs, { requestId: runId }), run =>
          done && run ? { ...run, added: run.added + done.added, removed: run.removed + done.removed } : previous,
        )
      }
      const after: Last | null = done ? { run: runId, file: path } : null
      if (after || before) await update($, last, all => ({ ...all, [agent]: after }))
    }
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, input, output, isRunning, isErrored, isInterrupted } = e.props
    const file = (input as { file_path?: unknown } | null)?.file_path
    if (!collapsible(tool, file, isErrored || isInterrupted)) return next(e)
    const member = await read($, memberOf(fold, { requestId: e.props.tool_use_id }))
    const run = member ? await read($, memberOf(runs, { requestId: member.run })) : null
    const { Box, Text } = $.ui.resolve(e)
    if (member ? run?.head !== e.props.tool_use_id : isRunning || output == null) return <Box />
    const times = run?.times ?? 1
    const stats = run && times > 1 ? run : editStats(output)
    const isPending = isRunning && times === 1
    const path = shortPath(file)
    const cut = path.lastIndexOf('/') + 1
    return (
      <Text>
        <Text color={isPending ? undefined : editColor(stats)} dimColor={isPending}>● </Text>
        <Text dimColor>{`${tool}  ${path.slice(0, cut)}`}</Text>
        <Text bold={!isPending} dimColor={isPending}>{path.slice(cut)}</Text>
        {!isPending && <Text color={ADDED}>{`  +${stats.added}`}</Text>}
        {!isPending && <Text color={REMOVED}>{` -${stats.removed}`}</Text>}
        {times > 1 && <Text bold>{` x${times}`}</Text>}
        {isPending && <Text dimColor>  …</Text>}
      </Text>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const file = (e.props.output as { filePath?: unknown } | null)?.filePath
    const { Box, Text } = $.ui.resolve(e)
    if (collapsible(e.props.tool, file, e.props.isErrored)) return <Box />
    const shell = e.props.tool === 'Bash' && !e.props.isErrored ? (e.props.output as ShellOutput | null) : null
    const changed = shell?.bashEditDiff?.files ?? []
    if (!shell || changed.length === 0 || changed.some(one => isSensitive(one.filePath))) return next(e)
    const { bashEditDiff, ...rest } = shell
    const printed = `${rest.stdout ?? ''}${rest.stderr ?? ''}`.trim() ? await next({ ...e, props: { ...e.props, output: rest } }) : null
    const more = bashEditDiff?.moreFiles ?? 0
    return (
      <Box flexDirection="column">
        {printed}
        {changed.map((one, k) => {
          const stats = editStats({ type: one.created ? 'create' : 'update', structuredPatch: one.hunks })
          const path = shortPath(one.filePath)
          const cut = path.lastIndexOf('/') + 1
          return (
            <Text key={one.filePath}>
              <Text dimColor>{k === 0 && !printed ? '  ⎿  ' : '     '}</Text>
              <Text color={editColor({ ...stats, isGone: one.deleted })}>● </Text>
              <Text dimColor>{path.slice(0, cut)}</Text>
              <Text bold>{path.slice(cut)}</Text>
              <Text color={ADDED}>{`  +${stats.added}`}</Text>
              <Text color={REMOVED}>{` -${stats.removed}`}</Text>
            </Text>
          )
        })}
        {more > 0 && <Text dimColor>{`     +${more} more files`}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isActive || e.props.isExpanded) return next(e)
    const found = foundIn(e.props.calls)
    if (!found) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text>
        <Text color="green">● </Text>
        <Text>Found it: </Text>
        <Text color="yellow">{found}</Text>
        <Text dimColor>  ({e.props.calls.length} searches and reads, ctrl+o to expand)</Text>
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [list, current] = await Promise.all([read($, edits), read($, wave)])
    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text>No edits since this pane opened.</Text>
          <Text dimColor>Each file Claude or an agent edits shows up here with its +/- lines, then the files that use it.</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {sections(list).map(({ latest, older }) => {
          const frame = current?.id === latest.id ? current.frame : WAVE_FRAMES
          const reached = (latest.dependents ?? []).filter((_, k) => frame >= k * 3)
          const edited = new Map([latest, ...older].map((one, rank) => [one.file, { one, rank }]))
          const usedName = latest.file.split('/').pop() ?? latest.file
          return (
            <Box key={`section-${latest.agent}`} flexDirection="column" marginBottom={1}>
              <Text bold color="cyan">{latest.label}</Text>
              {treeLines([...edited.keys(), ...reached]).map(line => {
                const indent = '  '.repeat(line.depth)
                const key = `${latest.agent}-${line.path ?? `dir-${line.depth}-${line.name}`}`
                if (!line.path) return <Text key={key} dimColor>{`${indent}${line.name}`}</Text>
                const edit = edited.get(line.path)
                if (edit) {
                  const { isGone } = edit.one
                  return (
                    <Text key={key}>
                      <Text color={editColor(edit.one)} bold={edit.rank === 0 && !isGone}>{`${indent}${line.name}`}</Text>
                      <Text color={isGone ? 'gray' : ADDED}> +{edit.one.added}</Text>
                      <Text color={isGone ? 'gray' : REMOVED}> -{edit.one.removed}</Text>
                      {edit.one.times > 1 && <Text bold={!isGone} color={isGone ? 'gray' : undefined}> x{edit.one.times}</Text>}
                    </Text>
                  )
                }
                const isLit = frame < reached.indexOf(line.path) * 3 + 12
                return (
                  <Text key={key} color={isLit ? 'yellow' : undefined} dimColor={!isLit}>
                    {`${indent}${line.name}${isLit ? `  ~ uses ${usedName}` : ''}`}
                  </Text>
                )
              })}
              {latest.dependents === null && <Text dimColor>looking for who uses it...</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
