export type MainView =
  | { mode: 'waiting'; elapsedS: number }
  | { mode: 'working'; elapsedS: number }
  | {
      mode: 'eta'
      done: number
      total: number
      remS: number
      elapsedS: number
      overdue: boolean
      basis: 'history' | 'tasks' | 'agents'
      similar: number
    }

export type AgentView = {
  id: string
  name: string
  model: string | null
  effort: string | null
  tool: string | null
  status: 'running' | 'waiting' | 'done' | 'failed' | 'lost'
  elapsedS: number
  remS: number | null
  overdue: boolean
  costUsd: number | null
  isAdopted: boolean
}

export type BandView = {
  main: MainView | null
  agents: AgentView[]
  more: number
  suggestion: string | null
}

export type EtaState = { rows: number }

// modkit:roster
export type Side = 'left' | 'right'
export type Breakpoint = { below: number; float?: Side | null; hidden?: boolean }
export type Flow = { float?: Side; width?: number; minColumns?: number; priority?: number; at?: readonly Breakpoint[] }
export type FlowCell = {
  id: string
  z: number
  order: number
  slot?: string
  cover?: boolean
  flow: Flow
  rows: { full: number; narrow: Record<string, number> }
}
export type ModkitLayout = { v: 2; cells: readonly FlowCell[] }

declare module 'claude-code' {
  interface PluginState {
    backstage: { layout: ModkitLayout }
    'cache-tax': { layout: ModkitLayout }
    cues: { layout: ModkitLayout }
    'eta-band': { layout: ModkitLayout }
    mirror: { layout: ModkitLayout }
    modkit: { layout: ModkitLayout }
    molt: { layout: ModkitLayout }
  }
}
// modkit:roster end
