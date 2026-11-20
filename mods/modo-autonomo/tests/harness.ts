import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// The world beneath the plugin: state, status line and toasts held in memory, and a personal orca-stack config
// (`config`, written at /home/.orca-stack/config.json) outside any git repo.
export const world = (on: On, options: { config?: unknown } = {}) => {
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
  const personal = '/home/.orca-stack/config.json'
  mock.env(on, { HOME: '/home' })
  // The engine resolves paths against the drive on Windows (`/home` reaches the hook as `C:\home`).
  const isPersonal = (path: string): boolean => path.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '') === personal
  on('fs.exists', (_$, e) => ({ value: options.config !== undefined && isPersonal(e.path) }))
  on('fs.read', () => ({ value: JSON.stringify(options.config) }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('clock.now', () => ({ value: 1000000000000 }))
  on('session.compact', () => {
    compactions.push(1)

    return { messages: [{ role: 'user' as const, text: 'resumen', toolUses: [] }] }
  })

  return { state, statuses, toasts, compactions }
}
