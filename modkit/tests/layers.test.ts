import { expect, test } from 'claude-code/testing'

import type { Flow, FlowCell, ModkitLayout } from '../hooks/modkit/contract'
import { FLOW, STACK, assemble, harvest, keyOf, measure, pluginOf, solve } from '../hooks/modkit/layers'
import type { BoxProps, Placed } from '../hooks/modkit/layers'

type Extra = Flow & { full?: number; narrow?: Record<string, number>; slot?: string; cover?: boolean; order?: number }

const cell = (id: string, z: number, { full = 1, narrow = {}, slot, cover, order = 0, ...flow }: Extra = {}): FlowCell => ({
  id,
  z,
  order,
  ...(slot !== undefined && { slot }),
  ...(cover && { cover }),
  flow,
  rows: { full, narrow },
})
const of = (...cells: FlowCell[]): ModkitLayout => ({ v: 2, cells })
const brief = (plan: readonly Placed[]) =>
  plan.map(item => `${item.id} ${item.kind === 'float' ? `float-${item.side}` : 'block'} @${item.top} ${item.columns}x${item.rows}`)

test('without a float, cells stack by z, then plugin, then order, at full width', () => {
  const plan = solve(80, 10, [
    of(cell('b/m/high', 9), cell('b/m/low', 1, { full: 2, order: 1 })),
    of(cell('a/m/tie', 5, { order: 1 }), cell('a/m/first', 5)),
    of(cell('c/m/tie', 5)),
  ])
  expect(brief(plan)).toEqual(['b/m/high block @0 80x1', 'a/m/first block @1 80x1', 'a/m/tie block @2 80x1', 'c/m/tie block @3 80x1', 'b/m/low block @4 80x2'])
})

test('cells of one plugin and one slot merge into one, with the highest z and the tallest rows', () => {
  const plan = solve(80, 10, [of(cell('a/m/top', 8, { slot: 'row' }), cell('a/m/under', 3, { slot: 'row', full: 2, order: 1 })), of(cell('b/m/row', 8))])
  expect(brief(plan)).toEqual(['a/row block @0 80x2', 'b/m/row block @2 80x1'])
})

test('the highest cover takes the whole band, ties going to the first plugin, cut to the budget', () => {
  const layouts = [of(cell('a/m/band', 50)), of(cell('c/m/wipe', 7, { cover: true, full: 9 })), of(cell('b/m/wipe', 7, { cover: true, full: 3 }))]
  expect(brief(solve(80, 4, layouts))).toEqual(['b/m/wipe block @0 80x3'])
  expect(brief(solve(80, 2, layouts))).toEqual(['b/m/wipe block @0 80x2'])
})

test('a right float narrows a shorter block, then a longer one, and the block after its end is full width', () => {
  const plan = solve(80, 10, [
    of(
      cell('p/m/pet', 9, { float: 'right', width: 10, full: 3 }),
      cell('p/m/a', 8, { order: 1 }),
      cell('p/m/b', 7, { order: 2, narrow: { '70': 3 } }),
      cell('p/m/c', 6, { order: 3, narrow: { '70': 4 } }),
    ),
  ])
  expect(brief(plan)).toEqual(['p/m/pet float-right @0 10x3', 'p/m/a block @0 70x1', 'p/m/b block @1 70x3', 'p/m/c block @4 80x1'])
})

test('a block that starts exactly where the float ends is full width', () => {
  const plan = solve(80, 10, [
    of(cell('p/m/pet', 9, { float: 'right', width: 10, full: 2 }), cell('p/m/a', 8, { order: 1, full: 2 }), cell('p/m/b', 7, { order: 2, narrow: { '70': 5 } })),
  ])
  expect(brief(plan)).toEqual(['p/m/pet float-right @0 10x2', 'p/m/a block @0 70x2', 'p/m/b block @2 80x1'])
})

test('a float last in the flow adds its rows below the blocks, and counts them against the budget', () => {
  const layouts = [of(cell('p/m/a', 9), cell('p/m/b', 8, { order: 1 }), cell('p/m/pet', 1, { order: 2, float: 'right', width: 10, full: 3 }))]
  expect(brief(solve(80, 5, layouts))).toEqual(['p/m/a block @0 80x1', 'p/m/b block @1 80x1', 'p/m/pet float-right @2 10x3'])
  expect(brief(solve(80, 4, layouts))).toEqual(['p/m/a block @0 80x1', 'p/m/b block @1 80x1'])
})

