export type Kind = 'notification' | 'command' | 'task' | 'question' | 'chat'
export type Features = { chars: number; kind: Kind; command: string | null; broad: boolean; mentions: number }
export type TurnRecord = {
  f: Features
  project?: string
  model?: string
  effort?: string
  agent?: string
  durS: number
  endedAt: number
  predP50?: number
  tailS?: number
}
export type Unit = Omit<TurnRecord, 'durS' | 'endedAt' | 'predP50' | 'tailS'>
export type Point = [number, number]
export type Estimate = { p50Raw: number; similar: number; sample: Point[] }
export type Remaining = { p10: number; p50: number; p90: number; overdue: boolean }

const Z9 = [-1.5932, -0.9674, -0.5894, -0.2822, 0, 0.2822, 0.5894, 0.9674, 1.5932]
const MAX_SAMPLE_POINTS = 160
const HALF_LIFE_DAYS = 45
const PRIOR_STRENGTH = 3
const BANDWIDTH = 0.3
export const MIN_SIMILAR = 3

const word = (alternatives: string) => new RegExp(`(?<!\\p{L})(?:${alternatives})(?!\\p{L})`, 'iu')
const NOTIFICATION = /^\s*<(task-notification|system-reminder|scheduled-task|agent-message|cross-session)/i
const SLASH = /^\s*\/([A-Za-z0-9][\w:.-]*)/
const MENTION = /(?:^|\s)@[\w./~-]+/g
const QUESTION_START = new RegExp(
  '^\\s*(?:what|why|how|when|where|which|who|is|are|can|could|does|do|should|would|explain|tell me|' +
    "qu'est-ce|pourquoi|comment|quand|où|quel|quelle|quels|quelles|qui|est-ce|existe|peux|peut|dois|explique)(?!\\p{L})",
  'iu',
)
const TASK_WORDS = word(
  'implement|build|create|add|write|refactor|fix|migrate|rename|update|upgrade|port|convert|delete|remove|' +
    'set up|setup|configure|deploy|test|debug|optimi[sz]e|rewrite|run|install|review|analy[sz]e|investigate|' +
    'generate|make|use|move|clean up|tidy|' +
    'implémente|ajoute|crée|écris|corrige|fixe|refactore|migre|renomme|mets à jour|supprime|retire|configure|' +
    'déploie|teste|débogue|optimise|réécris|lance|installe|relis|analyse|enquête|génère|fais|déplace|nettoie|' +
    'vérifie|lis|intègre|propose|rédige|mets',
)
const BIG_WORDS = word(
  "all|every|entire|whole|across|codebase|repo|repository|project-wide|tout|tous|toutes|chaque|entier|entière|l'ensemble",
)
const COMMAND_NAME = /^[a-z0-9][a-z0-9:_-]{0,63}$/

export function extract(prompt: string): Features {
  const stripped = prompt.trim()
  const slash = SLASH.exec(stripped)
  const kind: Kind = NOTIFICATION.test(stripped)
    ? 'notification'
    : slash
      ? 'command'
      : TASK_WORDS.test(stripped)
        ? 'task'
        : stripped.endsWith('?') || QUESTION_START.test(stripped)
          ? 'question'
          : stripped.length > 280
            ? 'task'
            : 'chat'
  const name = slash?.[1]
  const command = name === undefined ? null : COMMAND_NAME.test(name) ? name : '#other'

  return {
    chars: prompt.length,
    kind,
    command,
    broad: BIG_WORDS.test(stripped),
    mentions: (prompt.match(MENTION) ?? []).length,
  }
}

export function weightedQuantile(sample: readonly Point[], q: number): number | null {
  const points = sample.filter(([v, w]) => w > 0 && !Number.isNaN(v)).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (points.length === 0) return null
  if (points.length === 1) return points[0]![0]
  const target = q * points.reduce((sum, [, w]) => sum + w, 0)
  let cumulative = 0
  let previousMid: number | null = null
  let previousValue = 0
  for (const [value, weight] of points) {
    const mid = cumulative + weight / 2
    if (mid >= target) {
      if (previousMid === null) return value
      const span = mid - previousMid
      const frac = span <= 0 ? 0 : (target - previousMid) / span
      return previousValue + frac * (value - previousValue)
    }
    previousMid = mid
    previousValue = value
    cumulative += weight
  }
  return points[points.length - 1]![0]
}

