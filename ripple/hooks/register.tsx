import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ripple } from '../types'
import { editColor, editStats, foundIn, isRemovedBy, isSensitive, relativeTo, removedPaths, shortPath, toSlash, treeLines } from './logic'

const edits = atom({ plugin: 'ripple', key: 'edits' } as const, [], { shape: 'ripple-v2' })
const wave = atom({ plugin: 'ripple', key: 'wave' } as const, null)
const isOpen = atom({ plugin: 'ripple', key: 'isOpen' } as const, false)

const PANE = 'ripple'
const WAVE_FRAMES = 33
const WAVE_MS = 120
const GREP_DELAY_MS = 300
const MAIN = 'main'
const MAX_EDITS = 20
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
    dependents: root ? null : [],
  }
  await update($, edits, list => [entry, ...list].slice(0, MAX_EDITS))
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

const collapsible = (tool: string, file: unknown, isBroken: boolean): file is string =>
  EDIT_TOOLS.has(tool) && !isBroken && typeof file === 'string' && !isSensitive(file)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ripple', description: 'Show the files Claude and its agents edit, and the files that use them' }).catch(() => undefined)
    if (await read($, isOpen)) void $.ui.open({ id: PANE, title: 'Ripple' }).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'ripple' }, async $ => {
    await update($, isOpen, () => true)
    await $.ui.open({ id: PANE, title: 'Ripple' })
    return { text: 'Ripple opened: the next edits show their dependents.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'unload') await update($, isOpen, () => false)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ('deny' in ran && ran.deny) return ran
    const file = 'file_path' in e ? e.file_path : undefined
    if (EDIT_TOOLS.has(e.tool) && typeof file === 'string' && !ran.isError) {
      $.clock.after(0, () => void track($, e.tool_use_id, file, ran.result, e.agentId ?? MAIN).catch(() => undefined))
    }
    const command = 'command' in e ? e.command : undefined
    if (SHELL_TOOLS.has(e.tool) && typeof command === 'string' && !ran.isError) {
      const gone = removedPaths(command)
      if (gone.length > 0) await update($, edits, list => list.map(one => (isRemovedBy(one.path, gone) ? { ...one, isGone: true } : one)))
    }
    return ran
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, input, output, isRunning, isErrored, isInterrupted } = e.props
    const file = (input as { file_path?: unknown } | null)?.file_path
    if (!collapsible(tool, file, isRunning || isErrored || isInterrupted)) return next(e)
    const { added, removed } = editStats(output)
    const { Text } = $.ui.resolve(e)
    return (
      <Text>
        <Text color="green">● </Text>
        <Text>{tool}({shortPath(file)})</Text>
        <Text color="green"> +{added}</Text>
        <Text color="red"> -{removed}</Text>
      </Text>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const file = (e.props.output as { filePath?: unknown } | null)?.filePath
    if (!collapsible(e.props.tool, file, e.props.isErrored)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
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
    if (list.length === 0) return <Text dimColor>Edit a file: its dependents show here, one section per agent.</Text>
    return (
      <Box flexDirection="column">
        {sections(list).map(({ latest, older }) => {
          const frame = current?.id === latest.id ? current.frame : WAVE_FRAMES
          const reached = (latest.dependents ?? []).filter((_, k) => frame >= k * 3)
          const edited = new Map([latest, ...older.slice(0, 3)].map((one, rank) => [one.file, { one, rank }] as const).reverse())
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
                      <Text color={isGone ? 'gray' : 'green'}> +{edit.one.added}</Text>
                      <Text color={isGone ? 'gray' : 'red'}> -{edit.one.removed}</Text>
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
