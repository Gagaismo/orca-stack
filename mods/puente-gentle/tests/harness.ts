import type { On } from 'claude-code'

export const ENTRY = 'C:\\Users\\tester\\.pi\\agent\\bin\\pi-launcher.js'

export const SKILLS = 'C:\\Users\\tester\\.pi\\agent\\npm\\node_modules\\gentle-pi\\skills'

export type Run = { exitCode: number; stdout: string; stderr: string }
export type Init = { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }

export const line = (event: unknown): string => `${JSON.stringify(event)}\n`

export const answerStream = (text: string): string =>
  line({ type: 'session', version: 3, id: 'gentle-x', cwd: '/x' }) +
  line({ type: 'agent_start' }) +
  line({ type: 'message_start', message: { role: 'user', content: 'q' } }) +
  line({ type: 'message_end', message: { role: 'user', content: 'q' } }) +
  line({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending' } }) +
  line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text.slice(0, 3) } }) +
  line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text }], stopReason: 'stop' } }) +
  line({ type: 'agent_end', messages: [] }) +
  line({ type: 'agent_settled' })

// The world beneath the plugin: state, toasts, process, fs and the rest, in memory.
export const world = (on: On, opts: { run?: (argv: readonly string[]) => Run; exists?: string[]; files?: Record<string, string> } = {}) => {
  const state = new Map<string, { value: unknown; version: number }>()
  const toasts: string[] = []
  const calls: { argv: string[]; init: Init }[] = []
  const submitted: string[] = []
  const registered: string[] = []
  const tools: string[] = []
  const copied: string[] = []

  on('state.get', (_$, e) => ({
    value: state.get(`${e.plugin}/${e.key}`) ?? { value: undefined, version: 0 },
  }))
  on('state.set', (_$, e) => {
    const version = (state.get(`${e.plugin}/${e.key}`)?.version ?? 0) + 1
    state.set(`${e.plugin}/${e.key}`, { value: e.value, version })

    return { value: { isSet: true as const, version } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.copy', (_$, e) => {
    copied.push(e.text)

    return { value: { isCopied: true as const } }
  })
  on('command.register', (_$, e) => {
    registered.push(e.name)

    return { value: { name: e.name } as never }
  })
  on('tool.register', (_$, e) => {
    tools.push(e.name)

    return { value: { tool: `mcp__puente-gentle__${e.name}` } as never }
  })
  on('fs.exists', (_$, e) => ({ value: (opts.exists ?? [ENTRY, SKILLS]).includes(e.path) || e.path in (opts.files ?? {}) }))
  on('fs.read', (_$, e) => ({ value: opts.files?.[e.path] ?? '' }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)

    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [] }))
  on('process.run', (_$, e) => {
    calls.push({ argv: [...e.argv], init: (e.init ?? {}) as Init })
    const run = opts.run?.(e.argv) ?? { exitCode: 0, stdout: '', stderr: '' }

    return { value: { ...run, isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return { state, toasts, calls, submitted, registered, tools, copied }
}