export function effectiveN(weights: readonly number[]): number {
  const ws = weights.filter(w => w > 0)
  const sum = ws.reduce((a, b) => a + b, 0)
  const squares = ws.reduce((a, b) => a + b * b, 0)
  return squares ? (sum * sum) / squares : 0
}

const PRIORS: Record<Kind, [number, number, number]> = {
  notification: [25, 600, 0.4],
  question: [35, 400, 0.6],
  command: [120, 400, 0.5],
  task: [120, 300, 0.7],
  chat: [40, 300, 0.6],
}

function priorMedian(f: Features): number {
  const [base, scale, power] = PRIORS[f.kind]
  let median = base * (1 + Math.max(0, f.chars) / scale) ** power
  if (f.broad) median *= 1.6
  median *= 1 + 0.15 * Math.min(f.mentions, 6)
  return Math.min(Math.max(median, 10), 3600)
}

function lengthKernel(a: number, b: number): number {
  const distance = (Math.log1p(Math.max(a, 0)) - Math.log1p(Math.max(b, 0))) / 0.9
  return Math.exp(-0.5 * distance * distance)
}

function similarity(current: Unit, past: TurnRecord): number {
  const cf = current.f
  const pf = past.f
  let weight = lengthKernel(cf.chars, pf.chars)
  if (cf.command) weight *= cf.command === pf.command ? 4 : 0.25
  else if (pf.command) weight *= 0.4
  weight *= cf.kind === pf.kind ? 1.5 : 0.6
  if (cf.broad !== pf.broad) weight *= 0.7
  if (current.project && past.project) weight *= current.project === past.project ? 1.8 : 1
  if (current.model && past.model) weight *= current.model === past.model ? 1.3 : 0.75
  if (current.effort && past.effort) weight *= current.effort === past.effort ? 1.3 : 0.75
  return weight
}

function recency(ageS: number): number {
  return ageS <= 0 ? 1 : 0.5 ** (ageS / (HALF_LIFE_DAYS * 86400))
}

export const isUserTurn = (record: TurnRecord) => record.agent === undefined && record.f.kind !== 'notification'

export function isReliable(history: readonly TurnRecord[]): boolean {
  const judged = history.filter(r => isUserTurn(r) && r.predP50 !== undefined && r.predP50 > 0).slice(-50)
  if (judged.length < 10) return false
  const close = judged.filter(r => {
    const ratio = r.durS / (r.predP50 as number)
    return ratio >= 0.5 && ratio <= 2
  }).length
  return close / judged.length >= 0.7
}

export function calibration(history: readonly TurnRecord[], nowS: number): number {
  const residuals: Point[] = history
    .filter(r => r.predP50 !== undefined && r.predP50 > 0)
    .map(r => [Math.log(r.durS / (r.predP50 as number)), recency(nowS - r.endedAt)])
  if (effectiveN(residuals.map(([, w]) => w)) < 5) return 1
  return Math.min(3, Math.max(1 / 3, Math.exp(weightedQuantile(residuals, 0.5) ?? 0)))
}

export function estimate(current: Unit, history: readonly TurnRecord[], nowS: number): Estimate {
  let weighted: Point[] = []
  const alike: number[] = []
  for (const record of history) {
    const weight = similarity(current, record) * recency(nowS - record.endedAt)
    if (weight <= 1e-6) continue
    weighted.push([record.durS, weight])
    if (record.f.kind === current.f.kind && record.f.command === current.f.command) alike.push(weight)
  }
  const similar = effectiveN(alike)
  const total = weighted.reduce((sum, [, w]) => sum + w, 0)
  if (total > 0) weighted = weighted.map(([d, w]) => [d, (w * similar) / total])
  const priorWeight = PRIOR_STRENGTH * Math.max(0.1, 1 - similar / 30)
  const median = priorMedian(current.f)
  const prior: Point[] = Z9.map(z => [median * Math.exp(z), priorWeight / Z9.length])
  const raw = [...weighted, ...prior].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, MAX_SAMPLE_POINTS)
  const bias = calibration(history, nowS)

  return {
    p50Raw: weightedQuantile(raw, 0.5) ?? 0,
    similar,
    sample: raw.map(([d, w]) => [d * bias, w]),
  }
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return x >= 0 ? y : -y
}

