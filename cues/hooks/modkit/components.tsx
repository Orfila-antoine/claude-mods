import type { ElementTable } from 'claude-code'

import { DEFAULT, put, text } from './grid'
import type { Grid } from './grid'

const EIGHTHS = ' ▏▎▍▌▋▊▉█'
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

export function bar(g: Grid, x: number, y: number, width: number, ratio: number, fg = DEFAULT, bg = DEFAULT) {
  const filled = Math.max(0, Math.min(1, ratio)) * width
  for (let k = 0; k < width; k++) {
    const part = Math.max(0, Math.min(1, filled - k))
    put(g, x + k, y, EIGHTHS[Math.round(part * 8)] ?? ' ', fg, bg)
  }
}

export function spinner(g: Grid, x: number, y: number, ms: number, fg = DEFAULT, periodMs = 80) {
  put(g, x, y, SPINNER[Math.floor(ms / periodMs) % SPINNER.length] ?? ' ', fg)
}

export function label(g: Grid, x: number, y: number, value: string, fg = DEFAULT, bg = DEFAULT) {
  text(g, x, y, value.slice(0, Math.max(0, g.columns - x)), fg, bg)
}

export type Action = { key: string; label: string; hotkey?: string; onPress: () => unknown }

export function actions(ui: ElementTable<'terminal'>, list: readonly Action[]) {
  const { Box, Button } = ui
  return (
    <Box>
      {list.map(action => (
        <Button key={action.key} hotkey={action.hotkey} label={action.label} onPress={action.onPress} />
      ))}
    </Box>
  )
}
