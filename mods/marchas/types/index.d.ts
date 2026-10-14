export type Gear = 'lazy' | 'medium' | 'proactive'

declare module 'claude-code' {
  interface PluginState {
    marchas: { gear: Gear }
  }
}
