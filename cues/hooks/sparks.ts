const DEFAULT = 0x01000000
const GREEN = 0x50fa7b
const COLORS = [0xf1fa8c, 0xffa500, 0x3a3a3a]
const LIFE = 12
const RAYS = [0.1, 0.9, 0.3, 0.7, 0.5, 0.2, 0.8, 0.4].map((jitter, i) => ({ angle: (i / 8) * Math.PI * 2 + jitter * 0.4, speed: 0.6 + jitter * 0.9 }))

export function sparks(columns: number, rows: number, frame: number, label: string) {
  const cells = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) cells.set([32, DEFAULT, DEFAULT], i * 3)
  const put = (x: number, y: number, ch: string, fg: number) => {
    const cx = Math.round(x)
    const cy = Math.round(y)
    if (cx < 0 || cy < 0 || cx >= columns || cy >= rows) return
    cells.set([ch.codePointAt(0) ?? 32, fg, DEFAULT], (cy * columns + cx) * 3)
  }
  const cx = Math.floor(columns / 2)
  const cy = Math.floor(rows / 2)
  if (frame <= LIFE) {
    const color = COLORS[Math.min(2, Math.floor((frame / LIFE) * 3))] ?? DEFAULT
    const ch = frame < 5 ? '*' : frame < 9 ? '+' : '.'
    for (const { angle, speed } of RAYS) put(cx + Math.cos(angle) * speed * frame * 1.8, cy + Math.sin(angle) * speed * frame * 0.3, ch, color)
  }
  if (frame > 4) [...label].forEach((ch, i) => put(cx - Math.floor(label.length / 2) + i, cy, ch, GREEN))
  return (new Uint8Array(cells.buffer) as Uint8Array & { toBase64: () => string }).toBase64()
}
