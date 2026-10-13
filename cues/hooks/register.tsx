import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { isPush, isoWeek, nextStepOf, pushLabel, startLine, weeksInARow } from './logic'
import { sparks } from './sparks'

const nextStep = atom({ plugin: 'cues', key: 'nextStep' } as const, null)
const push = atom({ plugin: 'cues', key: 'push' } as const, null)
const noticed = atom({ plugin: 'cues', key: 'noticed' } as const, false)

const SPARK_FRAMES = 26
const SPARK_MS = 60
const CUES = [
  'End every answer with exactly one line that starts with "Next:" and names the single next action the developer can take.',
  'When you call AskUserQuestion, write each option description as its consequence: the files it touches, any migration, the impact on clients.',
].join('\n')

let pushTicker: { cancel: () => void } | null = null

async function animatePush($: EngineInterface, label: string) {
  pushTicker?.cancel()
  await update($, push, () => ({ label, frame: 0 }))
  let frame = 0
  const ticker = $.clock.every(SPARK_MS, () => {
    frame += 1
    if (frame >= SPARK_FRAMES) ticker.cancel()
    void update($, push, () => (frame < SPARK_FRAMES ? { label, frame } : null)).catch(() => ticker.cancel())
  })
  pushTicker = ticker
}

async function startNotice($: EngineInterface) {
  if (await read($, noticed)) return
  await update($, noticed, () => true)
  const [today, stored, beads] = await Promise.all([
    $.clock.now(),
    $.store.get('weeks'),
    $.session.root().then(root => $.fs.read(`${root}/.beads/issues.jsonl`)).catch(() => ''),
  ])
  const weeks = Array.isArray(stored) ? stored.filter((week): week is number => typeof week === 'number') : []
  const week = isoWeek(today)
  if (!weeks.includes(week)) await $.store.set('weeks', [...weeks, week].slice(-60))
  const streak = weeksInARow([...weeks, week], today)
  const parts = [streak >= 2 ? `Week ${streak} in a row, rest days are free.` : null, typeof beads === 'string' ? startLine(beads) : null].filter(Boolean)
  if (parts.length > 0) await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: parts.join('  ') }] } })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.after(0, () => void startNotice($).catch(() => undefined))
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { ...composed, sections: [...composed.sections, { id: 'cues:cues', text: CUES, scope: 'session' as const }] }
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && !e.isAborted) {
      const step = nextStepOf(e.answer)
      await update($, nextStep, () => step)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const ran = await next(e)
    if (!('deny' in ran && ran.deny) && !ran.isError && isPush(command)) {
      await animatePush($, pushLabel(String(ran.text ?? ''))).catch(() => undefined)
    }
    return ran
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.props.isDraft || e.props.isWorking) return next(e)
    const step = await read($, nextStep)
    return step ? next({ ...e, props: { ...e.props, hint: `next: ${step}` } }) : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, push)
    if (!current || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    const { Box, Raster } = $.ui.resolve(e)
    const columns = Math.min(60, e.props.bodyColumns)
    const rows = Math.max(1, Math.min(3, e.props.maxRows))
    const band = await next(e)
    return (
      <Box flexDirection="column">
        <Raster key="push-sparks" columns={columns} rows={rows} cells={sparks(columns, rows, current.frame, current.label)} />
        {band}
      </Box>
    )
  })
}
