type EditOutput = { type?: unknown; content?: unknown; structuredPatch?: unknown }

const SENSITIVE =
  /(^|\/)(\.git[^/]*|\.env[^/]*|\.npmrc|\.mcp\.json|\.ssh|\.github|\.husky|\.claude|\.codex|CLAUDE\.md|AGENTS\.md|settings[^/]*\.json|hooks\.json|[^/]*\.(pem|key)|id_(rsa|ed25519)[^/]*)(\/|$)/i

export const toSlash = (path: string) => path.replaceAll('\\', '/')

export const isSensitive = (path: string) => SENSITIVE.test(toSlash(path))

export const shortPath = (path: string) => toSlash(path).split('/').slice(-2).join('/')

const stats = new WeakMap<object, { added: number; removed: number; isNew: boolean }>()

export function editStats(output: unknown) {
  if (typeof output !== 'object' || output === null) return { added: 0, removed: 0, isNew: false }
  const known = stats.get(output)
  if (known) return known
  const { type, content, structuredPatch } = output as EditOutput
  let added = 0
  let removed = 0
  for (const hunk of Array.isArray(structuredPatch) ? structuredPatch : []) {
    for (const line of ((hunk as { lines?: unknown } | null)?.lines as unknown[] | undefined) ?? []) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  if (added + removed === 0 && type === 'create' && typeof content === 'string' && content) added = content.split('\n').length
  const counted = { added, removed, isNew: type === 'create' }
  stats.set(output, counted)
  return counted
}

const hueToHex = (hue: number) =>
  `#${[0, 8, 4]
    .map(n => {
      const k = (n + hue / 30) % 12
      return Math.round(255 * (0.575 - 0.26 * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
        .toString(16)
        .padStart(2, '0')
    })
    .join('')}`

export function editColor(edit: { added: number; removed: number; isNew?: boolean; isGone?: boolean }) {
  if (edit.isGone) return 'gray'
  const total = edit.added + edit.removed
  return hueToHex(edit.isNew ? 120 : total === 0 ? 60 : (edit.added / total) * 120)
}

const REMOVE = /(?:^|[;&|(]\s*)(?:git\s+rm|rm|del|Remove-Item)\s([^;&|)]*)/gi

const comparable = (path: string) => toSlash(path).toLowerCase().replace(/^\/([a-z])\//, '$1:/').replace(/\/+$/, '')

export function removedPaths(command: string) {
  return [...command.matchAll(REMOVE)].flatMap(([, args = '']) =>
    args
      .split(/\s+/)
      .filter(arg => arg && !arg.startsWith('-'))
      .map(arg => comparable(arg.replace(/^['"]|['"]$/g, '').replace(/^\.\//, ''))),
  )
}

export function isRemovedBy(path: string, removed: readonly string[]) {
  const target = `/${comparable(path)}`
  return removed.some(arg => target.endsWith(`/${arg}`) || target.includes(`/${arg}/`))
}

type GroupCall = { tool: string; isErrored: boolean; output?: unknown }

const locations = new WeakMap<readonly GroupCall[], string | null>()

export function foundIn(calls: readonly GroupCall[]) {
  if (!locations.has(calls)) locations.set(calls, locate(calls))
  return locations.get(calls) ?? null
}

function locate(calls: readonly GroupCall[]) {
  for (const call of calls.toReversed()) {
    if (call.tool !== 'Grep' || call.isErrored) continue
    const output = call.output as { content?: unknown; filenames?: unknown } | null
    if (typeof output?.content === 'string') {
      const hit = /^(.+?):(\d+)[:-]/m.exec(output.content)
      if (hit?.[1] && hit[2]) return `${shortPath(hit[1])}:${hit[2]}`
    }
    if (Array.isArray(output?.filenames) && output.filenames.length === 1 && typeof output.filenames[0] === 'string') {
      return shortPath(output.filenames[0])
    }
  }
  return null
}

export type TreeLine = { depth: number; name: string; path: string | null }

export function treeLines(paths: readonly string[]) {
  const lines: TreeLine[] = []
  const dirs = new Set<string>()
  for (const path of [...new Set(paths)].sort()) {
    const parts = path.split('/')
    parts.slice(0, -1).forEach((dir, depth) => {
      const key = parts.slice(0, depth + 1).join('/')
      if (dirs.has(key)) return
      dirs.add(key)
      lines.push({ depth, name: `${dir}/`, path: null })
    })
    lines.push({ depth: parts.length - 1, name: parts.at(-1) ?? path, path })
  }
  return lines
}

export function relativeTo(root: string | null, path: string) {
  const slashed = toSlash(path)
  return root && slashed.toLowerCase().startsWith(`${toSlash(root).toLowerCase()}/`) ? slashed.slice(root.length + 1) : slashed.split('/').slice(-3).join('/')
}
