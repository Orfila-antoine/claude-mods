const DEFAULT = 0x01000000
const TEXT = 0xa0a0a0

export type Glyph = { x: number; y: number; ch: string }
export type Effect = (glyphs: readonly Glyph[], columns: number, rows: number, t: number) => Uint32Array

const NARROW = [
  [0x2010, 0x2027],
  [0x2190, 0x21ff],
  [0x2500, 0x25ff],
  [0x276f, 0x276f],
] as const

const printable = (ch: string) => {
  const code = ch.codePointAt(0) ?? 0
  if (ch.length !== 1 || code <= 0x20 || code === 0x7f) return false
  return code < 0x1100 || NARROW.some(([from, to]) => code >= from && code <= to)
}

type Row = { role: 'user' | 'assistant'; text: string; toolUses: readonly { tool: string; input: unknown }[]; toolResults?: readonly unknown[] }

const plain = (text: string) =>
  text
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '- ')
    .trim()

const targetOf = (input: unknown) => {
  const fields = (input ?? {}) as Record<string, unknown>
  const value = fields.file_path ?? fields.command ?? fields.pattern ?? fields.description ?? ''
  return String(value).split('\n')[0]?.split(/[\\/]/).slice(-2).join('/').slice(0, 60) ?? ''
}

const block = (mark: string, text: string) =>
  text
    .split('\n')
    .map((line, k) => (k === 0 ? `${mark} ${line}` : `  ${line}`))
    .join('\n')

export function screenText(rows: readonly Row[]) {
  return rows
    .flatMap(row => {
      if (row.role === 'user') return row.toolResults?.length || !row.text.trim() || row.text.trimStart().startsWith('<') ? [] : [block('❯', plain(row.text))]
      return [...(row.text.trim() ? [block('●', plain(row.text))] : []), ...row.toolUses.map(use => `● ${use.tool}(${targetOf(use.input)})`)]
    })
    .join('\n\n')
}

export function linesOf(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (!node || typeof node !== 'object') return []
  const element = node as { type?: unknown; props?: { flexDirection?: unknown; label?: unknown }; children?: unknown }
  const children = (Array.isArray(element.children) ? element.children : []).flatMap(child => (Array.isArray(child) ? child : [child]))
  const own = typeof element.props?.label === 'string' ? [`[${element.props.label}]`] : []
  if (element.type === 'Box' && element.props?.flexDirection === 'column') return [...own, ...children.flatMap(linesOf)]
  const joined = [...own, ...children.flatMap(child => linesOf(child))].join(' ').replace(/\s+/g, ' ').trim()
  return joined ? [joined] : []
}

export function placed(text: string, columns: number, top: number, left = 0): Glyph[] {
  return text
    .split('\n')
    .flatMap((line, k) => [...line.slice(0, columns - left)].flatMap((ch, x) => (printable(ch) ? [{ x: left + x, y: top + k, ch }] : [])))
}

export function glyphsOf(text: string, columns: number, rows: number): Glyph[] {
  const lines = text
    .split('\n')
    .flatMap(line => Array.from({ length: Math.max(1, Math.ceil(line.length / columns)) }, (_, k) => line.slice(k * columns, (k + 1) * columns)))
    .slice(-rows)
  const top = rows - lines.length
  return lines.flatMap((line, k) => [...line].flatMap((ch, x) => (printable(ch) ? [{ x, y: top + k, ch }] : [])))
}

const ease = (t: number) => t * t * (3 - 2 * t)
const clamp = (t: number) => Math.min(1, Math.max(0, t))
const noise = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}
const mix = (from: number, to: number, t: number) =>
  [16, 8, 0].reduce((color, shift) => {
    const a = (from >> shift) & 0xff
    const b = (to >> shift) & 0xff
    return color | (Math.round(a + (b - a) * t) << shift)
  }, 0)

function canvas(columns: number, rows: number) {
  const cells = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) cells.set([32, DEFAULT, DEFAULT], i * 3)
  const put = (x: number, y: number, ch: string, fg: number, bg = DEFAULT) => {
    const cx = Math.round(x)
    const cy = Math.round(y)
    if (cx < 0 || cy < 0 || cx >= columns || cy >= rows) return
    cells.set([ch.codePointAt(0) ?? 32, fg, bg], (cy * columns + cx) * 3)
  }
  const done = () => cells
  return { put, done }
}

export function encode(cells: Uint32Array, columns: number, from: number, count: number, width = columns) {
  const slice = new Uint32Array(width * count * 3)
  for (let row = 0; row < count; row++) slice.set(cells.subarray((from + row) * columns * 3, ((from + row) * columns + width) * 3), row * width * 3)
  return (new Uint8Array(slice.buffer) as Uint8Array & { toBase64: () => string }).toBase64()
}

const RIM = [0x8f6fd0, 0xd08770, 0xf0d070]

