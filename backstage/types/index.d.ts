export type Claim = { claim: string; why: string; check: string }

export type Picker = 'type' | 'idea'

declare module 'claude-code' {
  interface PluginState {
    backstage: {
      busy: string | null
      picker: Picker | null
      undo: { draft: string; written: string } | null
      scoutId: string | null
      contextPercent: number
      isHandingOff: boolean
    }
  }
}
