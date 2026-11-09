import { expect, test } from 'claude-code/testing'

import { CYCLE, DEFAULT_PATH, harness, MAIN_DOC, WORKTREE_GIT } from './harness'

const PREFIX = (path: string) =>
  `Estos son los pasos de \`### Ciclo de \`main\`\` de \`${path}\`, el mismo MAIN.md al que apunta el contrato de AGENTS.md; el resto de sus secciones está en ese archivo.`
const INJECTED = (path: string, cycle = CYCLE) => `${PREFIX(path)}\n\n${cycle}`
const start = (source: string) => ({ source }) as never
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const }
// Claude Code's per-string additionalContext cap (https://code.claude.com/docs/en/hooks, "JSON output").
const CAP = 10_000

test('R1: the main checkout gets MAIN.md whatever branch it is on', async ($, on) => {
  const w = harness(on)
  const out = await $.classic.SessionStart(start('startup'))
  expect(out.additionalContext).toEqual([INJECTED(DEFAULT_PATH)])
  // Only git-dir against git-common-dir decides: the branch is never asked, so `main` and `docs/x` are alike.
  expect(w.gitCalls).toEqual([['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']])
})

test('R1: a worker worktree gets nothing', async ($, on) => {
  const w = harness(on, { git: WORKTREE_GIT })
  const out = await $.classic.SessionStart(start('startup'))
  expect(out.additionalContext).toEqual([])
  expect(w.reads).toEqual([])
})

test('R2: startup, resume and compact each inject MAIN.md once', async ($, on) => {
  const w = harness(on)
  for (const source of ['startup', 'resume', 'compact']) {
    const out = await $.classic.SessionStart(start(source))
    expect(out.additionalContext).toEqual([INJECTED(DEFAULT_PATH)])
  }
  expect(w.reads).toEqual([DEFAULT_PATH, DEFAULT_PATH, DEFAULT_PATH])
})

test('R2: turns do not reinject MAIN.md', async ($, on) => {
  const w = harness(on)
  await $.classic.SessionStart(start('startup'))
  await $.turn.complete(TURN)
  await $.turn.complete(TURN)
  expect(w.reads).toEqual([DEFAULT_PATH])
})

test('R2: a session start of another kind, such as clear, gets nothing', async ($, on) => {
  const w = harness(on)
  const out = await $.classic.SessionStart(start('clear'))
  expect(out.additionalContext).toEqual([])
  expect(w.reads).toEqual([])
})

test('R2 fallback: only the steps of Ciclo de main are sent, never the other sections', async ($, on) => {
  harness(on)
  const out = await $.classic.SessionStart(start('startup'))
  const text = (out.additionalContext ?? []).join('\n')
  expect(text.includes('marchas')).toBe(false)
  expect(text.includes('despacho')).toBe(false)
  expect(text.includes('1. reglas de main')).toBe(true)
})

test('R2 fallback: a Ciclo de main over the cap arrives whole, split into entries under 10,000 characters', async ($, on) => {
  // Shaped like the real one: ten steps, about 13,000 characters, some steps over 2,000.
  const steps = Array.from({ length: 10 }, (_, i) => `${i + 1}. ${'regla larga de main '.repeat(i % 3 === 0 ? 120 : 40).trimEnd()}`)
  const cycle = `### Ciclo de \`main\`\n\nAntes de actuar sobre un número medido, leé la skill.\n\n${steps.join('\n')}`
  expect(cycle.length > CAP).toBe(true)
  harness(on, { files: { [DEFAULT_PATH]: `## Orca stack\n\n### Marchas\n\nmarchas\n\n${cycle}\n\n### Despacho\n\ndespacho\n` } })
  const out = await $.classic.SessionStart(start('compact'))
  const entries = out.additionalContext ?? []
  expect(entries.length).toBe(2)
  for (const entry of entries) expect(entry.length <= CAP).toBe(true)
  expect(entries[0].startsWith(`${PREFIX(DEFAULT_PATH)}\n\n`)).toBe(true)
  const continuation = `main-md: sigue \`### Ciclo de \`main\`\` de \`${DEFAULT_PATH}\` (parte 2 de 2).\n\n`
  expect(entries[1].startsWith(continuation)).toBe(true)
  const rejoined = [entries[0].slice(PREFIX(DEFAULT_PATH).length + 2), entries[1].slice(continuation.length)].join('\n')
  expect(rejoined).toBe(cycle)
})

test('R2 fallback: a MAIN.md without Ciclo de main leaves one short line naming the path', async ($, on) => {
  harness(on, { files: { [DEFAULT_PATH]: '## Orca stack\n\n### Marchas\n\nmarchas\n' } })
  const out = await $.classic.SessionStart(start('startup'))
  expect(out.additionalContext).toEqual([
    `main-md: \`${DEFAULT_PATH}\` no tiene la sección \`### Ciclo de \`main\`\`; seguí el puntero a MAIN.md del contrato.`,
  ])
})

test('R3: a repo without .orca-stack.json gets nothing', async ($, on) => {
  const w = harness(on, { config: false })
  const out = await $.classic.SessionStart(start('startup'))
  expect(out.additionalContext).toEqual([])
  expect(w.reads).toEqual([])
})

test('R4: ORCA_STACK_POLICY_PATH moves MAIN.md beside the policy', async ($, on) => {
  const w = harness(on, {
    env: { ORCA_STACK_POLICY_PATH: 'D:\\stack\\ORCA-STACK.md' },
    files: { 'D:/stack/MAIN.md': '### Ciclo de `main`\r\n\r\n1. otro main\r\n', [DEFAULT_PATH]: MAIN_DOC },
  })
  const out = await $.classic.SessionStart(start('compact'))
  expect(out.additionalContext).toEqual([INJECTED('D:/stack/MAIN.md', '### Ciclo de `main`\n\n1. otro main')])
  expect(w.reads).toEqual(['D:/stack/MAIN.md'])
})

test('R4: a missing MAIN.md leaves one short line naming the path and the session starts', async ($, on) => {
  harness(on, { files: {} })
  const out = await $.classic.SessionStart(start('startup'))
  expect(out.additionalContext).toEqual([
    `main-md: no se pudo leer \`${DEFAULT_PATH}\`; seguí el puntero a MAIN.md del contrato.`,
  ])
})

test('R4: an unreadable MAIN.md leaves the same short line', async ($, on) => {
  harness(on, { unreadable: true })
  const out = await $.classic.SessionStart(start('resume'))
  expect(out.additionalContext).toEqual([
    `main-md: no se pudo leer \`${DEFAULT_PATH}\`; seguí el puntero a MAIN.md del contrato.`,
  ])
})

test('R5: the injected text opens with one line naming MAIN.md as the file the contract points to', async ($, on) => {
  harness(on)
  const out = await $.classic.SessionStart(start('startup'))
  const [first, ...rest] = (out.additionalContext?.[0] ?? '').split('\n')
  expect(first).toBe(PREFIX(DEFAULT_PATH))
  expect(rest.join('\n')).toBe(`\n${CYCLE}`)
})
