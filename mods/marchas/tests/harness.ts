import type { On } from 'claude-code'

export const MAIN_GIT = '/repo/.git\n/repo/.git\n/repo\n'
export const WORKTREE_GIT = '/repo/.git/worktrees/worker\n/repo/.git\n/repo/worker\n'
export const AGENTS = '<!-- orca-stack:begin -->\n### Marchas\nreglas de marcha\n<!-- orca-stack:end -->\n'
export const WITHOUT_MARCHAS = '<!-- orca-stack:begin -->\n### Metodo\nreglas\n<!-- orca-stack:end -->\n'

export const harness = (
  on: On,
  options: { git?: string; config?: boolean; contract?: string; sessionId?: string } = {},
) => {
  const registered: string[] = []
  const reads: string[] = []
  const existsCalls: string[] = []
  // `$.state` lasts one process (#153): `emptyState` empties it, as a resume in a new process or `/clear` does.
  const state = new Map<string, { value: unknown; version: number }>()
  const notices: string[] = []
  const toasts: string[] = []
  const git = options.git ?? MAIN_GIT
  const contract = options.contract ?? AGENTS
  let sessionId = options.sessionId ?? 'session-1'
  on('state.get', (_$, e) => ({
    value: state.get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 },
  }))
  on('state.set', (_$, e) => {
    const version = (state.get(`${e.plugin}/${e.key}`)?.version ?? 0) + 1
    state.set(`${e.plugin}/${e.key}`, { value: e.value, version })

    return { value: { isSet: true as const, version } }
  })
  // The kit keeps the row beneath this hook, which only records the notices the mod appends.
  on('session.append', async (_$, e, next) => {
    notices.push(e.message.content.map(block => ('text' in block ? block.text : '')).join(''))

    return next(e)
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({ additionalContext: [] }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'resumen', toolUses: [] }] }))
  on('session.id', () => ({ value: sessionId }))
  on('clock.now', () => ({ value: 1000000000000 }))
  on('command.register', (_$, e) => {
    registered.push(e.name)

    return { value: { name: e.name } as never }
  })
  on('process.run', (_$, e) => ({
    value: {
      exitCode: e.argv[0] === 'git' ? 0 : 1,
      stdout: e.argv[0] === 'git' ? git : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('fs.exists', (_$, e) => {
    existsCalls.push(e.path)
    const path = e.path.replace(/\\/g, '/')

    return { value: path.endsWith('/AGENTS.md') || (options.config !== false && path.endsWith('/.orca-stack.json')) }
  })
  on('fs.read', (_$, e) => {
    const path = e.path.replace(/\\/g, '/')
    reads.push(path)

    return { value: path.endsWith('/AGENTS.md') ? contract : '' }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['engine'] }))
  on('ui.render', { component: 'SessionMode' }, () => ({ type: 'Text', children: ['engine-modes'] }))

  return {
    registered,
    reads,
    existsCalls,
    notices,
    toasts,
    setSessionId: (next: string) => { sessionId = next },
    emptyState: () => { state.clear() },
  }
}
