import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { EFFECT_NAMES, EFFECTS, encode, glyphsOf, linesOf, placed, screenText } from './effects'

const scene = atom({ plugin: 'wipe', key: 'scene' } as const, null, { shape: 'wipe-v2' })

const PANE = 'wipe'
const CLEARS = new Set(['clear', 'new', 'reset'])
const FRAMES = 36
const FRAMES_OF: Record<string, number> = { tv: 20 }
const FRAME_MS = 45
const START = 0.06
const PANE_ROWS = 200
const BELOW_CHAT_ROWS = 6
const HINT_LEFT = 2
const SOURCE_MESSAGES = 40
const SOURCE_CHARS = 8000

const timeOf = (progress: number) => START + (1 - START) * progress

const screenOf = (viewport: { columns: number; rows: number } | undefined) => {
  const columns = Math.max(1, Math.min(512, viewport?.columns ?? 80))
  const rows = Math.max(BELOW_CHAT_ROWS + 1, Math.min(256, viewport?.rows ?? 24))
  return { columns, rows, chatRows: rows - BELOW_CHAT_ROWS }
}

async function play($: EngineInterface, effect: string, label: string) {
  const rows = await $.session.messages().catch(() => [])
  const text = screenText(rows.slice(-SOURCE_MESSAGES)).slice(-SOURCE_CHARS)
  await update($, scene, () => ({ progress: 0, text, label, effect }))
  await $.ui.open({ id: PANE, title: ' ', rows: PANE_ROWS }).catch(() => undefined)
  const frames = FRAMES_OF[effect] ?? FRAMES
  for (let frame = 0; frame <= frames; frame++) {
    await update($, scene, () => ({ progress: frame / frames, text, label, effect }))
    await $.clock.sleep(FRAME_MS)
  }
  await $.ui.close({ id: PANE }).catch(() => undefined)
  await update($, scene, () => null)
}

async function pick($: EngineInterface, asked: string) {
  if (EFFECT_NAMES.includes(asked)) return asked
  const now = await $.clock.now()
  return EFFECT_NAMES[now % EFFECT_NAMES.length] ?? 'fade'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, scene, () => null)
    await $.command
      .register({ name: 'wipe', description: `Play a screen wipe without clearing anything: ${EFFECT_NAMES.join(', ')}`, argumentHint: EFFECT_NAMES.join('|') })
      .catch(() => undefined)
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (e.command === 'wipe') {
      const effect = await pick($, e.args.trim())
      const label = `${effect} #${(await $.clock.now()) % 100000}`
      $.clock.after(0, () => void play($, effect, label).catch(() => undefined))
      return { text: label }
    }
    if (!CLEARS.has(e.command)) return next(e)
    await play($, await pick($, ''), '')
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const current = await read($, scene)
    if (e.surface !== 'terminal') return next(e)
    const { Box, Raster } = $.ui.resolve(e)
    const effect = current ? EFFECTS[current.effect] : undefined
    if (!current || !effect) return <Box />
    const columns = Math.max(1, Math.min(512, e.props.bodyColumns))
    const height = Math.max(1, Math.min(256, e.props.scroll.bodyRows))
    const cells = effect(glyphsOf(current.text, columns, height), columns, height, timeOf(current.progress))
    return <Raster key="wipe" columns={columns} rows={height} cells={encode(cells, columns, 0, height)} />
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'wipe' } }, async ($, e, next) => {
    const current = await read($, scene)
    if (e.surface !== 'terminal') return next(e)
    const { Raster, Text } = $.ui.resolve(e)
    const effect = current ? EFFECTS[current.effect] : undefined
    if (!current || !effect || !current.label || !e.props.text.includes(current.label)) return <Text dimColor>◌ wiped</Text>
    const { columns, rows, chatRows } = screenOf(e.viewport)
    const cells = effect(glyphsOf(current.text, columns, chatRows), columns, rows, timeOf(current.progress))
    return <Raster key="wipe-chat" columns={columns} rows={chatRows} cells={encode(cells, columns, 0, chatRows)} />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, scene)
    const band = await next(e)
    const effect = current ? EFFECTS[current.effect] : undefined
    if (!current || !effect || e.surface !== 'terminal' || e.props.hasSurvey) return band
    const lines = linesOf(band).slice(0, Math.max(1, e.props.maxRows))
    if (lines.length === 0) return band
    const { Raster } = $.ui.resolve(e)
    const { columns, rows, chatRows } = screenOf(e.viewport)
    const width = Math.max(1, Math.min(columns, e.props.bodyColumns))
    const glyphs = [...glyphsOf(current.text, columns, chatRows), ...placed(lines.join('\n'), width, chatRows)]
    const cells = effect(glyphs, columns, rows, timeOf(current.progress))
    return <Raster key="wipe-band" columns={width} rows={lines.length} cells={encode(cells, columns, chatRows, lines.length, width)} />
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const current = await read($, scene)
    const effect = current ? EFFECTS[current.effect] : undefined
    if (!current || !effect || e.surface !== 'terminal' || !e.props.hint.trim()) return next(e)
    const { Raster } = $.ui.resolve(e)
    const { columns, rows, chatRows } = screenOf(e.viewport)
    const width = Math.max(1, columns - HINT_LEFT)
    const glyphs = [...glyphsOf(current.text, columns, chatRows), ...placed(e.props.hint, columns, rows - 1, HINT_LEFT)]
    const cells = effect(glyphs, columns, rows, timeOf(current.progress))
    return <Raster key="wipe-hint" columns={width} rows={1} cells={encode(cells, columns, rows - 1, 1, width)} />
  })
}
