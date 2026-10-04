export type RelojCacheStamp = number | null

declare module 'claude-code' {
  interface PluginState {
    'reloj-cache': { lastAt: RelojCacheStamp; hasWarned: boolean }
  }
}
