import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import {
  bandText,
  explainGhFailure,
  parsePrs,
  parseWorktrees,
  relativeTime,
  summarizeChecks,
} from '../hooks/tablero'
import { world } from './harness'

const NOW = Date.parse('2026-10-02T12:00:00Z')

const GH = JSON.stringify([
  {
    number: 612,
    title: 'Aviso al guardar',
    headRefName: 'Gagaismo/issue-610',
    author: { login: 'Gagaismo' },
    isDraft: false,
    reviewDecision: 'APPROVED',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', state: 'SUCCESS' },
    ],
    updatedAt: '2026-10-02T11:55:00Z',
  },
  {
    number: 613,
    title: 'Otro cambio',
    headRefName: 'Gagaismo/issue-611',
    author: { login: 'Gagaismo' },
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
    ],
    updatedAt: '2026-10-02T10:00:00Z',
  },
  {
    number: 614,
    title: 'Borrador',
    headRefName: 'Gagaismo/issue-607',
    author: null,
    isDraft: true,
    reviewDecision: '',
    statusCheckRollup: [],
    updatedAt: '2026-10-01T12:00:00Z',
  },
])

const PORCELAIN = [
  'worktree /work/repo',
  'HEAD f86cb0d',
  'branch refs/heads/main',
  '',
  'worktree /work/wt/issue-610',
  'HEAD 1957147',
  'branch refs/heads/Gagaismo/issue-610',
  '',
].join('\n')

test('parses PRs with checks, review, age and worktree', () => {
  const prs = parsePrs(GH, parseWorktrees(PORCELAIN))
  expect(prs.map(pr => [pr.number, pr.checks.state, pr.review, pr.worktree])).toEqual([
    [612, 'ok', 'approved', 'issue-610'],
    [613, 'fail', 'required', undefined],
    [614, 'none', 'none', undefined],
  ])
  expect(prs[1]?.checks).toEqual({ state: 'fail', done: 1, total: 2 })
  expect(prs[2]?.author).toBe('?')
  expect(relativeTime(prs[0]?.updatedAt ?? 0, NOW)).toBe('hace 5 min')
  expect(relativeTime(prs[1]?.updatedAt ?? 0, NOW)).toBe('hace 2 h')
  expect(relativeTime(prs[2]?.updatedAt ?? 0, NOW)).toBe('hace 1 d')
  expect(summarizeChecks([{ status: 'QUEUED' }])).toEqual({ state: 'pending', done: 0, total: 1 })
})

test('the band counts open, ready and red PRs and omits zero parts', () => {
  const prs = parsePrs(GH, new Map())
  expect(bandText(prs)).toBe('PRs: 3 abiertos · 1 con review lista · 1 con checks rojos')
  expect(bandText(prs.slice(2))).toBe('PRs: 1 abierto')
})

test('gh failures become short Spanish messages', () => {
  expect(explainGhFailure('fatal: not a git repository')).toEqual({ kind: 'norepo' })
  expect(explainGhFailure('no git remotes found')).toEqual({ kind: 'norepo' })
  expect(explainGhFailure('To get started with GitHub CLI, please run:  gh auth login')).toEqual({
    kind: 'error',
    message: 'gh no está autenticado: corré gh auth login.',
  })
  expect(explainGhFailure('boom\nmore')).toEqual({ kind: 'error', message: 'No pude leer los PRs: boom' })
})

type Run = { exitCode: number; stdout: string; stderr: string }
const DESPACHO = { despacho: { script: 'scripts/despachar.sh', revisar: 'scripts/revisar.sh' } }
const norm = (path: string): string => path.replace(/^[A-Za-z]:/, '').split(String.fromCharCode(92)).join('/')

// `config` is the committed .orca-stack.json of the fake repo (none by default).
const harness = (on: On, remote: string | null, gh: Run, config?: unknown) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  const calls: string[][] = []
  const sent: string[] = []
  on('session.repo', () => ({
    value: remote === undefined ? null : { root: '/r', remote, internal: false, name: null },
  }))
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    const run: Run =
      e.argv[0] === 'gh'
        ? gh
        : e.argv[1] === 'rev-parse'
          ? { exitCode: 0, stdout: ['/work/repo/.git', '/work/repo', ''].join('\n'), stderr: '' }
          : { exitCode: 0, stdout: PORCELAIN, stderr: '' }

    return { value: { ...run, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', (_$, e) => ({ value: config !== undefined && norm(e.path) === '/work/repo/.orca-stack.json' }))
  on('fs.read', () => ({ value: JSON.stringify(config) }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)

    return { text: e.text }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['engine'] }))

  return { ...w, calls, sent, clock }
}

