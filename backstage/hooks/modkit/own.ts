import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ModkitLayout } from './contract'

const layout = atom({ plugin: 'backstage', key: 'layout' } as const, { v: 2, cells: [] })

export const OWN = 'backstage'

export function published($: EngineInterface) {
  return read($, layout)
}

export function publish($: EngineInterface, value: ModkitLayout) {
  return update($, layout, () => value)
}