function survival(sample: readonly Point[], t: number): number {
  if (t <= 0) return sample.reduce((sum, [, w]) => sum + w, 0)
  const lt = Math.log(t)
  return sample.reduce((sum, [d, w]) => sum + w * 0.5 * (1 - erf((lt - Math.log(d)) / (BANDWIDTH * Math.SQRT2))), 0)
}

function solve(cdf: (r: number) => number, p: number, upper: number): number {
  let lo = 0
  let hi = upper
  while (cdf(hi) < p && hi < 1e7) hi *= 2
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (cdf(mid) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export type Running = { sample: readonly Point[]; elapsedS: number }

function remainingCdf({ sample, elapsedS }: Running): ((r: number) => number) | null {
  const base = survival(sample, elapsedS)
  if (base <= 1e-9 * Math.max(1, survival(sample, 0))) return null
  return r => 1 - survival(sample, elapsedS + r) / base
}

function upperOf(sample: readonly Point[], elapsedS: number): number {
  return Math.max(60, elapsedS, ...sample.map(([d]) => d)) * 4
}

export function remaining(sample: readonly Point[], elapsedS: number): Remaining {
  const cdf = remainingCdf({ sample, elapsedS })
  if (cdf === null) {
    const base = Math.max(elapsedS, 1)
    return { p10: Math.max(5, 0.1 * base), p50: Math.max(15, 0.35 * base), p90: Math.max(45, base), overdue: true }
  }
  const upper = upperOf(sample, elapsedS)
  const overdue = survival(sample, elapsedS) / Math.max(survival(sample, 0), 1e-9) < 0.1

  return { p10: solve(cdf, 0.1, upper), p50: solve(cdf, 0.5, upper), p90: solve(cdf, 0.9, upper), overdue }
}

export function remainingOfMax(units: readonly Running[]): Remaining | null {
  const cdfs = units.map(remainingCdf)
  if (cdfs.length === 0 || cdfs.some(c => c === null)) return null
  const all = cdfs as ((r: number) => number)[]
  const cdf = (r: number) => all.reduce((product, c) => product * c(r), 1)
  const upper = Math.max(...units.map(u => upperOf(u.sample, u.elapsedS)))

  return { p10: solve(cdf, 0.1, upper), p50: solve(cdf, 0.5, upper), p90: solve(cdf, 0.9, upper), overdue: false }
}

export function taskRemaining(durationsS: readonly number[], pending: number, currentElapsedS: number | null): number | null {
  if (durationsS.length === 0) return null
  const ema = durationsS.reduce((avg, d, i) => (i === 0 ? d : 0.3 * d + 0.7 * avg), 0)
  const current = currentElapsedS === null ? 0 : Math.max(0, ema - currentElapsedS)
  return ema * pending + current
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const WIDE = /\p{Emoji_Presentation}|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u

export function cells(text: string): number {
  let width = 0
  for (const char of text) width += WIDE.test(char) ? 2 : 1
  return width
}

export function hms(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

export type Bucket = 'short' | 'medium' | 'long' | 'very-long'

export function bucketOf(seconds: number): Bucket | null {
  if (seconds < 60) return null
  if (seconds < 300) return 'short'
  if (seconds < 1200) return 'medium'
  if (seconds < 3600) return 'long'
  return 'very-long'
}

const PRICES: [RegExp, [number, number, number]][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25]],
  [/fable|mythos/, [10, 50, 1]],
  [/opus-5-5/, [4, 20, 0.2]],
  [/opus/, [5, 25, 0.5]],
  [/sonnet-4/, [3, 15, 0.3]],
  [/sonnet/, [2, 10, 0.2]],
  [/haiku-5-5/, [0.1, 0.5, 0.01]],
  [/haiku/, [1, 5, 0.1]],
]

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function costOf(model: string, usage: Usage): number | null {
  const price = PRICES.find(([pattern]) => pattern.test(model))?.[1]
  if (!price) return null
  const [input, output, cacheRead] = price
  return (
    (usage.input_tokens * input +
      usage.output_tokens * output +
      usage.cache_read_input_tokens * cacheRead +
      usage.cache_creation_input_tokens * input * 1.25) /
    1e6
  )
}
