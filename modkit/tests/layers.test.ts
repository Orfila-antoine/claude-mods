import { expect, test } from 'claude-code/testing'

import { STACK, keyOf, merge, parseKey, plan } from '../hooks/modkit/layers'
import type { Placed } from '../hooks/modkit/layers'

const layer = (mod: string, id: string, z: number, order: number, extra: Partial<Placed> = {}): Placed => ({
  mod, layer: id, slot: `${mod}/${id}`, order, z, rows: 1, cover: false, ...extra,
})

test('slots stack by z, highest first; equal z keeps registration order', () => {
  const slots = plan([layer('a', 'low', 1, 0), layer('b', 'high', 9, 1), layer('c', 'tie', 5, 2), layer('a', 'tie', 5, 0)], 10)
  expect(slots.map(s => s.slot)).toEqual(['b/high', 'a/tie', 'c/tie', 'a/low'])
})

test('layers sharing a slot are composited bottom to top, the slot taking the highest z and tallest rows', () => {
  const [slot] = plan([layer('a', 'top', 8, 0, { slot: 'row' }), layer('b', 'under', 3, 1, { slot: 'row', rows: 2 })], 10)
  expect(slot?.z).toBe(8)
  expect(slot?.rows).toBe(2)
  expect(slot?.members.map(m => m.layer)).toEqual(['under', 'top'])
})

test('when rows run out the lowest priorities are dropped, never cut in half', () => {
  const slots = plan([layer('a', 'one', 9, 0, { rows: 2 }), layer('b', 'two', 5, 1, { rows: 2 }), layer('c', 'three', 1, 2, { rows: 1 })], 3)
  expect(slots.map(s => s.slot)).toEqual(['a/one', 'c/three'])
  expect(plan([layer('a', 'one', 1, 0)], 0)).toEqual([])
})

test('the highest cover takes the whole zone, ties going to the first registered', () => {
  const slots = plan([layer('a', 'band', 50, 0), layer('b', 'wipe', 7, 1, { cover: true }), layer('c', 'wipe', 7, 2, { cover: true, rows: 9 })], 4)
  expect(slots.map(s => s.slot)).toEqual(['b/wipe'])
})

const box = (key: string) => ({ type: 'Box', props: { key }, children: [] })
const stack = (children: unknown[]) => ({ type: 'Box', props: { key: STACK }, children })
const keys = (nodes: unknown[]) => nodes.map(n => (n as { props?: { key?: string }; type?: string }).props?.key ?? (n as { type: string }).type)

test('two plugins merge into the same order whichever of them the engine calls first', () => {
  const base = { type: 'engine', ref: 0 }
  const fromA = [box(keyOf(9, 'alpha', 'clock')), box(keyOf(2, 'alpha', 'hint'))]
  const fromB = [box(keyOf(5, 'beta', 'line')), box(keyOf(9, 'beta', 'tie'))]
  const aOuter = merge<unknown>(fromA, stack(merge<unknown>(fromB, base)))
  const bOuter = merge<unknown>(fromB, stack(merge<unknown>(fromA, base)))
  expect(keys(aOuter)).toEqual(['modkit:9:alpha:clock', 'modkit:9:beta:tie', 'modkit:5:beta:line', 'modkit:2:alpha:hint', 'engine'])
  expect(keys(bOuter)).toEqual(keys(aOuter))
})

test('a plugin without the kit below stays at the bottom, untouched', () => {
  const plain = { type: 'Text', children: ['other mod'] }
  expect(merge([box(keyOf(1, 'alpha', 'x'))], plain)).toEqual([box(keyOf(1, 'alpha', 'x')), plain])
  expect(parseKey('modkit:-2.5:alpha:a:b')).toEqual({ z: -2.5, plugin: 'alpha', slot: 'a:b' })
  expect(parseKey('something-else')).toBeNull()
})
