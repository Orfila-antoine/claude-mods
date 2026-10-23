export const DEFAULT = 0x01000000
export const BLANK = 32

export type Grid = { columns: number; rows: number; cells: Uint32Array }

const WIDE = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xd800, 0xdfff],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
] as const

export function isPrintable(code: number) {
  if (code <= 0x20 || code === 0x7f || code > 0xffff) return false
  return !WIDE.some(([from, to]) => code >= from && code <= to)
}

export function grid(columns: number, rows: number): Grid {
  const width = Math.max(1, Math.floor(columns))
  const height = Math.max(1, Math.floor(rows))
  const cells = new Uint32Array(width * height * 3)
  for (let i = 0; i < width * height; i++) cells.set([BLANK, DEFAULT, DEFAULT], i * 3)
  return { columns: width, rows: height, cells }
}

export function put(g: Grid, x: number, y: number, ch: string, fg = DEFAULT, bg = DEFAULT) {
  const cx = Math.round(x)
  const cy = Math.round(y)
  if (cx < 0 || cy < 0 || cx >= g.columns || cy >= g.rows) return
  const code = ch.codePointAt(0) ?? BLANK
  g.cells.set([isPrintable(code) ? code : code === BLANK ? BLANK : 0x3f, fg, bg], (cy * g.columns + cx) * 3)
}

export function text(g: Grid, x: number, y: number, value: string, fg = DEFAULT, bg = DEFAULT) {
  ;[...value].forEach((ch, k) => put(g, x + k, y, ch, fg, bg))
}

export function cell(g: Grid, x: number, y: number) {
  const at = (y * g.columns + x) * 3
  return { code: g.cells[at] ?? BLANK, fg: g.cells[at + 1] ?? DEFAULT, bg: g.cells[at + 2] ?? DEFAULT }
}

const isClear = (code: number, bg: number) => code === BLANK && bg === DEFAULT

export function composite(below: Grid, above: Grid): Grid {
  const out = grid(below.columns, below.rows)
  out.cells.set(below.cells)
  for (let y = 0; y < Math.min(below.rows, above.rows); y++) {
    for (let x = 0; x < Math.min(below.columns, above.columns); x++) {
      const { code, fg, bg } = cell(above, x, y)
      if (!isClear(code, bg)) out.cells.set([code, fg, bg], (y * out.columns + x) * 3)
    }
  }
  return out
}

export function mix(from: number, to: number, t: number) {
  return [16, 8, 0].reduce((color, shift) => {
    const a = (from >> shift) & 0xff
    const b = (to >> shift) & 0xff
    return color | (Math.round(a + (b - a) * t) << shift)
  }, 0)
}

export const FADE_TO = 0x000000
const DEFAULT_FG = 0xc0c0c0

export function fade(g: Grid, alpha: number, to = FADE_TO): Grid {
  if (alpha >= 1) return g
  const out = grid(g.columns, g.rows)
  if (alpha <= 0) return out
  for (let i = 0; i < g.columns * g.rows; i++) {
    const code = g.cells[i * 3] ?? BLANK
    const fg = g.cells[i * 3 + 1] ?? DEFAULT
    const bg = g.cells[i * 3 + 2] ?? DEFAULT
    out.cells.set([code, mix(to, fg === DEFAULT ? DEFAULT_FG : fg, alpha), bg === DEFAULT ? DEFAULT : mix(to, bg, alpha)], i * 3)
  }
  return out
}

export function reveal(g: Grid, alpha: number): Grid {
  if (alpha >= 1) return g
  const out = grid(g.columns, g.rows)
  const shown = Math.round(g.columns * Math.max(0, alpha))
  for (let y = 0; y < g.rows; y++) {
    const from = y * g.columns * 3
    out.cells.set(g.cells.subarray(from, from + shown * 3), from)
  }
  return out
}

export function resized(g: Grid, columns: number, rows: number): Grid {
  if (g.columns === columns && g.rows === rows) return g
  return composite(grid(columns, rows), g)
}

export function encode(g: Grid) {
  return (new Uint8Array(g.cells.buffer, g.cells.byteOffset, g.cells.byteLength) as Uint8Array & { toBase64: () => string }).toBase64()
}

export function decode(cells: string, columns: number) {
  const bytes = Uint8Array.from(atob(cells), ch => ch.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  const lines: string[] = []
  for (let i = 0; i < words.length / 3; i += columns) {
    lines.push(Array.from({ length: columns }, (_, k) => String.fromCodePoint(words[(i + k) * 3] ?? BLANK)).join(''))
  }
  return lines
}
