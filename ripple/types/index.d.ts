export type Ripple = {
  id: string
  agent: string
  label: string
  path: string
  file: string
  added: number
  removed: number
  isNew: boolean
  isGone: boolean
  times: number
  dependents: string[] | null
}
export type Wave = { id: string; frame: number }

declare module 'claude-code' {
  interface PluginState {
    ripple: {
      edits: Shaped<Ripple[]>
      wave: Wave | null
      isOpen: boolean
    }
  }
}
