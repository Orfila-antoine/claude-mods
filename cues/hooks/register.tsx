import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { isPush, isoWeek, nextStepOf, pushLabel, startLine, weeksInARow } from './logic'
import { band, modFx } from './modkit'
import type { Kit, Mod } from './modkit'
import { sparks } from './sparks'

const nextStep = atom({ plugin: 'cues', key: 'nextStep' } as const, null)
const pushed = atom({ plugin: 'cues', key: 'pushed' } as const, null)
const noticed = atom({ plugin: 'cues', key: 'noticed' } as const, false)

const SPARK_FRAMES = 50
const SPARK_MS = 60
const CUES = [
  'End every answer with exactly one line that starts with "Next:" and names the single next action the developer can take.',
  'When you call AskUserQuestion, write each option description as its consequence: the files it touches, any migration, the impact on clients.',
].join('\n')

type CuesState = { push: { label: string; at: number } | null; isShown: boolean }

const cues: Mod<CuesState> = {
  id: 'cues',
  layers: [
    {
      id: 'sparks',
      z: 90,
      priority: 10,
      rows: ({ maxRows }) => Math.max(1, Math.min(3, maxRows)),
      animated: true,
      exit: { kind: 'fade', ms: 300 },
      visible: state => state?.isShown === true,
      grid: ({ columns, rows, now, since, state }) => sparks(columns, rows, Math.floor((now - since) / SPARK_MS), state?.push?.label ?? ''),
    },
  ],
}

const KIT: Kit = { plugin: 'cues', mods: [cues] }

async function animatePush($: EngineInterface, label: string) {
  const fx = modFx($, KIT, 'cues')
  const at = await fx.now()
  await fx.setState<CuesState>(() => ({ push: { label, at }, isShown: true }))
  $.clock.after(SPARK_FRAMES * SPARK_MS, () => {
    void fx.setState<CuesState>(state => (state?.push?.at === at ? { push: state.push, isShown: false } : (state ?? { push: null, isShown: false }))).catch(() => undefined)
  })
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

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    return next({ ...e, context: [...(e.context ?? []), CUES] })
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && !e.isAborted) {
      const step = nextStepOf(e.answer)
      await update($, nextStep, () => step)
    }
    const label = e.agentId ? null : await read($, pushed)
    if (label) {
      await update($, pushed, () => null)
      await animatePush($, label).catch(() => undefined)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const ran = await next(e)
    if (!('deny' in ran && ran.deny) && !ran.isError && isPush(command)) {
      const label = pushLabel(String(ran.text ?? ''))
      await update($, pushed, () => label)
    }
    return ran
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.props.isDraft || e.props.isWorking) return next(e)
    const step = await read($, nextStep)
    return step ? next({ ...e, props: { ...e.props, hint: `next: ${step}` } }) : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => band($, e, await next(e), KIT)).catch(($, e, next) => next(e))
}
