import { fade, reveal } from './grid'
import type { Grid } from './grid'

export type Easing = (t: number) => number
export type TransitionKind = 'fade' | 'reveal' | 'none'
export type Transition = { kind: TransitionKind; ms: number; easing?: Easing }

export const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
export const linear: Easing = t => clamp01(t)
export const easeOut: Easing = t => 1 - (1 - clamp01(t)) ** 3
export const easeInOut: Easing = t => {
  const x = clamp01(t)
  return x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2
}

export function progress(since: number, now: number, ms: number, easing: Easing = easeInOut) {
  if (ms <= 0) return 1
  return easing((now - since) / ms)
}

export function tween(from: number, to: number, since: number, now: number, ms: number, easing: Easing = easeInOut) {
  return from + (to - from) * progress(since, now, ms, easing)
}

export function apply(g: Grid, kind: TransitionKind, alpha: number): Grid {
  if (kind === 'fade') return fade(g, alpha)
  if (kind === 'reveal') return reveal(g, alpha)
  return g
}

export type Phase = { visible: boolean; since: number }

export function alphaOf(phase: Phase, now: number, enter?: Transition, exit?: Transition) {
  const transition = phase.visible ? enter : exit
  if (!transition || transition.kind === 'none') return phase.visible ? 1 : 0
  const t = progress(phase.since, now, transition.ms, transition.easing)
  return phase.visible ? t : 1 - t
}

export function flip(phase: Phase, visible: boolean, now: number, enter?: Transition, exit?: Transition): Phase {
  if (phase.visible === visible) return phase
  const running = phase.visible ? enter : exit
  const coming = visible ? enter : exit
  const done = running && running.ms > 0 ? clamp01((now - phase.since) / running.ms) : 1
  return { visible, since: now - (1 - done) * (coming?.ms ?? 0) }
}

export function isSettled(phase: Phase, now: number, enter?: Transition, exit?: Transition) {
  const transition = phase.visible ? enter : exit
  return !transition || transition.kind === 'none' || now - phase.since >= transition.ms
}
