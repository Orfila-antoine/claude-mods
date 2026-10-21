import { grid, put } from './modkit'

const GREEN = 0x50fa7b
const COLORS = [0xf1fa8c, 0xffa500, 0x3a3a3a]
const LIFE = 12
const WIDTH = 60
const RAYS = [0.1, 0.9, 0.3, 0.7, 0.5, 0.2, 0.8, 0.4].map((jitter, i) => ({ angle: (i / 8) * Math.PI * 2 + jitter * 0.4, speed: 0.6 + jitter * 0.9 }))

export function sparks(columns: number, rows: number, frame: number, label: string) {
  const g = grid(columns, rows)
  const cx = Math.floor(Math.min(WIDTH, columns) / 2)
  const cy = Math.floor(rows / 2)
  if (frame <= LIFE) {
    const color = COLORS[Math.min(2, Math.floor((frame / LIFE) * 3))] ?? GREEN
    const ch = frame < 5 ? '*' : frame < 9 ? '+' : '.'
    for (const { angle, speed } of RAYS) put(g, cx + Math.cos(angle) * speed * frame * 1.8, cy + Math.sin(angle) * speed * frame * 0.3, ch, color)
  }
  if (frame > 4) [...label].forEach((ch, i) => put(g, cx - Math.floor(label.length / 2) + i, cy, ch, GREEN))
  return g
}
