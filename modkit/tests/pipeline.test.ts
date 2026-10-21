import { expect, test } from 'claude-code/testing'

import { run } from '../hooks/modkit/pipeline'
import type { Entry, Fault, Step } from '../hooks/modkit/pipeline'

type Msg = { text: string }
type Ctx = { trail: string[] }

const entry = (mod: string, name: string, step: Step<Msg, Msg, Ctx>, ctx: Ctx): Entry<Msg, Msg, Ctx> => ({ mod, name, step, ctx })
const core = (trail: string[]) => async (msg: Msg) => {
  trail.push(`core:${msg.text}`)
  return { text: `core(${msg.text})` }
}

test('steps run in registration order, inward then outward', async () => {
  const ctx: Ctx = { trail: [] }
  const tracer = (mod: string, name: string) =>
    entry(mod, name, async (msg, next, { trail }) => {
      trail.push(`${mod}.${name}:in`)
      const out = await next()
      trail.push(`${mod}.${name}:out`)
      return out
    }, ctx)
  const out = await run([tracer('a', 'one'), tracer('a', 'two'), tracer('b', 'one')], { text: 'x' }, core(ctx.trail), () => undefined)
  expect(out).toEqual({ text: 'core(x)' })
  expect(ctx.trail).toEqual(['a.one:in', 'a.two:in', 'b.one:in', 'core:x', 'b.one:out', 'a.two:out', 'a.one:out'])
})

test('a step transforms what the next ones see, consumes, or passes by returning nothing', async () => {
  const ctx: Ctx = { trail: [] }
  const upper = entry('a', 'upper', (msg, next) => next({ text: msg.text.toUpperCase() }), ctx)
  const observer = entry('b', 'observe', (msg, next, { trail }) => {
    trail.push(`saw:${msg.text}`)
  }, ctx)
  const consumer = entry('c', 'consume', msg => (msg.text === 'STOP' ? { text: 'consumed' } : undefined), ctx)
  expect(await run([upper, observer, consumer], { text: 'go' }, core(ctx.trail), () => undefined)).toEqual({ text: 'core(GO)' })
  expect(await run([upper, observer, consumer], { text: 'stop' }, core(ctx.trail), () => undefined)).toEqual({ text: 'consumed' })
  expect(ctx.trail).toEqual(['saw:GO', 'core:GO', 'saw:STOP'])
})

test('an unhandled message reaches the terminal unchanged', async () => {
  const ctx: Ctx = { trail: [] }
  expect(await run([], { text: 'alone' }, core(ctx.trail), () => undefined)).toEqual({ text: 'core(alone)' })
})

test('a step that throws before next is skipped: the next steps get its input and the fault names it', async () => {
  const ctx: Ctx = { trail: [] }
  const faults: Fault[] = []
  const broken = entry('a', 'broken', () => {
    throw new Error('nope')
  }, ctx)
  const after = entry('b', 'after', (msg, next, { trail }) => {
    trail.push(`after:${msg.text}`)
    return next()
  }, ctx)
  expect(await run([broken, after], { text: 'x' }, core(ctx.trail), fault => faults.push(fault))).toEqual({ text: 'core(x)' })
  expect(ctx.trail).toEqual(['after:x', 'core:x'])
  expect(faults.map(f => `${f.mod}/${f.name}: ${(f.error as Error).message}`)).toEqual(['a/broken: nope'])
})

test('a step that throws after next keeps what ran downstream, which runs once', async () => {
  const ctx: Ctx = { trail: [] }
  const faults: Fault[] = []
  const late = entry('a', 'late', async (msg, next) => {
    await next({ text: 'changed' })
    throw new Error('late')
  }, ctx)
  expect(await run([late], { text: 'x' }, core(ctx.trail), fault => faults.push(fault))).toEqual({ text: 'core(changed)' })
  expect(ctx.trail).toEqual(['core:changed'])
  expect(faults).toHaveLength(1)
})

test('a failing terminal is not blamed on the steps above it', async () => {
  const ctx: Ctx = { trail: [] }
  const faults: Fault[] = []
  const pass = entry('a', 'pass', (msg, next) => next(), ctx)
  const failing = async () => {
    throw new Error('core down')
  }
  await expect(run([pass], { text: 'x' }, failing, fault => faults.push(fault))).rejects.toThrow('core down')
  expect(faults).toEqual([])
})
