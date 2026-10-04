import { expect, mock, test } from 'claude-code/testing'

import { forgetConfig } from '../hooks/orca-config'
import { buildRules, inspect, modelReason, parseUntil } from '../hooks/inspect'

const CODEX_REASON = 'Codex no tiene cuota: despachá a claude o agy.'
const MODEL = 'claude-sonnet-5-5'
const CONFIG = {
  despacho: { script: 'scripts/despachar.sh', revisar: 'scripts/revisar.sh' },
  guardia: {
    bloquear: [{ agente: 'codex', hasta: '2026-10-29', motivo: CODEX_REASON }],
    modeloClaude: MODEL,
  },
}
const rules = buildRules(CONFIG)
if (rules === undefined) {
  throw new Error('rules expected')
}

const BEFORE = new Date(2026, 9, 28, 23, 59).getTime()
const FROM = new Date(2026, 9, 29, 0, 0).getTime()
const MODEL_REASON = modelReason(MODEL)

test('the guard is off without despacho in the config', () => {
  expect(buildRules({})).toBeUndefined()
  expect(buildRules({ guardia: { modeloClaude: MODEL } })).toBeUndefined()
  expect(buildRules({ despacho: { script: '  ' } })).toBeUndefined()
})

test('hasta is a local-midnight date and bad dates are ignored', () => {
  expect(parseUntil('2026-10-29')).toBe(FROM)
  expect(parseUntil('29/10/2026')).toBeUndefined()
  const only = buildRules({
    despacho: { script: 'a.sh' },
    guardia: { bloquear: [{ agente: 'codex', hasta: 'mañana' }] },
  })
  expect(only?.blocks).toEqual([])
})

test('a block without motivo gets a default message', () => {
  const r = buildRules({
    despacho: { script: 'x/go.sh' },
    guardia: { bloquear: [{ agente: 'Codex', hasta: '2026-10-29' }] },
  })
  expect(inspect('./x/go.sh 5 codex', BEFORE, r!)).toEqual({
    kind: 'deny',
    reason: 'Codex está bloqueado hasta el 2026-10-29.',
  })
})

test('codex is denied until the date and allowed from it', () => {
  const lines = [
    './scripts/despachar.sh 582 codex',
    'scripts/revisar.sh 612 codex',
    'CODEX_ESFUERZO=high ./scripts/despachar.sh 582 codex',
    'bash scripts/despachar.sh 582 codex --reusar-agente',
  ]
  for (const line of lines) {
    expect(inspect(line, BEFORE, rules)).toEqual({ kind: 'deny', reason: CODEX_REASON })
    expect(inspect(line, FROM, rules)).toEqual({ kind: 'pass' })
  }
})

test('claude without the model is rewritten, with it passes, other model denied', () => {
  expect(inspect('./scripts/despachar.sh 582 claude', FROM, rules)).toEqual({
    kind: 'rewrite',
    command: `CLAUDE_MODELO=${MODEL} ./scripts/despachar.sh 582 claude`,
  })
  expect(inspect(`CLAUDE_MODELO=${MODEL} ./scripts/despachar.sh 582 claude`, FROM, rules)).toEqual({
    kind: 'pass',
  })
  expect(
    inspect(`export CLAUDE_MODELO=${MODEL} && ./scripts/despachar.sh 582 claude`, FROM, rules),
  ).toEqual({ kind: 'pass' })
  expect(inspect('CLAUDE_MODELO=claude-opus-4 ./scripts/despachar.sh 582 claude', FROM, rules)).toEqual({
    kind: 'deny',
    reason: MODEL_REASON,
  })
})

test('without modeloClaude claude passes untouched', () => {
  const noModel = buildRules({ despacho: { script: 'scripts/despachar.sh' } })
  expect(inspect('./scripts/despachar.sh 582 claude', FROM, noModel!)).toEqual({ kind: 'pass' })
})

