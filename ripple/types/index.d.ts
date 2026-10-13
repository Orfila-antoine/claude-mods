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
export type Run = { head: string; times: number; added: number; removed: number }
export type Fold = { run: string }
export type Last = { run: string; file: string }

declare module 'claude-code' {
  interface PluginState {
    ripple: {
      edits: Shaped<Ripple[]>
      wave: Wave | null
      isOpen: boolean
      last: Shaped<Record<string, Last | null>>
      fold: Shaped<Fold | null>
      runs: Shaped<Run | null>
    }
  }
}
