export type Spiral = { reason: string; detail: string; at: number }

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
    cues: { layout: ModkitLayout }
    mirror: { layout: ModkitLayout }
    modkit: { layout: ModkitLayout }
    molt: { layout: ModkitLayout }
  }
}
// modkit:roster end
