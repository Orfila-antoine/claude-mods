const segments = (command: string) => command.split(/&&|\|\||;|\|/).map(part => part.trim())

export const isPush = (command: string) => segments(command).some(part => /^git\s+push\b/.test(part))

export function nextStepOf(answer: string) {
  const found = answer
    .split('\n')
    .map(line => line.replace(/[*_`]/g, '').trim())
    .findLast(line => /^next\s*:/i.test(line))
  if (!found) return null
  const step = found.replace(/^next\s*:\s*/i, '')
  return step.length > 70 ? `${step.slice(0, 67)}...` : step || null
}

export function pushLabel(text: string) {
  const range = /\b([0-9a-f]{7,})\.\.([0-9a-f]{7,})\s+(\S+)\s+->\s+(\S+)/.exec(text)
  if (range) return `pushed ${range[2]?.slice(0, 7)} -> ${range[4]}`
  const created = /\[new branch\]\s+(\S+)\s+->\s+(\S+)/.exec(text)
  return created ? `pushed new branch ${created[2]}` : 'pushed'
}

export function isoWeek(ms: number) {
  const date = new Date(ms)
  const day = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - day + 3)
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return date.getUTCFullYear() * 100 + week
}

export function weeksInARow(weeks: number[], now: number) {
  const seen = new Set(weeks)
  let count = 0
  let cursor = now
  while (seen.has(isoWeek(cursor))) {
    count += 1
    cursor -= 7 * 86400000
  }
  return count
}

type Bead = { title?: string; status?: string; priority?: number; updated_at?: string; issue_type?: string }

const beadsOf = (jsonl: string) =>
  jsonl.split('\n').flatMap(line => {
    try {
      return line ? [JSON.parse(line) as Bead] : []
    } catch {
      return []
    }
  })

export function startLine(jsonl: string) {
  const beads = beadsOf(jsonl).filter(bead => typeof bead.title === 'string')
  const doing = beads.filter(bead => bead.status === 'in_progress').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0]
  if (doing?.title) return `Resume: ${doing.title.slice(0, 70)}`
  const ready = beads.filter(bead => bead.status === 'open' && bead.issue_type !== 'epic').sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9))[0]
  return ready?.title ? `Start: ${ready.title.slice(0, 70)}` : null
}
