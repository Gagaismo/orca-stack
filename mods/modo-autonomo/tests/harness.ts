import type { On } from 'claude-code'

// The world beneath the plugin: state, status line and toasts held in memory.
export const world = (on: On) => {
  const state = new Map<string, { value: unknown; version: number }>()
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const compactions: number[] = []

  on('state.get', (_$, e) => ({
    value: state.get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 },
  }))
  on('state.set', (_$, e) => {
    const version = (state.get(`${e.plugin}/${e.key}`)?.version ?? 0) + 1
    state.set(`${e.plugin}/${e.key}`, { value: e.value, version })

    return { value: { isSet: true as const, version } }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { name: e.name } as never }))
  on('session.compact', () => {
    compactions.push(1)

    return { messages: [{ role: 'user' as const, text: 'resumen', toolUses: [] }] }
  })

  return { state, statuses, toasts, compactions }
}