const blackhole: Effect = (glyphs, columns, rows, t) => {
  const { put, done } = canvas(columns, rows)
  const cx = (columns - 1) / 2
  const cy = (rows - 1) / 2
  const reach = Math.hypot(cx, cy * 2) || 1
  const horizon = 1 + 2.5 * Math.sin(Math.PI * Math.min(1, t * 1.1))
  for (let y = -3; y <= 3; y++) {
    for (let x = -6; x <= 6; x++) if (Math.hypot(x, y * 2) < horizon) put(cx + x, cy + y, ' ', DEFAULT, 0x2a1a40)
  }
  for (const glyph of glyphs) {
    const dx = glyph.x - cx
    const dy = (glyph.y - cy) * 2
    const r = Math.hypot(dx, dy)
    const pull = ease(clamp(t * 1.7 - (r / reach) * 0.7))
    const radius = r * (1 - pull)
    if (pull > 0 && radius < horizon + 0.5) continue
    const angle = Math.atan2(dy, dx) + pull * (3 + 6 / (radius + 2))
    const color = pull < 0.15 ? TEXT : (RIM[Math.min(RIM.length - 1, Math.floor(pull * RIM.length))] ?? TEXT)
    put(cx + Math.cos(angle) * radius, cy + (Math.sin(angle) * radius) / 2, pull > 0.6 ? '·' : glyph.ch, color)
  }
  return done()
}

const fall: Effect = (glyphs, columns, rows, t) => {
  const { put, done } = canvas(columns, rows)
  for (const glyph of glyphs) {
    const delay = (1 - glyph.y / rows) * 0.45 + noise(glyph.x, glyph.y) * 0.2
    const drop = clamp((t - delay) / (1 - delay))
    const y = glyph.y + drop * drop * rows * 1.4
    const x = glyph.x + (noise(glyph.y, glyph.x) - 0.5) * drop * 4
    put(x, y, glyph.ch, mix(TEXT, 0x505050, drop))
  }
  return done()
}

const ASH = [0xb08a6a, 0x8a6e5a, 0x5e4a3e]
const DUST = ['░', '·', '.', '˙']

const dust: Effect = (glyphs, columns, rows, t) => {
  const { put, done } = canvas(columns, rows)
  for (const glyph of glyphs) {
    const delay = (glyph.x / columns) * 0.4 + noise(glyph.x, glyph.y) * 0.15
    const life = clamp((t - delay) / 0.45)
    if (life >= 1) continue
    if (life <= 0) {
      put(glyph.x, glyph.y, glyph.ch, TEXT)
      continue
    }
    const drift = life * life * 14
    const x = glyph.x + drift * (1 + noise(glyph.y, glyph.x))
    const y = glyph.y - drift * 0.35 * noise(glyph.x + 1, glyph.y) + Math.sin(glyph.x + life * 6) * 0.6
    const ch = life < 0.15 ? glyph.ch : (DUST[Math.min(DUST.length - 1, Math.floor(life * DUST.length))] ?? '.')
    put(x, y, ch, ASH[Math.min(ASH.length - 1, Math.floor(life * ASH.length))] ?? TEXT)
  }
  return done()
}

const fade: Effect = (glyphs, columns, rows, t) => {
  const { put, done } = canvas(columns, rows)
  for (const glyph of glyphs) {
    const delay = (glyph.y / rows) * 0.45 + noise(glyph.x, glyph.y) * 0.1
    const dim = ease(clamp((t - delay) / 0.45))
    if (dim >= 1) continue
    put(glyph.x, glyph.y, dim > 0.7 ? '·' : glyph.ch, mix(TEXT, 0x181818, dim))
  }
  return done()
}

const WHITE = 0xffffff
const GLOW = 0x9fc4ff

const tv: Effect = (glyphs, columns, rows, t) => {
  const { put, done } = canvas(columns, rows)
  const cx = (columns - 1) / 2
  const cy = Math.floor((rows - 1) / 2)
  if (t < 0.45) {
    const squash = ease(t / 0.45)
    for (const glyph of glyphs) {
      const y = cy + (glyph.y - cy) * (1 - squash)
      put(glyph.x, y, squash > 0.85 ? '━' : glyph.ch, mix(TEXT, WHITE, squash))
    }
    return done()
  }
  if (t < 0.75) {
    const half = cx * (1 - ease((t - 0.45) / 0.3))
    for (let x = Math.ceil(cx - half); x <= cx + half; x++) put(x, cy, '━', Math.abs(x - cx) > half - 2 ? GLOW : WHITE)
    return done()
  }
  const fadeOut = (t - 0.75) / 0.22
  if (fadeOut < 1) put(cx, cy, fadeOut < 0.35 ? '●' : fadeOut < 0.7 ? '•' : '·', mix(WHITE, 0x303030, fadeOut))
  return done()
}

export const EFFECTS: Record<string, Effect> = { blackhole, fall, dust, fade, tv }
export const EFFECT_NAMES = Object.keys(EFFECTS)
