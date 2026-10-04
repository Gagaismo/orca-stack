export type GrillingQuestions = number[]

declare module 'claude-code' {
  interface PluginState {
    'grilling-ok': { pending: GrillingQuestions }
  }
}
