export type Push = { label: string; frame: number }

declare module 'claude-code' {
  interface PluginState {
    cues: {
      nextStep: string | null
      push: Push | null
      pushed: string | null
      noticed: boolean
    }
  }
}
