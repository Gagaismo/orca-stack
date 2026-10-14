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
  const git = options.git ?? MAIN_GIT
  const contract = options.contract ?? AGENTS
  let sessionId = options.sessionId ?? 'session-1'
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

  return { registered, reads, existsCalls, setSessionId: (next: string) => { sessionId = next } }
}