test('opposite floats that overlap with different tops each narrow only the blocks that start beside them', () => {
  const plan = solve(80, 10, [
    of(
      cell('p/m/right', 9, { float: 'right', width: 10, full: 3 }),
      cell('p/m/a', 8, { order: 1 }),
      cell('p/m/left', 7, { order: 2, float: 'left', width: 5, full: 3 }),
      cell('p/m/b', 6, { order: 3 }),
    ),
  ])
  expect(brief(plan)).toEqual(['p/m/right float-right @0 10x3', 'p/m/a block @0 70x1', 'p/m/left float-left @1 5x3', 'p/m/b block @1 65x1'])
})

test('a left and a right float together narrow the block between them by both widths', () => {
  const plan = solve(80, 10, [
    of(
      cell('p/m/left', 9, { float: 'left', width: 5, full: 2 }),
      cell('p/m/right', 8, { order: 1, float: 'right', width: 10, full: 2 }),
      cell('p/m/a', 7, { order: 2, narrow: { '65': 2 } }),
    ),
  ])
  expect(brief(plan)).toEqual(['p/m/left float-left @0 5x2', 'p/m/right float-right @0 10x2', 'p/m/a block @0 65x2'])
})

test('a second float on the side already taken becomes a block', () => {
  const plan = solve(80, 10, [of(cell('p/m/one', 9, { float: 'right', width: 10, full: 3 }), cell('p/m/two', 8, { order: 1, float: 'right', width: 8 }))])
  expect(brief(plan)).toEqual(['p/m/one float-right @0 10x3', 'p/m/two block @0 70x1'])
})

test('a float that would push a block under its minColumns becomes a block itself', () => {
  const pet = of(cell('m/m/pet', 65, { float: 'right', width: 30, full: 2 }))
  expect(brief(solve(80, 10, [pet, of(cell('b/m/bar', 50, { minColumns: 60 }))]))).toEqual(['m/m/pet block @0 80x2', 'b/m/bar block @2 80x1'])
  expect(brief(solve(80, 10, [pet, of(cell('b/m/bar', 50, { minColumns: 50 }))]))).toEqual(['m/m/pet float-right @0 30x2', 'b/m/bar block @0 50x1'])
})

test('breakpoints turn the float into a block, then hide it', () => {
  const layouts = [
    of(cell('m/m/pet', 65, { float: 'right', width: 10, full: 2, at: [{ below: 60, float: null }, { below: 45, hidden: true }] })),
    of(cell('a/m/a', 1)),
  ]
  expect(brief(solve(80, 10, layouts))).toEqual(['m/m/pet float-right @0 10x2', 'a/m/a block @0 70x1'])
  expect(brief(solve(50, 10, layouts))).toEqual(['m/m/pet block @0 50x2', 'a/m/a block @2 50x1'])
  expect(brief(solve(40, 10, layouts))).toEqual(['a/m/a block @0 40x1'])
})

const BAND = [
  of(cell('backstage/backstage/choices', 60, { full: 4 }), cell('backstage/backstage/bar', 50, { order: 1, priority: 100 })),
  of(cell('cues/cues/sparks', 90, { priority: 10 })),
  of(cell('mirror/mirror/spiral', 80, { priority: 90, full: 2 })),
  of(cell('molt/molt/sprite', 65, { priority: 20 })),
]

test('the budget goes by priority across plugins: the bar stays, a cell too tall is skipped, the next that fits is kept, sparks go first', () => {
  expect(brief(solve(80, 4, BAND))).toEqual(['mirror/mirror/spiral block @0 80x2', 'molt/molt/sprite block @2 80x1', 'backstage/backstage/bar block @3 80x1'])
})

test('a narrowed height not yet published counts as the full height', () => {
  const plan = solve(80, 10, [of(cell('p/m/pet', 9, { float: 'right', width: 10, full: 2 }), cell('p/m/a', 8, { order: 1, narrow: { '60': 4 } }))])
  expect(brief(plan)).toEqual(['p/m/pet float-right @0 10x2', 'p/m/a block @0 70x1'])
})

test('the plan is the same whatever the order of the layouts', () => {
  const layouts = [...BAND, of(cell('zeta/m/pet', 70, { float: 'right', width: 12, full: 3 }), cell('zeta/m/left', 61, { order: 1, float: 'left', width: 4, full: 2 }))]
  const plan = solve(80, 9, layouts)
  expect(plan.some(item => item.kind === 'float')).toBe(true)
  expect(solve(80, 9, [...layouts].reverse())).toEqual(plan)
  expect(solve(80, 9, [...layouts.slice(2), ...layouts.slice(0, 2)])).toEqual(plan)
})

