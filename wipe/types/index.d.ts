export type Scene = { progress: number; text: string; label: string; effect: string }

declare module 'claude-code' {
  interface PluginState {
    wipe: { scene: Shaped<Scene | null> }
  }
}
