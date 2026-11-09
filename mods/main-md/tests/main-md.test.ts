import { expect, test } from 'claude-code/testing'

import { DEFAULT_PATH, harness, MAIN_DOC, WORKTREE_GIT } from './harness'

const PREFIX = (path: string) =>
  `Este es el contenido de \`${path}\`, el mismo MAIN.md al que apunta el contrato de AGENTS.md: ya lo tenés, no lo vuelvas a leer.`
const start = (source: string) => ({ source }) as never
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const }

test('R1: the main checkout gets MAIN.md whatever branch it is on', async ($, on) => {
  const w = harness(on)
  const out = await $.classic.SessionStart(start('startup'))
  expect(out.additionalContext).toEqual([`${PREFIX(DEFAULT_PATH)}\n\n${MAIN_DOC}`])
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
    expect(out.additionalContext).toEqual([`${PREFIX(DEFAULT_PATH)}\n\n${MAIN_DOC}`])
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

test('R3: a repo without .orca-stack.json gets nothing', async ($, on) => {
  const w = harness(on, { config: false })
  const out = await $.classic.SessionStart(start('startup'))
  expect(out.additionalContext).toEqual([])
  expect(w.reads).toEqual([])
})

test('R4: ORCA_STACK_POLICY_PATH moves MAIN.md beside the policy', async ($, on) => {
  const w = harness(on, {
    env: { ORCA_STACK_POLICY_PATH: 'D:\\stack\\ORCA-STACK.md' },
    files: { 'D:/stack/MAIN.md': 'otro main\n', [DEFAULT_PATH]: MAIN_DOC },
  })
  const out = await $.classic.SessionStart(start('compact'))
  expect(out.additionalContext).toEqual([`${PREFIX('D:/stack/MAIN.md')}\n\notro main\n`])
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
  expect(rest.join('\n')).toBe(`\n${MAIN_DOC}`)
})

