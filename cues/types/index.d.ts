export type Pushed = string | null

declare module 'claude-code' {
  interface PluginState {
    cues: {
      nextStep: string | null
      pushed: Pushed
      noticed: boolean
    }
  }
}
