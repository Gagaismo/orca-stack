export type AutonomoGoal = string

declare module 'claude-code' {
  interface PluginState {
    'modo-autonomo': { isOn: boolean; goal: AutonomoGoal; nudges: number }
  }
}
