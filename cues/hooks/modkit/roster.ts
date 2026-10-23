import { read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ModkitLayout } from './contract'

export async function roster($: EngineInterface): Promise<Record<string, ModkitLayout | undefined>> {
  const [backstage, cues, mirror, modkit, molt] = await Promise.all([
    read($, { plugin: 'backstage', key: 'layout' } as const),
    read($, { plugin: 'cues', key: 'layout' } as const),
    read($, { plugin: 'mirror', key: 'layout' } as const),
    read($, { plugin: 'modkit', key: 'layout' } as const),
    read($, { plugin: 'molt', key: 'layout' } as const),
  ])
  return { backstage, cues, mirror, modkit, molt }
}
