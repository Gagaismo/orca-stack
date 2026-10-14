export type Gear = 'lazy' | 'medium' | 'proactive'

declare module 'claude-code' {
  interface PluginState {
    marchas: { ultracode: boolean }
    // Read only: modo-autonomo owns and writes it (mods/modo-autonomo/types/index.d.ts).
    'modo-autonomo': { isOn: boolean }
  }
}
