import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const MAIN_GIT = '/repo/.git\n/repo/.git\n/repo\n'
export const WORKTREE_GIT = '/repo/.git/worktrees/orca-stack-321\n/repo/.git\n/home/u/orca/workspaces/repo/orca-stack-321\n'
export const CYCLE = '### Ciclo de `main`\n\n1. reglas de main'
export const MAIN_DOC = `## Orca stack: reglas de \`main\`\n\n### Marchas\n\nmarchas\n\n${CYCLE}\n\n### Despacho\n\ndespacho\n`
export const DEFAULT_PATH = '/home/u/orca/stack/MAIN.md'

export const harness = (
  on: On,
  options: { git?: string; config?: boolean; files?: Record<string, string>; env?: Record<string, string>; unreadable?: boolean } = {},
) => {
  const reads: string[] = []
  const gitCalls: string[][] = []
  const git = options.git ?? MAIN_GIT
  const files: Record<string, string> = options.files ?? { [DEFAULT_PATH]: MAIN_DOC }
  const env: Record<string, string> = { HOME: '/home/u', ...options.env }
  on('classic.SessionStart', () => ({ additionalContext: [] }))
  on('turn.complete', () => ({ text: '' }))
  mock.env(on, env)
  on('process.run', (_$, e) => {
    gitCalls.push(e.argv)

    return {
      value: {
        exitCode: e.argv[0] === 'git' ? 0 : 1,
        stdout: e.argv[0] === 'git' ? git : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  // The engine resolves every path against the drive on Windows (`/repo` reaches the hook as `C:\repo`): a fixture
  // path matches with or without that drive, and is reported as written.
  const norm = (path: string): string => path.replace(/\\/g, '/').toLowerCase()
  const match = (path: string, key: string): boolean => norm(path) === norm(key) || /^[a-z]:\//.test(norm(path)) && norm(path).slice(2) === norm(key)
  const fixture = (path: string): string | undefined => Object.keys(files).find(key => match(path, key))
  on('fs.exists', (_$, e) => ({
    value: (options.config !== false && match(e.path, '/repo/.orca-stack.json')) || fixture(e.path) !== undefined,
  }))
  on('fs.read', (_$, e) => {
    const key = fixture(e.path)
    reads.push(key ?? e.path)
    if (key === undefined || options.unreadable === true) throw new Error(`ENOENT: ${e.path}`)

    return { value: files[key] }
  })

  return { reads, gitCalls }
}
