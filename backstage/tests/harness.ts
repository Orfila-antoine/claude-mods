import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelUsage, On, PromptEditInput } from 'claude-code'

const usage: ModelUsage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

export const HAIKU = 'Fix the 401 on /login: find the endpoint in the auth module.'
export const FOUND = 'Here it is:\n{"claim":"the cache is cold","why":"never measured","check":"read the logs"}'

type Options = {
  percent?: number
  draft?: string
  selection?: string
  messages?: { role: 'user' | 'assistant'; text: string }[]
  reply?: string
  replyDelayMs?: number
}

export function stage(
  on: On,
  { percent = 10, draft = '', selection, messages = [], reply = HAIKU, replyDelayMs = 0 }: Options = {},
) {
  const clock = mock.clock(on)
  const box = { text: draft }
  const seen = {
    filled: [] as string[],
    toasts: [] as string[],
    commands: [] as string[],
    briefs: [] as string[],
    sent: [] as string[],
  }
  const asked: { model: string; prompt: string; system: string }[] = []
  const forks: string[] = []

  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000, tokens: 1, percent } } }))
  on('session.messages', () => ({ value: messages.map(row => ({ ...row, toolUses: [] })) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    box.text = ''
    seen.sent.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => {
    box.text = e.text
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.edit', ($, e) => {
    box.text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text: box.text, cursor: e.start + e.inputText.length }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.selection', () => ({ value: selection === undefined ? undefined : { text: selection } }))
  on('command.run', ($, e) => {
    seen.commands.push(e.command)
    return {}
  })
  on('model.complete', async ($, e) => {
    asked.push({ model: e.model, prompt: e.prompt, system: e.system ?? '' })
    if (replyDelayMs > 0) await clock.sleep(replyDelayMs)
    return { value: { isAnswered: true, text: reply, usage } }
  })
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: FOUND, usage } }
  })
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', ($, e) => {
    seen.briefs.push(e.prompt)
    return { model: 'haiku' }
  })

  const type = ($: Engine, text: string) => {
    const edit = ($.prompt as unknown as { edit: (e: PromptEditInput) => Promise<unknown> }).edit
    return edit({ origin: { kind: 'composer' }, text: box.text, cursor: box.text.length, start: box.text.length, end: box.text.length, inputText: text })
  }

  return { clock, box, asked, forks, type, ...seen }
}

export const turn = (answer: string, turnId: string, reason: 'answer' | 'aborted' = 'answer') => ({
  answer,
  durationMs: 1,
  isAborted: reason === 'aborted',
  turnId,
  reason,
})

export const typed = (text: string) => ({ text, origin: { kind: 'composer' as const }, wait: false })

export function mountBand($: Engine, isWorking = false, maxRows = 10) {
  return $.ui.mount({
    plugin: 'backstage',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows, bodyColumns: 100, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} },
  })
}

export const press = ($: Engine, key: string) => $.ui.press({ plugin: 'backstage', key })