test('a block whose text fits at full width but wraps once narrowed is published taller and placed at that height', () => {
  const words = 'x'.repeat(75)
  const pet = of(cell('molt/molt/sprite', 65, { float: 'right', width: 10, full: 3 }))
  const choices = { cell: { id: 'backstage/backstage/choices', z: 60, order: 0, flow: {} }, rowsAt: (columns: number) => Math.ceil(words.length / columns) }
  const published = measure(80, [choices], [pet])
  expect(published.cells[0]?.rows).toEqual({ full: 1, narrow: { '70': 2 } })
  expect(brief(solve(80, 10, [pet, published]))).toEqual(['molt/molt/sprite float-right @0 10x3', 'backstage/backstage/choices block @0 70x2'])
})

type Node = { type: string; props: BoxProps & Record<string, unknown>; children: unknown[] }

const box = (props: BoxProps, children: readonly unknown[]): unknown => ({ type: 'Box', props, children: [...children] })
const engine = { type: 'engine', ref: 0 }
const isNode = (node: unknown): node is Node => typeof node === 'object' && node !== null && 'props' in node && 'children' in node

function drawn(plan: readonly Placed[], plugin: string, below: unknown) {
  const { base, found } = harvest(below, new Set(plan.filter(item => pluginOf(item.id) !== plugin).map(item => item.id)))
  const own = plan.filter(item => pluginOf(item.id) === plugin)
  const elements = new Map<string, unknown>([
    ...found,
    ...own.map(item => [item.id, box({ key: keyOf(item.id), width: item.columns, height: item.rows }, [{ type: 'Text', props: {}, children: [item.id] }])] as const),
  ])
  return assemble(80, plan, elements, base, box)
}

function widest(node: unknown): number {
  if (!isNode(node)) return 0
  const own = node.props.flexDirection === 'row' ? node.children.reduce<number>((sum, child) => sum + (isNode(child) ? Number(child.props.width ?? 0) : 0), 0) : Number(node.props.width ?? 0)
  return Math.max(own, ...node.children.map(widest))
}

test('base sits above the flow, and blocks sit at the bottom of a zone taller than them', () => {
  const plan = solve(80, 10, [of(cell('p/m/pet', 9, { float: 'right', width: 10, full: 3 }), cell('p/m/a', 8, { order: 1 }))])
  const block = box({ key: 'modkit:p/m/a', width: 70, height: 1 }, [{ type: 'Text', props: {}, children: ['p/m/a'] }])
  const pet = box({ key: 'modkit:p/m/pet', width: 10, height: 3 }, [{ type: 'Text', props: {}, children: ['p/m/pet'] }])
  expect(drawn(plan, 'p', engine)).toEqual(
    box({ key: STACK, flexDirection: 'column' }, [
      engine,
      box({ key: FLOW, flexDirection: 'column' }, [
        box({ key: 'modkit-zone:p/m/pet', flexDirection: 'row', height: 3 }, [
          box({ flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden', width: 70, height: 3 }, [block]),
          box({ flexDirection: 'column', width: 10, height: 3 }, [pet]),
        ]),
      ]),
    ]),
  )
})

test('two plugins with a plugin not on modkit between them draw the same tree in both call orders, no row wider than the body', () => {
  const plan = solve(80, 10, [
    of(cell('alpha/m/pet', 65, { float: 'right', width: 10, full: 3 }), cell('alpha/m/bar', 50, { order: 1, minColumns: 20 })),
    of(cell('beta/m/choices', 60, { full: 2, narrow: { '70': 3 } }), cell('beta/m/sparks', 90, { order: 1 })),
  ])
  expect(brief(plan)).toEqual(['beta/m/sparks block @0 80x1', 'alpha/m/pet float-right @1 10x3', 'beta/m/choices block @1 70x3', 'alpha/m/bar block @4 80x1'])
  const other = (below: unknown) => box({ key: 'other', flexDirection: 'column' }, [{ type: 'Text', props: {}, children: ['not on modkit'] }, below])
  const alphaOutside = drawn(plan, 'alpha', other(drawn(plan, 'beta', engine)))
  const betaOutside = drawn(plan, 'beta', other(drawn(plan, 'alpha', engine)))
  expect(alphaOutside).toEqual(betaOutside)
  expect(widest(alphaOutside)).toBe(80)
  const stack = alphaOutside as Node
  expect(stack.children.map(child => (child as Node).props.key)).toEqual(['other', FLOW])
  expect((stack.children[0] as Node).children).toEqual([{ type: 'Text', props: {}, children: ['not on modkit'] }, engine])
})
