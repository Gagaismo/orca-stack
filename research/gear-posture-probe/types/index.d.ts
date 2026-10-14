export type Gear = string

declare module 'claude-code' {
  interface PluginState {
    'gear-probe': { gear: Gear }
  }
}
