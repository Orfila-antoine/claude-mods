import { expect, test } from 'claude-code/testing'

import { bar } from '../hooks/modkit/components'
import { DEFAULT, cell, composite, decode, encode, fade, grid, put, reveal, text } from '../hooks/modkit/grid'
import { alphaOf, easeInOut, easeOut, flip, isSettled, linear, tween } from '../hooks/modkit/motion'

const round = (value: number) => Math.round(value * 1000) / 1000
const FADE = { kind: 'fade' as const, ms: 400 }

test('easings start at 0, end at 1 and clamp outside', () => {
  for (const easing of [linear, easeOut, easeInOut]) {
    expect(easing(0)).toBe(0)
    expect(easing(1)).toBe(1)
    expect(easing(-1)).toBe(0)
    expect(easing(2)).toBe(1)
  }
  expect(round(easeInOut(0.5))).toBe(round(0.5))
  expect(tween(10, 20, 1000, 1200, 400, linear)).toBe(15)
})

test('progress is measured in time, so a late frame lands where it should', () => {
  const phase = { visible: true, since: 1000 }
  expect(alphaOf(phase, 1000, FADE)).toBe(0)
  expect(round(alphaOf(phase, 1200, FADE))).toBe(round(0.5))
  expect(alphaOf(phase, 9000, FADE)).toBe(1)
  expect(isSettled(phase, 1399, FADE)).toBe(false)
  expect(isSettled(phase, 1400, FADE)).toBe(true)
})

test('an exit that interrupts an enter starts from the opacity reached, no jump', () => {
  const entering = { visible: true, since: 0 }
  const before = alphaOf(entering, 100, FADE, FADE)
  const leaving = flip(entering, false, 100, FADE, FADE)
  expect(round(alphaOf(leaving, 100, FADE, FADE))).toBe(round(before))
  expect(flip(leaving, false, 150, FADE, FADE)).toBe(leaving)
})

test('fade dims colours toward black, reveal uncovers left to right, both whole at 1', () => {
  const g = grid(4, 1)
  text(g, 0, 0, 'abcd', 0xffffff)
  expect(fade(g, 1)).toBe(g)
  expect(cell(fade(g, 0.5), 0, 0).fg).toBe(0x808080)
  expect(decode(encode(fade(g, 0)), 4)).toEqual(['    '])
  expect(decode(encode(reveal(g, 0.5)), 4)).toEqual(['ab  '])
})

test('a layer on top only covers the cells it draws', () => {
  const under = grid(5, 1)
  text(under, 0, 0, 'hello')
  const over = grid(5, 1)
  text(over, 2, 0, 'X', 0xff0000)
  const merged = composite(under, over)
  expect(decode(encode(merged), 5)).toEqual(['heXlo'])
  expect(cell(merged, 2, 0).fg).toBe(0xff0000)
  expect(cell(merged, 0, 0).fg).toBe(DEFAULT)
})

test('cells only take width-1 characters and a bar fills by eighths', () => {
  const g = grid(6, 1)
  text(g, 0, 0, 'a漢🙂b')
  expect(decode(encode(g), 6)[0]).toBe('a??b  ')
  const b = grid(4, 1)
  bar(b, 0, 0, 4, 0.5)
  expect(decode(encode(b), 4)).toEqual(['██  '])
})

test('narrow symbols survive put and wide ones become a question mark', () => {
  const g = grid(11, 1)
  ;['✦', '✧', '➤', '♪', '♫', '∘', '‿', '⌕', '⤳', '字', '한'].forEach((ch, x) => put(g, x, 0, ch))
  expect(decode(encode(g), 11)[0]).toBe('✦✧➤♪♫∘‿⌕⤳??')
})
