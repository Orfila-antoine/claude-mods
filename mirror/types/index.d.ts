export type Spiral = { reason: string; detail: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    mirror: { spiral: Shaped<Spiral | null>; dismissedAt: number; expandedAt: number }
  }
}