test('agy, other scripts and non-invocations pass', () => {
  for (const line of [
    './scripts/despachar.sh 582 agy',
    'scripts/revisar.sh 612 agy',
    'grep despachar.sh docs/',
    'grep -rn "codex" scripts/revisar.sh',
    'cat scripts/revisar.sh',
    'git log --oneline',
    'echo "despachar.sh 5 codex"',
    './scripts/revisar.sh 612 claude',
  ]) {
    expect(inspect(line, BEFORE, rules)).toEqual({ kind: 'pass' })
  }
})

test('multi-command lines are inspected segment by segment', () => {
  expect(inspect('git pull && ./scripts/despachar.sh 5 codex', BEFORE, rules)).toEqual({
    kind: 'deny',
    reason: CODEX_REASON,
  })
  expect(
    inspect('git pull && ./scripts/despachar.sh 5 agy && ./scripts/despachar.sh 6 claude', FROM, rules),
  ).toEqual({
    kind: 'rewrite',
    command: `git pull && ./scripts/despachar.sh 5 agy && CLAUDE_MODELO=${MODEL} ./scripts/despachar.sh 6 claude`,
  })
  expect(inspect('echo hola; ./scripts/despachar.sh 7 claude | tee log', FROM, rules)).toEqual({
    kind: 'rewrite',
    command: `echo hola; CLAUDE_MODELO=${MODEL} ./scripts/despachar.sh 7 claude | tee log`,
  })
})

test('PowerShell gets the $env form of the rewrite', () => {
  expect(inspect('bash scripts/despachar.sh 5 claude', FROM, rules, 'powershell')).toEqual({
    kind: 'rewrite',
    command: `$env:CLAUDE_MODELO='${MODEL}'; bash scripts/despachar.sh 5 claude`,
  })
})

// The world beneath the plugin: a fake home and repo holding the config layers.
// The engine resolves paths for the host OS (a Windows path like C:, then work, then repo); compare them as /work/repo.
const norm = (path: string): string => path.replace(/^[A-Za-z]:/, '').split(String.fromCharCode(92)).join('/')
const files = (on: Parameters<typeof mock.clock>[0], layers: Record<string, unknown>) => {
  mock.env(on, { HOME: '/home/u' })
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: '/work/repo/.git\n/work/repo/wt\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('fs.exists', (_$, e) => ({ value: norm(e.path) in layers }))
  on('fs.read', (_$, e) => ({ value: JSON.stringify(layers[norm(e.path)]) }))
}

test('the hook denies, rewrites and passes through the engine, reading the layered config', async ($, on) => {
  forgetConfig()
  mock.clock(on, { now: BEFORE })
  // despacho from the committed file, the block from the local one: the layers merge.
  files(on, {
    '/work/repo/.orca-stack.json': { despacho: CONFIG.despacho, guardia: { modeloClaude: MODEL } },
    '/work/repo/.orca-stack.local.json': { guardia: { bloquear: CONFIG.guardia.bloquear } },
  })
  const toasts: string[] = []
  const seen: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.push(e.command)

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })

  const denied = await $.tool.call({ tool: 'Bash', command: 'scripts/despachar.sh 9 codex' })
  expect(denied.deny).toBe(CODEX_REASON)
  expect(seen).toHaveLength(0)

  await $.tool.call({ tool: 'Bash', command: 'scripts/despachar.sh 9 claude' })
  expect(seen).toEqual([`CLAUDE_MODELO=${MODEL} scripts/despachar.sh 9 claude`])
  expect(toasts).toEqual([`Agregué CLAUDE_MODELO=${MODEL}`])

  await $.tool.call({ tool: 'Bash', command: 'grep despachar.sh docs/' })
  expect(seen.at(-1)).toBe('grep despachar.sh docs/')
  expect(toasts).toHaveLength(1)
})

test('with no config at all the hook lets everything through', async ($, on) => {
  forgetConfig()
  mock.clock(on, { now: BEFORE })
  files(on, {})
  const seen: string[] = []
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.push(e.command)

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  const out = await $.tool.call({ tool: 'Bash', command: 'scripts/despachar.sh 9 codex' })
  expect(out.deny).toBeUndefined()
  expect(seen).toEqual(['scripts/despachar.sh 9 codex'])
})