const props = {
  title: 'Tablero de despacho',
  isFocused: false,
  bodyColumns: 100,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const band = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

test('loads PRs, draws the band and the pane, and the buttons send prompts', async ($, on) => {
  const h = harness(
    on,
    'git@github.com:Gagaismo/proyecto.git',
    { exitCode: 0, stdout: GH, stderr: '' },
    DESPACHO,
  )
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await h.clock.advance(1)
  await h.clock.settle()
  expect(h.calls.map(argv => argv.slice(0, 3).join(' '))).toEqual([
    'git rev-parse --path-format=absolute',
    'gh pr list',
    'git worktree list',
  ])

  const strip = await $.ui.mount({
    plugin: 'tablero-despacho',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: band,
  })
  expect((await strip.find({ type: 'Text' }))?.text).toContain(
    'PRs: 3 abiertos · 1 con review lista · 1 con checks rojos',
  )
  await strip.unmount()

  const ui = await $.ui.mount({
    plugin: 'tablero-despacho',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tablero',
    props,
  })
  expect((await ui.find({ type: 'Text', text: /#612/ }))?.text).toContain('#612 Aviso al guardar')
  expect((await ui.find({ type: 'Text', text: /worktree issue-610/ }))?.text).toContain(
    'checks ✓ 2/2 · review aprobada · worktree issue-610',
  )
  await ui.press({ key: 'review:612' })
  await ui.press({ key: 'status:613' })
  await ui.press({ key: 'gentle:613' })
  await ui.press({ key: 'merge:612' })
  expect(h.sent).toEqual([
    'Lanzá el review del PR #612 con agy',
    'Fijate el PR #613 y decime cómo está',
    'Consultá a Gentle Shell sobre el PR #613',
    'Si no hay bloqueos, mergeá el PR #612',
  ])

  const before = h.calls.length
  await ui.press({ key: 'refresh' })
  expect(h.calls.length).toBe(before + 3)
  await ui.unmount()
})

test('a repo without a GitHub remote runs nothing and shows no band', async ($, on) => {
  const h = harness(on, 'https://gitlab.com/x/y.git', { exitCode: 0, stdout: '[]', stderr: '' })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await h.clock.advance(1)
  await h.clock.settle()
  expect(h.calls).toEqual([])

  const strip = await $.ui.mount({
    plugin: 'tablero-despacho',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: band,
  })
  expect(await strip.find({ type: 'Button' })).toBeUndefined()
  expect((await strip.find({ type: 'Text' }))?.text).toBe('engine')
  await strip.unmount()

  const ui = await $.ui.mount({
    plugin: 'tablero-despacho',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tablero',
    props,
  })
  expect((await ui.find({ type: 'Text', text: /no es un repo/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('an unauthenticated gh shows a short message instead of crashing', async ($, on) => {
  const h = harness(on, 'https://github.com/x/y.git', {
    exitCode: 4,
    stdout: '',
    stderr: 'To get started with GitHub CLI, please run:  gh auth login',
  })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await h.clock.advance(1)
  await h.clock.settle()

  const ui = await $.ui.mount({
    plugin: 'tablero-despacho',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tablero',
    props,
  })
  expect((await ui.find({ type: 'Text', text: /gh auth login/ }))?.text).toBe(
    'gh no está autenticado: corré gh auth login.',
  )
  await ui.unmount()
})

test('/tablero opens the pane', async ($, on) => {
  const h = harness(on, 'https://github.com/x/y.git', { exitCode: 0, stdout: '[]', stderr: '' })
  const out = await $.command.run({
    command: 'tablero',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(out.text).toBe('Tablero de despacho abierto.')
  expect(h.calls.length).toBeGreaterThan(0)
})

test('without despacho in the config the "Revisar con agy" button is not drawn', async ($, on) => {
  const h = harness(on, 'git@github.com:Gagaismo/proyecto.git', { exitCode: 0, stdout: GH, stderr: '' })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await h.clock.advance(1)
  await h.clock.settle()

  const ui = await $.ui.mount({
    plugin: 'tablero-despacho',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tablero',
    props,
  })
  expect(await ui.find({ type: 'Button', key: 'review:612' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'status:612' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'merge:612' })).toBeDefined()
  await ui.unmount()
})
