export type TableroChecks = {
  state: 'ok' | 'fail' | 'pending' | 'none'
  done: number
  total: number
}

export type TableroPr = {
  number: number
  title: string
  branch: string
  author: string
  isDraft: boolean
  review: 'approved' | 'changes' | 'required' | 'none'
  checks: TableroChecks
  updatedAt: number
  worktree?: string
}

export type TableroBoard = {
  status: 'unknown' | 'loading' | 'ok' | 'norepo' | 'error'
  message: string
  prs: TableroPr[]
  at: number
  hasDespacho: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'tablero-despacho': { board: TableroBoard }
  }
}
