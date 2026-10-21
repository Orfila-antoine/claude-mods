import type { Register } from 'claude-code'

import { bar, defineMods, grid, label, put, spinner } from './modkit'
import type { Mod } from './modkit'

type ClockState = { isRunning: boolean; startedAt: number }
type EchoState = { count: number; isBoom: boolean }

const BLUE = 0x7aa2f7
const GREY = 0x8a8a8a
const WHITE = 0xffffff
const BAR_WIDTH = 30
const LAP_MS = 2000

const clock: Mod<ClockState> = {
  id: 'clock',
  on: {
    'prompt.submit': [
      async function startClock(msg, next, { fx }) {
        const now = await fx.now()
        await fx.setState<ClockState>(() => ({ isRunning: true, startedAt: now }))
        return next()
      },
    ],
    'turn.complete': [
      async function stopClock(msg, next, { fx }) {
        await fx.setState<ClockState>(state => ({ isRunning: false, startedAt: state?.startedAt ?? 0 }))
        return next()
      },
    ],
  },
  layers: [
    {
      id: 'bar',
      slot: 'clock',
      z: 10,
      rows: 1,
      animated: true,
      enter: { kind: 'fade', ms: 300 },
      exit: { kind: 'fade', ms: 500 },
      visible: state => state?.isRunning === true,
      grid({ columns, rows, now, state }) {
        const g = grid(columns, rows)
        const elapsed = Math.max(0, now - (state?.startedAt ?? now))
        spinner(g, 0, 0, elapsed, BLUE)
        label(g, 2, 0, `${(elapsed / 1000).toFixed(1)}s`, GREY)
        bar(g, 10, 0, Math.min(BAR_WIDTH, columns - 10), (elapsed % LAP_MS) / LAP_MS, BLUE)
        return g
      },
    },
    {
      id: 'glint',
      slot: 'clock',
      z: 11,
      rows: 1,
      animated: true,
      enter: { kind: 'fade', ms: 300 },
      exit: { kind: 'fade', ms: 500 },
      visible: state => state?.isRunning === true,
      grid({ columns, rows, now, state }) {
        const g = grid(columns, rows)
        const width = Math.min(BAR_WIDTH, columns - 10)
        const elapsed = Math.max(0, now - (state?.startedAt ?? now))
        put(g, 10 + Math.floor(((elapsed % LAP_MS) / LAP_MS) * width), 0, '◆', WHITE)
        return g
      },
    },
  ],
}

const echo: Mod<EchoState> = {
  id: 'echo',
  commands: [{ name: 'kit-boom', description: 'modkit example: a step and a layer throw on purpose, the rest keeps working' }],
  on: {
    'prompt.submit': [
      async function countMessages(msg, next, { fx }) {
        await fx.setState<EchoState>(state => ({ count: (state?.count ?? 0) + 1, isBoom: state?.isBoom ?? false }))
        return next()
      },
      function shrug(msg, next) {
        return msg.text.includes(':shrug:') ? next({ ...msg, text: msg.text.replaceAll(':shrug:', '¯\\_(ツ)_/¯') }) : next()
      },
    ],
    'command.run': [
      async function boom(msg, next, { fx }) {
        if (msg.command !== 'kit-boom') return next()
        await fx.setState<EchoState>(state => ({ count: state?.count ?? 0, isBoom: true }))
        throw new Error('boom, on purpose')
      },
      function answerBoom(msg, next) {
        if (msg.command !== 'kit-boom') return next()
        return { text: 'modkit: the boom step and the boom layer threw; this step still answered and the other layers still draw.' }
      },
    ],
  },
  layers: [
    {
      id: 'line',
      z: 5,
      rows: 1,
      node({ ui, state, fx }) {
        const { Box, Button, Text } = ui
        return (
          <Box>
            <Text dimColor>{`modkit · ${state?.count ?? 0} messages `}</Text>
            <Button key="echo-reset" hotkey="k" label="Reset" onPress={() => fx.setState<EchoState>(() => ({ count: 0, isBoom: false }))} />
          </Box>
        )
      },
    },
    {
      id: 'boom',
      z: 4,
      rows: 1,
      visible: state => state?.isBoom === true,
      grid() {
        throw new Error('boom layer, on purpose')
      },
    },
  ],
}

export const register: Register = (on, options) => defineMods(on, options, { plugin: 'modkit', mods: [clock, echo] })
