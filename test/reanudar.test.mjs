import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { main } from '../src/cli.mjs'
import { defaultIo } from '../src/despacho.mjs'
import { upsertBlock } from '../src/marker.mjs'
import { reanudarCommand } from '../src/reanudar.mjs'
import { policyBlock } from '../src/templates.mjs'
import { PACKAGE_ROOT } from '../src/util.mjs'

const ISSUE = '212'
const URL = 'https://github.com/Gagaismo/orca-stack/issues/212#issuecomment-6205678817'
const BRIEF_PATH = path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')
const LINE = `Message from main: ${URL} . Continue the ticket per your brief: ${BRIEF_PATH}.`
const ROOT = process.cwd()
const WT = path.join(path.dirname(ROOT), 'orca-stack-212')
const sendReceipt = { status: 0, stdout: JSON.stringify({ ok: true, result: { send: { accepted: true, prompt: { requestId: 'request-1', stages: ['input_accepted'], observation: 'supported' } } } }), stderr: '' }
const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const ok = stdout => ({ status: 0, stdout, stderr: '' })
const fail = stderr => ({ status: 1, stdout: '', stderr })

const STORE = path.join('/home', '.pi', 'gentle-ai', 'profiles.json')
const PIN = path.join(WT, '.pi', 'gentle-ai', 'profile.json')
const PROFILES = { active: 'OpusFull', profiles: {
  'opus-sonnet': { orchestrator: { model: 'claude-bridge/claude-opus-5-5', thinking: 'high' } },
  OpusFull: { orchestrator: { model: 'claude-bridge/claude-opus-5-5' }, 'gentle-ai-worker': { model: 'anthropic/claude-opus-5-5' } },
} }
const pinFile = profile => JSON.stringify({ kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile })
// A pi worker needs a resolvable profile before reanudar touches its terminal (#276).
const pinned = h => {
  h.files[STORE] = JSON.stringify(PROFILES)
  h.files[PIN] = pinFile('opus-sonnet')
  return h
}
const RUN_MAIN = 'run_main'
const orchestrationDefault = args => {
  if (args[1] === 'run-current') return json({ ok: true, result: { runId: RUN_MAIN } })
  if (args[1] === 'task-list') return json({ ok: true, result: { runId: RUN_MAIN, tasks: [] } })
  if (args[1] === 'worker-start') return json({ ok: true, result: { taskId: 'task_new', dispatchId: 'ctx_new', status: 'dispatched' } })
  return fail(`unexpected call: orca ${args.join(' ')}`)
}
const harness = ({ root = ROOT, home = '/home', state = 'done', agent = 'codex', screen = ['\u{273b} Baked for 2m 5s'], dirty = '', pr = false, comment = {}, send = sendReceipt, psDown = false, dryRun = false, agents, terminals, brief, now = () => 1760616000000 } = {}) => {
  const outputs = []
  const calls = []
  let createdAgent
  const files = {
    [path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')]: brief ?? 'Original ticket brief\nKeep this unchanged.\n',
  }
  if (brief === false) delete files[path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')]
  const io = {
    cwd: root, home, win: false, now, exists: file => file in files,
    readFile: file => { if (!(file in files)) throw new Error(`ENOENT ${file}`); return files[file] },
    writeFile: (file, content) => { files[file] = content }, rename: (from, to) => { files[to] = files[from]; delete files[from] },
    mkdirp: () => {}, sleep: async () => {}, out: line => outputs.push(line),
    gentleAiBinary: async () => null,
    sh: (cmd, args, opts = {}) => {
      calls.push({ cmd, args, cwd: opts.cwd })
      if (cmd === 'git' && args[0] === 'rev-parse') return ok(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
      if (cmd === 'git' && args[0] === 'remote') return ok('https://github.com/Gagaismo/orca-stack.git\n')
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return ok(`worktree ${root}\nHEAD 1\nbranch refs/heads/main\n\nworktree ${WT}\nHEAD 2\nbranch refs/heads/Gagaismo/orca-stack-212\n`)
      if (cmd === 'git' && args[0] === 'status') return ok(dirty)
      if (cmd === 'gh' && args[0] === 'api' && args[1] === 'user') return json({ login: 'stack-bot' })
      if (cmd === 'gh' && args[0] === 'api') return json({ user: { login: 'stack-bot' }, body: 'Respuesta de main: siga.', html_url: URL })
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return json(pr ? [{ number: 81, headRefName: 'Gagaismo/orca-stack-212', body: 'Closes #212', closingIssuesReferences: [{ number: 212 }] }] : [])
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') return psDown ? fail('runtime down') : json({ result: { worktrees: [{ path: WT, repo: 'orca-stack', linkedIssue: 212, agents: agents ?? (state ? [{ paneKey: 'tab-1:leaf-1', state, agentType: agent }] : []) }] } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'list') return json({ result: { terminals: terminals ?? [{ handle: 'term-1', tabId: 'tab-1', leafId: 'leaf-1', title: agent, agentIdentity: agent, worktreePath: WT }] } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') {
        const handle = args[args.indexOf('--terminal') + 1]
        const newScreen = createdAgent === 'agy' ? ['>'] : ['\u{2722} Churning... (1m 2s)']
        return json({ result: { terminal: { tail: handle === 'term-new' ? newScreen : screen } } })
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'send') {
        const line = args[args.indexOf('--text') + 1]
        return line?.startsWith('Read and follow the brief in') ? json({ result: { send: { turnStarted: true } } }) : send
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create') {
        createdAgent = args[args.indexOf('--title') + 1]
        return json({ result: { handle: 'term-new' } })
      }
      // #463: every relaunch is supervised; by default main's Run has no task of this worker, so reanudar creates one.
      if (cmd === 'orca' && args[0] === 'orchestration') return orchestrationDefault(args)
      return fail(`unexpected call: ${cmd} ${args.join(' ')}`)
    },
  }
  const sends = () => calls.filter(({ cmd, args }) => cmd === 'orca' && args[0] === 'terminal' && args[1] === 'send')
  return { io, files, outputs, calls, sends, dryRun }
}

describe('orca-stack reanudar (#214)', () => {
  test('Rule 1: refuses the Codex update menu without sending text or Enter', async () => {
    const h = harness({ state: null, agents: [], terminals: [], brief: 'You are the implementer (codex) of issue #212.\n' })
    const original = h.io.sh
    const menu = [
      'Update available \u00B7 0.162.1 \u2192 0.163.0',
      '\u203A 1. Update now (runs `npm install -g @openai/codex`)',
      '2. Skip',
    ]
    h.io.sh = (cmd, args, opts) => cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read'
      ? json({ result: { terminal: { tail: menu } } })
      : original(cmd, args, opts)

    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), error => {
      assert.match(error.message, /Codex muestra su men\u00FA de actualizaci\u00F3n/)
      assert.match(error.message, /term-new/)
      assert.match(error.message, /orca-stack reanudar/)
      return true
    })
    assert.equal(h.sends().length, 0)
  })

  test('Rule 2: records a relaunch attempt with the default CLI io rename', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orca-stack-default-io-'))
    const home = path.join(root, 'home')
    const commonDir = path.join(root, '.git')
    mkdirSync(commonDir)
    mkdirSync(path.join(home, 'orca', 'briefs'), { recursive: true })
    writeFileSync(path.join(root, '.orca-stack.json'), JSON.stringify({
      setup: 'completo', modo: 'multiagente', agentes: { usa: ['codex'], preguntarAntes: [] },
    }))
    writeFileSync(path.join(home, 'orca', 'briefs', 'orca-stack-212.md'), 'You are the implementer (codex) of issue #212.\n')
    const io = defaultIo()
    io.cwd = root
    io.home = home
    io.now = () => 1760616000000
    const calls = []
    io.sh = (cmd, args) => {
      calls.push({ cmd, args })
      if (cmd === 'git' && args[0] === 'rev-parse') return ok(`${commonDir}\n${commonDir}\n${root}\n`)
      if (cmd === 'git' && args[0] === 'remote') return ok('https://github.com/Gagaismo/orca-stack.git\n')
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return ok(`worktree ${root}\nHEAD 1\nbranch refs/heads/main\n\nworktree ${WT}\nHEAD 2\nbranch refs/heads/Gagaismo/orca-stack-212\n`)
      if (cmd === 'git' && args[0] === 'status') return ok('')
      if (cmd === 'gh' && args[0] === 'api' && args[1] === 'user') return json({ login: 'stack-bot' })
      if (cmd === 'gh' && args[0] === 'api') return json({ user: { login: 'stack-bot' }, body: 'Respuesta de main: siga.', html_url: URL })
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return json([])
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') return json({ result: { worktrees: [{ path: WT, repo: 'orca-stack', linkedIssue: 212, agents: [] }] } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'list') return json({ result: { terminals: [] } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create') return json({ result: { handle: 'term-new' } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') return json({ result: { terminal: { tail: ['ready'] } } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'send') return json({ result: { send: { turnStarted: true } } })
      if (cmd === 'orca' && args[0] === 'orchestration') return orchestrationDefault(args)
      return fail(`unexpected call: ${cmd} ${args.join(' ')}`)
    }
    try {
      assert.equal(await reanudarCommand({}, ISSUE, URL, io), 0)
      assert.equal(JSON.parse(readFileSync(path.join(commonDir, 'orca-stack', 'reanudar.json'), 'utf8'))['6205678817'].issue, ISSUE)
      assert.equal(typeof io.rename, 'function')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Rule 3: ignores multiple idle shell terminals and relaunches from the original brief, through worker-start (#463)', async () => {
    const terminals = ['term-one', 'term-two', 'term-three'].map((handle, index) => ({
      handle, tabId: `tab-${index}`, leafId: `leaf-${index}`, title: 'Terminal', worktreePath: WT,
    }))
    const h = harness({ state: null, agents: [], terminals, brief: 'You are the implementer (codex) of issue #212.\n' })
    const original = h.io.sh
    h.io.sh = (cmd, args, opts) => {
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') {
        const handle = args[args.indexOf('--terminal') + 1]
        if (handle === 'term-new') return original(cmd, args, opts)
        return json({ result: { terminal: { tail: ['PS C:\\wt\\orca-stack-212>'] } } })
      }
      return original(cmd, args, opts)
    }
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.equal(h.calls.filter(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create').length, 1)
    const start = h.calls.find(call => call.cmd === 'orca' && call.args[1] === 'worker-start')
    assert.ok(start.args[start.args.indexOf('--spec-file') + 1].endsWith('orca-stack-212-reanudar.md'), start.args.join(' '))
    assert.equal(h.sends().length, 0)
  })

  test('Rule 4: refuses when a later anonymous terminal is not at a shell prompt', async () => {
    const terminals = ['term-one', 'term-two', 'term-three'].map((handle, index) => ({
      handle, tabId: `tab-${index}`, leafId: `leaf-${index}`, title: 'Terminal', worktreePath: WT,
    }))
    const h = harness({ state: null, agents: [], terminals })
    const original = h.io.sh
    h.io.sh = (cmd, args, opts) => {
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') {
        const handle = args[args.indexOf('--terminal') + 1]
        const tail = handle === 'term-three'
          ? ['Update available', '1. Update now', '2. Skip']
          : ['PS C:\\wt\\orca-stack-212>']
        return json({ result: { terminal: { tail } } })
      }
      return original(cmd, args, opts)
    }
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), /term-three.*shell prompt/)
    assert.equal(h.calls.filter(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create').length, 0)
    assert.equal(h.sends().length, 0)
  })

  test('Rule 5 and UNKNOWN: sends the prescribed single line to a done codex TUI with Enter', async () => {
    const h = harness()
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.equal(h.sends().length, 1)
    assert.deepEqual(h.sends()[0].args.slice(2), ['--terminal', 'term-1', '--text', LINE, '--enter', '--wait-submit', '10', '--json'])
    assert.ok(h.outputs.some(line => line.includes(LINE)))
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), error => {
      assert.match(error.message, /Ya intent\u00E9 reanudar con el comentario 6205678817 \(2025-10-16T12:00:00.000Z\)/)
      assert.match(error.message, /mir\u00E1 el estado del agente y su terminal/)
      assert.match(error.message, /public\u00E1 una nueva Respuesta de main: en #212 y corr\u00E9 orca-stack reanudar 212 <url-del-comentario-nuevo>/)
      return true
    })
    assert.equal(h.sends().length, 1)
  })

  test('Rule 6: refuses invalid comment, mismatched issue, ambiguous worktree, duplicate live agents, dialogs and shell prompts', async () => {
    const foreign = harness()
    foreign.io.sh = ((base) => (cmd, args, opts) => cmd === 'gh' && args[0] === 'api' && args[1] !== 'user' ? json({ user: { login: 'someone-else' }, body: 'Respuesta de main:', html_url: URL }) : base(cmd, args, opts))(foreign.io.sh)
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, foreign.io), /cuenta del stack/)
    const wrongPrefix = harness()
    wrongPrefix.io.sh = ((base) => (cmd, args, opts) => cmd === 'gh' && args[0] === 'api' && args[1] !== 'user' ? json({ user: { login: 'stack-bot' }, body: 'Consulta: sigue?', html_url: URL }) : base(cmd, args, opts))(wrongPrefix.io.sh)
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, wrongPrefix.io), /Respuesta de main:.*Respuesta del humano:/)
    const mismatch = harness()
    await assert.rejects(() => reanudarCommand({}, ISSUE, 'https://github.com/Gagaismo/orca-stack/issues/213#issuecomment-6205678817', mismatch.io), /apunta a #213/)
    const dialog = harness({ screen: ['Do you want to proceed?', 'Esc to cancel'] })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, dialog.io), /dialog|di\u00E1logo/)
    assert.equal(dialog.sends().length, 0)
    const shell = harness({ screen: ['PS C:\\wt\\orca-stack-212>'] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, shell.io), 0)
    assert.equal(shell.sends().length, 0)
    assert.ok(shell.calls.some(call => call.cmd === 'orca' && call.args[1] === 'worker-start'))
    const waiting = harness({ state: 'waiting' })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, waiting.io), /di\u00E1logo/)
    assert.equal(waiting.sends().length, 0)
    const duplicate = harness()
    const original = duplicate.io.sh
    duplicate.io.sh = (cmd, args, opts) => {
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') return json({ result: { worktrees: [{ path: WT, linkedIssue: 212, agents: [{ state: 'done' }, { state: 'done' }] }] } })
      return original(cmd, args, opts)
    }
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, duplicate.io), /m[a\u00E1]s de un worktree|m[a\u00E1]s de un agente|adivino/)
    assert.equal(duplicate.sends().length, 0)
    const duplicateWorktrees = harness()
    const worktreePs = duplicateWorktrees.io.sh
    duplicateWorktrees.io.sh = (cmd, args, opts) => {
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') return json({ result: { worktrees: [{ path: WT, linkedIssue: 212, agents: [] }, { path: WT, linkedIssue: 212, agents: [] }] } })
      return worktreePs(cmd, args, opts)
    }
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, duplicateWorktrees.io), /2 worktrees/)
    assert.equal(duplicateWorktrees.sends().length, 0)
    const multipleLive = harness({ state: 'working', screen: ['running'] })
    const multiplePs = multipleLive.io.sh
    multipleLive.io.sh = (cmd, args, opts) => {
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') return json({ result: { worktrees: [{ path: WT, linkedIssue: 212, agents: [{ state: 'working' }, { state: 'working' }] }] } })
      return multiplePs(cmd, args, opts)
    }
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, multipleLive.io), /2 agentes vivos/)
    assert.equal(multipleLive.sends().length, 0)
  })

  test('Rule 8: refuses working workers and issues with an open PR; dry-run reports action without writes', async () => {
    const working = harness({ state: 'working', screen: ['\u{2722} Churning\u{2026} (1m 2s \u{b7} \u{2193} 3k tokens)'] })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, working.io), /reglas cambiadas/)
    assert.equal(working.sends().length, 0)
    const openPr = harness({ pr: true })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, openPr.io), /orca-stack rebote 81/)
    assert.equal(openPr.sends().length, 0)
    const dry = harness({ dryRun: true })
    assert.equal(await reanudarCommand({ dryRun: true }, ISSUE, URL, dry.io), 0)
    assert.equal(dry.sends().length, 0)
    assert.deepEqual(Object.keys(dry.files), [path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')])
    assert.ok(dry.outputs.some(line => line.includes(LINE)))
  })

  test('Rule 7: relaunches from the existing worktree with the original brief and answer URL; refuses dirty or restricted relaunches', async () => {
    const dry = harness({ state: null, screen: ['PS C:\\wt\\orca-stack-212>'], dryRun: true })
    assert.equal(await reanudarCommand({ dryRun: true }, ISSUE, URL, dry.io), 0)
    const briefPath = path.join('/home', 'orca', 'briefs', 'orca-stack-212-reanudar.md')
    assert.ok(dry.outputs.some(line => line.includes(`--worktree path:${WT}`)))
    assert.ok(dry.outputs.some(line => line.startsWith('[simulación] orca orchestration worker-start') && line.includes('orca-stack-212-reanudar.md')), dry.outputs.join('\n'))
    assert.ok(dry.outputs.some(line => line.includes(`Message from main: ${URL}`)))
    assert.equal(dry.files[path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')], 'Original ticket brief\nKeep this unchanged.\n')
    const dirty = harness({ state: null, screen: ['PS C:\\wt\\orca-stack-212>'], dirty: ' M file.js\n' })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, dirty.io), /sucio/)
    assert.equal(dirty.sends().length, 0)
    const needsConfirmation = harness({ state: null, agent: 'codex-cc', screen: ['PS C:\\wt\\orca-stack-212>'], dryRun: true })
    await assert.rejects(() => reanudarCommand({ dryRun: true }, ISSUE, URL, needsConfirmation.io), /agente conocido/)

    const launch = harness({ state: null, screen: ['PS C:\\wt\\orca-stack-212>'] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, launch.io), 0)
    assert.equal(launch.calls.filter(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create').length, 1)
    assert.ok(launch.calls.some(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create' && call.args.includes(`path:${WT}`)))
    const relaunchedBrief = launch.files[path.join('/home', 'orca', 'briefs', 'orca-stack-212-reanudar.md')]
    assert.equal(relaunchedBrief, `Message from main: ${URL}\n\nOriginal ticket brief\nKeep this unchanged.\n`)
  })

  test('Rules 4 and 5: unknown Orca states refuse without mutations; Done is normalized case-insensitively', async () => {
    const unknown = harness({ agents: [{ state: 'idle', agentType: 'codex' }, { state: 'done', agentType: 'codex' }] })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, unknown.io), /estado que no conozco \(idle\)/)
    assert.equal(unknown.sends().length, 0)
    assert.deepEqual(Object.keys(unknown.files), [path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')])
    const noState = harness({ agents: [{ agentType: 'codex' }], terminals: [] })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, noState.io), /estado que no conozco \(sin estado\)/)
    assert.equal(noState.sends().length, 0)
    const normalized = harness({ agents: [{ paneKey: 'tab-1:leaf-1', state: 'Done', agentType: 'codex' }] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, normalized.io), 0)
    assert.equal(normalized.sends().length, 1)
    assert.deepEqual(normalized.sends()[0].args.slice(2), ['--terminal', 'term-1', '--text', LINE, '--enter', '--wait-submit', '10', '--json'])
    assert.equal(normalized.calls.filter(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create').length, 0)
    const statusOnly = harness({ agents: [{ paneKey: 'tab-1:leaf-1', status: 'Done', agentType: 'codex' }] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, statusOnly.io), 0)
    assert.deepEqual(statusOnly.sends()[0].args.slice(2), ['--terminal', 'term-1', '--text', LINE, '--enter', '--wait-submit', '10', '--json'])
    assert.equal(statusOnly.calls.filter(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create').length, 0)
  })

  test('Rules 6 and 8: exited worker falls back to the real ticket brief and rejects invalid brief identities', async () => {
    const template = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'brief-ticket.md'), 'utf8')
      .replaceAll('{{ISSUE}}', ISSUE).replaceAll('{{REPO}}', 'orca-stack').replaceAll('{{AGENT}}', 'codex')
      .replaceAll('{{BRANCH}}', 'Gagaismo/orca-stack-212').replaceAll('{{BASE}}', 'main')
    const exited = harness({ agents: [], terminals: [], brief: template, dryRun: true })
    assert.equal(await reanudarCommand({ dryRun: true }, ISSUE, URL, exited.io), 0)
    assert.ok(exited.outputs.some(line => line.includes('--worktree path:') && line.includes('codex')))
    for (const brief of [false, '', 'No implementer line', template.replace('issue #212.', 'issue #213.'), template.replace('(codex)', '(unknown)')]) {
      const invalid = harness({ agents: [], terminals: [], brief, dryRun: true })
      await assert.rejects(() => reanudarCommand({ dryRun: true }, ISSUE, URL, invalid.io), /agente conocido/)
      assert.equal(invalid.calls.filter(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create').length, 0)
      assert.equal(Object.keys(invalid.files).some(file => file.endsWith('-reanudar.md')), false)
    }
  })

  test('issue 236 Rules 1 and 5: an exited codex worker relaunches with only the Fast mode flag added', async () => {
    const brief = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'brief-ticket.md'), 'utf8')
      .replaceAll('{{ISSUE}}', ISSUE).replaceAll('{{REPO}}', 'orca-stack').replaceAll('{{AGENT}}', 'codex')
      .replaceAll('{{BRANCH}}', 'Gagaismo/orca-stack-212').replaceAll('{{BASE}}', 'main')
    const exited = harness({ agents: [], terminals: [], brief, dryRun: true })
    assert.equal(await reanudarCommand({ dryRun: true }, ISSUE, URL, exited.io), 0)
    assert.ok(exited.outputs.includes('Lanzador (codex): "/home/orca/stack/scripts/codex-orca-stack.sh" -c features.fast_mode=false -c approval_policy="never" -c sandbox_mode="danger-full-access"'))
  })

  test('issue #277 Rule 4: a done pi TUI showing its idle prompt frame gets the resume line', async () => {
    const idle = ['● PR opened.', '╭─ ✿ ────────────────────────────╮', '│ type, or / for commands        │', '╰────────────────────────────────╯', ' claude-opus-5-5 · high']
    const h = pinned(harness({ agent: 'pi', screen: idle }))
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.equal(h.sends().length, 1)
    assert.deepEqual(h.sends()[0].args.slice(2), ['--terminal', 'term-1', '--text', LINE, '--enter', '--wait-submit', '10', '--json'])
    assert.equal(h.calls.some(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create'), false)
  })

  test('issue #277 Rule 4: a done pi TUI whose screen it does not recognize is refused without sending', async () => {
    const working = ['╭─ ❀ implementing… ───────────────╮', '│                                │', '╰────────────────────────────────╯']
    for (const screen of [working, ['\u{273b} Baked for 2m 5s']]) {
      const h = pinned(harness({ agent: 'pi', screen }))
      await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), /No veo a Pi en reposo/)
      assert.equal(h.sends().length, 0)
      assert.equal(h.calls.some(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create'), false)
    }
  })

  test('issue #341 Rule 4: reanudar resumes the recorded idle gentle-pi 4.7.0 screen and refuses the recorded busy one', async () => {
    // Recorded with `orca terminal read --screen` from Gentle Shell (gentle-pi 4.7.0, pi 1.5.0) on 2026-11-09; one personal path anonymized.
    const recorded = name => readFileSync(path.join(PACKAGE_ROOT, 'test', 'fixtures', 'pi-screens', `gentle-pi-4.7.0-${name}.txt`), 'utf8').replace(/\n$/, '').split('\n')
    const idle = pinned(harness({ agent: 'pi', screen: recorded('idle') }))
    assert.equal(await reanudarCommand({}, ISSUE, URL, idle.io), 0)
    assert.deepEqual(idle.sends().map(send => send.args.slice(2)), [['--terminal', 'term-1', '--text', LINE, '--enter', '--wait-submit', '10', '--json']])

    const busy = pinned(harness({ agent: 'pi', screen: recorded('busy') }))
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, busy.io), error => {
      assert.equal(error.message, `No veo a Pi en reposo en la pantalla de term-1 (#${ISSUE}): no reanudo.`)
      return true
    })
    assert.equal(busy.sends().length, 0)
  })

  test('issue #341 Rule 4: reanudar refuses a busy pi whose transcript quotes an idle frame: only the current frame counts', async () => {
    const quoted = pinned(harness({ agent: 'pi', screen: ['The idle frame reads:', '─ ✿ waiting for input ─── INSERT ─', '─ ✾ implementing… ─── INSERT ─', '›   type, or / for commands', 'status'] }))
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, quoted.io), error => {
      assert.equal(error.message, `No veo a Pi en reposo en la pantalla de term-1 (#${ISSUE}): no reanudo.`)
      return true
    })
    assert.equal(quoted.sends().length, 0)
  })

  test('issue #277 Rule 3: relaunching an exited pi worker refuses when no new pi session appears', async () => {
    const h = pinned(harness({ agent: 'pi', state: null, screen: ['PS C:\\wt\\orca-stack-212>'] }))
    h.io.gentleSkills = () => '/pi/skills'
    h.io.listFiles = () => []
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), /No observ\u00E9 una sesi\u00F3n nueva de Pi/)
    assert.ok(h.calls.some(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create' && call.args.some(arg => /; pi --no-skills /.test(arg))))
  })

  test('#444 Rule 5: relaunching an exited pi worker sends one Enter when the brief is stuck in its input, and none when the input is empty', async () => {
    const sessionDir = path.join('/home', '.pi', 'agent', 'sessions', 'wt')
    const session = path.join(sessionDir, '2026-11-24T00-00-00-000Z_s.jsonl')
    const relaunch = input => {
      const h = pinned(harness({ agent: 'pi', state: null, screen: ['PS C:\\wt\\orca-stack-212>'] }))
      h.io.gentleSkills = () => '/pi/skills'
      h.io.listFiles = () => []
      h.io.modifiedAt = () => Number.MAX_SAFE_INTEGER
      const sh = h.io.sh
      h.io.sh = (cmd, args, opts) => {
        if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read' && args.includes('term-new')) return json({ result: { terminal: { tail: ['pi v1.5.2', '\u2500'.repeat(40), input, '\u2500'.repeat(40)] } } })
        if (cmd === 'orca' && args.join(' ') === 'terminal send --terminal term-new --enter') {
          h.files[session] = [JSON.stringify({ type: 'session', cwd: WT }), '{}', '{}', '{}', JSON.stringify({ type: 'message', message: { role: 'system', content: '<tools>\n- read' } })].join('\n')
          h.io.listFiles = dir => (dir === path.dirname(sessionDir) ? [sessionDir] : dir === sessionDir ? [session] : [])
        }
        return sh(cmd, args, opts)
      }
      return h
    }
    const enters = h => h.sends().filter(send => send.args.join(' ') === 'terminal send --terminal term-new --enter')
    const stuck = relaunch('[paste #1 +40 lines]')
    assert.equal(await reanudarCommand({}, ISSUE, URL, stuck.io), 0)
    assert.equal(enters(stuck).length, 1)
    assert.ok(stuck.outputs.some(line => line.startsWith('\u2714 pi despachado')), stuck.outputs.join('\n'))
    const empty = relaunch('')
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, empty.io), error => error.message === `No observ\u00E9 una sesi\u00F3n nueva de Pi despu\u00E9s del lanzamiento en ${WT}; no doy el lanzamiento por iniciado.`)
    assert.equal(enters(empty).length, 0)
  })

  test('issue #295 Preserve: relaunching an exited pi worker that authenticates still succeeds, and one that cannot is refused', async () => {
    const AUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed'
    for (const [reply, okLaunch] of [[{ role: 'assistant', content: [{ type: 'toolCall' }], stopReason: 'toolUse' }, true], [{ role: 'assistant', content: [{ type: 'text', text: AUTH }], stopReason: 'error', errorMessage: AUTH }, false]]) {
      const h = pinned(harness({ agent: 'pi', state: null, screen: ['PS C:\\wt\\orca-stack-212>'] }))
      h.io.gentleSkills = () => '/pi/skills'
      const sessionDir = path.join('/home', '.pi', 'agent', 'sessions', 'wt')
      const session = path.join(sessionDir, '2026-11-09T00-00-00-000Z_s.jsonl')
      h.io.listFiles = dir => (dir === path.dirname(sessionDir) ? [sessionDir] : dir === sessionDir ? [session] : [])
      h.io.modifiedAt = () => Number.MAX_SAFE_INTEGER
      h.files[session] = [JSON.stringify({ type: 'session', cwd: WT }), '{}', '{}', '{}', JSON.stringify({ type: 'message', message: { role: 'system', content: '<tools>\n- read' } }), JSON.stringify({ type: 'message', message: reply })].join('\n')
      if (okLaunch) {
        assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
        assert.ok(h.outputs.some(line => line.startsWith('\u2714 pi despachado')), h.outputs.join('\n'))
      } else {
        await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), error => error.message.includes(AUTH) && error.message.includes('CLAUDE_CONFIG_DIR: '))
        assert.ok(!h.outputs.some(line => line.startsWith('\u2714 pi despachado')))
      }
    }
  })

  test('Rule 7: terminal or Orca identity wins without consulting the original brief', async () => {
    const identified = harness({ state: 'done', agent: 'codex', brief: undefined })
    assert.equal(await reanudarCommand({}, ISSUE, URL, identified.io), 0)
    assert.equal(identified.sends().length, 1)
    assert.equal(identified.calls.some(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create'), false)
  })

  test('Rule 9: an unlisted worker terminal without a shell prompt is not relaunched', async () => {
    const active = harness({ agents: [], screen: ['pi -p --no-skills'], dryRun: true })
    await assert.rejects(() => reanudarCommand({ dryRun: true }, ISSUE, URL, active.io), /no muestra un shell prompt y Orca no lista su agente/)
    assert.equal(active.sends().length, 0)
    assert.equal(active.calls.filter(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create').length, 0)
    assert.deepEqual(Object.keys(active.files), [path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')])
    const idle = harness({ agents: [], screen: ['PS C:\\wt\\orca-stack-212>'], dryRun: true })
    assert.equal(await reanudarCommand({ dryRun: true }, ISSUE, URL, idle.io), 0)
  })

  test('Rule 7: refuses relaunch while guardia-despacho blocks the agent', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orca-stack-214-guardia-'))
    const home = path.join(root, 'home')
    mkdirSync(home)
    writeFileSync(path.join(root, '.orca-stack.json'), JSON.stringify({
      setup: 'completo', modo: 'multiagente',
      agentes: { usa: ['codex'], preguntarAntes: [] },
      guardia: { bloquear: [{ agente: 'codex', hasta: '2099-01-01', motivo: 'blocked for test' }] },
    }))
    try {
      const blocked = harness({ root, home, state: null, screen: ['PS C:\\wt\\orca-stack-212>'] })
      await assert.rejects(() => reanudarCommand({}, ISSUE, URL, blocked.io), /blocked for test/)
      assert.equal(blocked.sends().length, 0)
      assert.deepEqual(Object.keys(blocked.files), [path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Rules 6 and 7: one worktree read failure is reported without sending; unknown agents fail closed', async () => {
    const down = harness({ psDown: true })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, down.io), /Orca no contesta/)
    assert.equal(down.sends().length, 0)
    const unknown = harness({ state: null, agent: 'unknown', screen: ['PS C:\\wt\\orca-stack-212>'], dryRun: true })
    await assert.rejects(() => reanudarCommand({ dryRun: true }, ISSUE, URL, unknown.io), /agente conocido/)
  })

  test('issue 382: reanudar relaunches agy with --model gemini-4-neon-high', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orca-stack-382-agy-'))
    writeFileSync(path.join(root, '.orca-stack.json'), JSON.stringify({
      setup: 'completo', modo: 'multiagente',
      agentes: { usa: ['agy'], preguntarAntes: [] },
    }))
    try {
      const gone = harness({ root, agents: [{ paneKey: 'tab-9:leaf-9', state: 'done', agentType: 'antigravity' }], terminals: [] })
      assert.equal(await reanudarCommand({}, ISSUE, URL, gone.io), 0)
      assert.ok(gone.outputs.includes('Lanzador (agy): "/home/orca/stack/scripts/agy-orca-stack.sh" --dangerously-skip-permissions --model gemini-4-neon-high'), gone.outputs.join('\n'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('issue 330 Rule 4: Orca\'s antigravity agentType is agy; an unknown agentType still refuses', async () => {
    // The 2026-11-08 state: antigravity:done with its live TUI, despachar's terminal titled agy.
    const live = harness({ agent: 'antigravity', terminals: [{ handle: 'term-1', tabId: 'tab-1', leafId: 'leaf-1', title: 'agy', worktreePath: WT }] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, live.io), 0)
    assert.equal(live.sends().length, 1)
    assert.equal(live.sends()[0].args[live.sends()[0].args.indexOf('--text') + 1], LINE)
    // A done antigravity record whose pane Orca no longer lists: relaunched as agy, not refused.
    const gone = harness({ agents: [{ paneKey: 'tab-9:leaf-9', state: 'done', agentType: 'antigravity' }], terminals: [] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, gone.io), 0)
    const created = gone.calls.find(({ cmd, args }) => cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create')
    assert.equal(created.args[created.args.indexOf('--title') + 1], 'agy')
    for (const agentType of ['gemini', undefined]) {
      const unknown = harness({ agents: [{ paneKey: 'tab-9:leaf-9', state: 'done', agentType }], terminals: [] })
      await assert.rejects(() => reanudarCommand({}, ISSUE, URL, unknown.io), error => error.message === 'No puedo identificar un agente conocido para #212; no reanudo ni relanzo.')
      assert.equal(unknown.sends().length, 0)
      assert.ok(!unknown.calls.some(({ cmd, args }) => cmd === 'orca' && args[1] === 'create'))
    }
  })

  test('Rule 11: help lists reanudar and avisar still refuses when its worker is done', async () => {
    const oldLog = console.log
    const oldError = console.error
    let output = ''
    console.log = value => { output += `${value}\n` }
    console.error = value => { output += `${value}\n` }
    try {
      await main(['--help'])
      assert.match(output, /reanudar\s+/)
      output = ''
      assert.equal(await main(['reanudar', 'bad', URL]), 1)
      assert.match(output, /Uso: orca-stack reanudar/)
    } finally {
      console.log = oldLog
      console.error = oldError
    }
    const cli = readFileSync(path.join(PACKAGE_ROOT, 'src', 'cli.mjs'), 'utf8')
    assert.match(cli, /case 'reanudar':\s+return await reanudarCommand/)
  })

  test('Rule 9: ticket brief continues after Consulta or a missing tool or skill prerequisite', () => {
    const brief = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'brief-ticket.md'), 'utf8')
    assert.match(brief, /missing tool or skill prerequisite.*not a blocker/s)
    assert.ok(!brief.includes('After posting a Consulta:'))
  })

  test('Rule 10: contract names pause recovery and init renders the managed block into AGENTS', () => {
    // Issue 325: steps 5 and Despacho moved to MAIN.md; the AGENTS.md block sends main there.
    const contract = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'MAIN.md'), 'utf8')
    assert.ok(contract.includes('worker-detenido #<n> <agente>: terminó sin abrir un PR'))
    assert.match(contract, /`orca-stack reanudar` es la \u00FAnica forma en que main llega a una terminal de worker/)
    assert.ok(contract.includes('orca-stack reanudar <issue> <url-del-comentario>'))
    const init = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'orca-stack.mjs'), 'init'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    const agents = readFileSync(path.join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8')
    assert.ok(agents.includes('leé `~/orca/stack/MAIN.md` entero antes de actuar'))
    const block = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md' })
    assert.equal(upsertBlock(agents, block), agents, 'init rendered the current managed contract block')
  })

  test('Rule 1: reanudar sends line naming the absolute brief path to a paused worker', async () => {
    const briefPath = path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')
    const expectedLine = `Message from main: ${URL} . Continue the ticket per your brief: ${briefPath}.`
    const h = harness()
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.equal(h.sends().length, 1)
    const send = h.sends()[0]
    const text = send.args[send.args.indexOf('--text') + 1]
    assert.equal(text, expectedLine)
    assert.ok(h.outputs.some(line => line.includes(expectedLine)))

    const trasladoIssue = '11'
    const trasladoUrl = 'https://github.com/Gagaismo/traslado-programado-sys/issues/11#issuecomment-9999999999'
    const trasladoBriefPath = path.join('/home', 'orca', 'briefs', 'traslado-programado-sys-11.md')
    const trasladoExpectedLine = `Message from main: ${trasladoUrl} . Continue the ticket per your brief: ${trasladoBriefPath}.`
    const trasladoWt = path.join(path.dirname(ROOT), 'traslado-programado-sys-11')
    const trasladoH = harness({ brief: 'Original brief for traslado #11\n' })
    trasladoH.files[trasladoBriefPath] = 'Original brief for traslado #11\n'
    const origSh = trasladoH.io.sh
    trasladoH.io.sh = (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'remote') return ok('https://github.com/Gagaismo/traslado-programado-sys.git\n')
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return ok(`worktree ${ROOT}\nHEAD 1\nbranch refs/heads/main\n\nworktree ${trasladoWt}\nHEAD 2\nbranch refs/heads/Gagaismo/traslado-programado-sys-11\n`)
      if (cmd === 'gh' && args[0] === 'api' && args[1] !== 'user') return json({ user: { login: 'stack-bot' }, body: 'Respuesta de main: continue.', html_url: trasladoUrl })
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') return json({ result: { worktrees: [{ path: trasladoWt, repo: 'traslado-programado-sys', linkedIssue: 11, agents: [{ paneKey: 'tab-1:leaf-1', state: 'done', agentType: 'codex' }] }] } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'list') return json({ result: { terminals: [{ handle: 'term-1', tabId: 'tab-1', leafId: 'leaf-1', title: 'codex', agentIdentity: 'codex', worktreePath: trasladoWt }] } })
      return origSh(cmd, args, opts)
    }
    assert.equal(await reanudarCommand({}, trasladoIssue, trasladoUrl, trasladoH.io), 0)
    assert.equal(trasladoH.sends().length, 1)
    const trasladoText = trasladoH.sends()[0].args[trasladoH.sends()[0].args.indexOf('--text') + 1]
    assert.equal(trasladoText, trasladoExpectedLine)
  })

  test('Rule 2: reanudar refuses before sending anything if the brief file does not exist', async () => {
    const briefPath = path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')
    const h = harness({ brief: false })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), error => {
      assert.match(error.message, /No encuentro el brief original/)
      assert.match(error.message, /no relanzo sin \u00E9l/)
      assert.ok(error.message.includes(briefPath))
      return true
    })
    assert.equal(h.sends().length, 0)
    assert.equal(h.calls.filter(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'send').length, 0)
  })

  test('Rule 4: the reanudar line stays one line with no newline so --wait-submit submits it', async () => {
    const h = harness()
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.equal(h.sends().length, 1)
    const sendArgs = h.sends()[0].args
    const textIndex = sendArgs.indexOf('--text')
    const line = sendArgs[textIndex + 1]
    assert.ok(!line.includes('\n'), 'line must not contain newline')
    assert.ok(!line.includes('\r'), 'line must not contain carriage return')
    const waitSubmitIndex = sendArgs.indexOf('--wait-submit')
    assert.ok(waitSubmitIndex !== -1, '--wait-submit must be present')
    assert.equal(sendArgs[waitSubmitIndex + 1], '10')
  })

  test('Preserve: reanudarCommand preserves paused send and relaunch handling for existing workflows', async () => {
    const h = harness()
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.equal(h.sends().length, 1)
    const sendArgs = h.sends()[0].args
    assert.equal(sendArgs[sendArgs.indexOf('--enter')], '--enter')
    assert.ok(h.outputs.some(out => out.includes('Reanudaci\u{f3}n enviada a term-1 (#212):')))

    const dry = harness({ dryRun: true })
    assert.equal(await reanudarCommand({ dryRun: true }, ISSUE, URL, dry.io), 0)
    assert.equal(dry.sends().length, 0)
    assert.ok(dry.outputs.some(out => out.includes('[simulaci\u{f3}n] orca terminal send')))
  })

  test('Rule 2: reanudar validates a PR comment like an issue comment and resumes or relaunches', async () => {
    const prUrl = 'https://github.com/Gagaismo/orca-stack/pull/81#issuecomment-6205678817'
    const expectedLine = `Message from main: ${prUrl} . Continue the ticket per your brief: ${BRIEF_PATH}.`

    // Paused (done) worker resumes with line sent to terminal
    const paused = harness({ pr: true })
    paused.io.sh = ((base) => (cmd, args, opts) => cmd === 'gh' && args[0] === 'api' && args[1] !== 'user'
      ? json({ user: { login: 'stack-bot' }, body: 'Respuesta de main: continue on PR.', html_url: prUrl })
      : base(cmd, args, opts))(paused.io.sh)
    assert.equal(await reanudarCommand({}, ISSUE, prUrl, paused.io), 0)
    assert.equal(paused.sends().length, 1)
    assert.deepEqual(paused.sends()[0].args.slice(2), ['--terminal', 'term-1', '--text', expectedLine, '--enter', '--wait-submit', '10', '--json'])

    // Exited worker relaunches with brief containing the PR comment URL
    const exited = harness({ pr: true, state: null, screen: ['PS C:\\wt\\orca-stack-212>'] })
    exited.io.sh = ((base) => (cmd, args, opts) => cmd === 'gh' && args[0] === 'api' && args[1] !== 'user'
      ? json({ user: { login: 'stack-bot' }, body: 'Respuesta del humano:\n\nLautaro agreed.', html_url: prUrl })
      : base(cmd, args, opts))(exited.io.sh)
    assert.equal(await reanudarCommand({}, ISSUE, prUrl, exited.io), 0)
    assert.equal(exited.calls.filter(call => call.cmd === 'orca' && call.args[0] === 'terminal' && call.args[1] === 'create').length, 1)
    const relaunchedBrief = exited.files[path.join('/home', 'orca', 'briefs', 'orca-stack-212-reanudar.md')]
    assert.equal(relaunchedBrief, `Message from main: ${prUrl}\n\nOriginal ticket brief\nKeep this unchanged.\n`)

    // Refuses comment by another user
    const otherUser = harness({ pr: true })
    otherUser.io.sh = ((base) => (cmd, args, opts) => cmd === 'gh' && args[0] === 'api' && args[1] !== 'user'
      ? json({ user: { login: 'someone-else' }, body: 'Respuesta de main: nope.', html_url: prUrl })
      : base(cmd, args, opts))(otherUser.io.sh)
    await assert.rejects(() => reanudarCommand({}, ISSUE, prUrl, otherUser.io), /cuenta del stack/)

    // Refuses comment without Respuesta prefix
    const badPrefix = harness({ pr: true })
    badPrefix.io.sh = ((base) => (cmd, args, opts) => cmd === 'gh' && args[0] === 'api' && args[1] !== 'user'
      ? json({ user: { login: 'stack-bot' }, body: 'Consulta: need help.', html_url: prUrl })
      : base(cmd, args, opts))(badPrefix.io.sh)
    await assert.rejects(() => reanudarCommand({}, ISSUE, prUrl, badPrefix.io), /Respuesta de main:.*Respuesta del humano:/)
  })

  test('Rule 3: reanudar refuses a PR comment URL from another PR or repo or when no PR is open', async () => {
    // Another repo
    const foreignRepo = harness({ pr: true })
    await assert.rejects(() => reanudarCommand({}, ISSUE, 'https://github.com/otro/repo/pull/81#issuecomment-6205678817', foreignRepo.io), error => {
      assert.match(error.message, /Gagaismo\/orca-stack/)
      return true
    })

    // Another PR (PR #99 instead of #81)
    const foreignPr = harness({ pr: true })
    foreignPr.io.sh = ((base) => (cmd, args, opts) => cmd === 'gh' && args[0] === 'api' && args[1] !== 'user'
      ? json({ user: { login: 'stack-bot' }, body: 'Respuesta de main: ok.', html_url: 'https://github.com/Gagaismo/orca-stack/pull/99#issuecomment-6205678817' })
      : base(cmd, args, opts))(foreignPr.io.sh)
    await assert.rejects(() => reanudarCommand({}, ISSUE, 'https://github.com/Gagaismo/orca-stack/pull/99#issuecomment-6205678817', foreignPr.io), error => {
      assert.match(error.message, /PR abierto de #212.*#81/)
      return true
    })

    // No PR open for this issue (pr: false)
    const noPr = harness({ pr: false })
    noPr.io.sh = ((base) => (cmd, args, opts) => cmd === 'gh' && args[0] === 'api' && args[1] !== 'user'
      ? json({ user: { login: 'stack-bot' }, body: 'Respuesta de main: ok.', html_url: 'https://github.com/Gagaismo/orca-stack/pull/81#issuecomment-6205678817' })
      : base(cmd, args, opts))(noPr.io.sh)
    await assert.rejects(() => reanudarCommand({}, ISSUE, 'https://github.com/Gagaismo/orca-stack/pull/81#issuecomment-6205678817', noPr.io), error => {
      assert.match(error.message, /no tiene un PR abierto/)
      return true
    })
  })

  test('Preserve reanudarCommand: existing issue comment resume and relaunch workflows remain unchanged', async () => {
    // Normal issue comment resume on paused worker
    const h = harness()
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.equal(h.sends().length, 1)

    // Issue comment with an already open PR is still refused with rebote hint
    const openPr = harness({ pr: true })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, openPr.io), /orca-stack rebote 81/)
    assert.equal(openPr.sends().length, 0)
  })
})

describe('reanudar: the pi profile (#276)', () => {
  // An exited pi worker: the relaunch path is where the profile decides the model.
  const piHarness = pin => {
    const h = harness({ state: null, agent: 'pi', screen: ['PS C:\\wt\\orca-stack-212>'] })
    h.files[STORE] = JSON.stringify(PROFILES)
    if (pin) h.files[PIN] = pinFile(pin)
    h.io.gentleSkills = () => '/skills'
    return h
  }
  const launches = h => h.calls.filter(({ cmd, args }) => cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create')

  test('issue 276 Rule 4: a pi worker relaunches with the orchestrator model and thinking of its pin', async () => {
    const h = piHarness('opus-sonnet')
    assert.equal(await reanudarCommand({ dryRun: true }, ISSUE, URL, h.io), 0)
    assert.ok(h.outputs.includes('[simulaci\u00F3n] perfil de Pi: opus-sonnet (fuente: pin)'), h.outputs.join('\n'))
    assert.ok(h.outputs.some(line => line.startsWith('Lanzador (pi):') && line.includes("--model 'claude-bridge/claude-opus-5-5' --thinking high")), h.outputs.join('\n'))
  })

  test('issue 276 Rule 4: a pi worker with no pin and no profile refuses as despachar does', async () => {
    const h = piHarness()
    const before = Object.keys(h.files)
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), /Falta el perfil de Pi: pas\u00E1 --perfil-pi <nombre> \(hay: opus-sonnet, OpusFull\)/)
    assert.equal(launches(h).length, 0)
    assert.deepEqual(Object.keys(h.files), before)
  })

  test('issue 276 Rule 4: a pin naming a missing profile refuses and points at --perfil-pi, which replaces it', async () => {
    const h = piHarness('opus-haiku')
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), /No existe el perfil de Pi "opus-haiku".*Repet\u00ED con --perfil-pi <nombre>/)
    assert.equal(launches(h).length, 0)
    const flagged = piHarness('opus-haiku')
    assert.equal(await reanudarCommand({ perfilPi: 'OpusFull', dryRun: true }, ISSUE, URL, flagged.io), 0)
    assert.ok(flagged.outputs.includes('[simulaci\u00F3n] perfil de Pi: OpusFull (fuente: flag)'), flagged.outputs.join('\n'))
    await assert.rejects(() => reanudarCommand({ perfilPi: 'OpusFull', dryRun: true }, ISSUE, URL, harness({ state: 'done', agent: 'codex' }).io), /solo vale para el agente pi/)
  })

  test('issue 293 Rule 2: a paused pi gets the line with a stale pin, and --perfil-pi rewrites the pin on the send and the relaunch paths', async () => {
    // git ignores the pin (writePin asks it) and does not track it.
    const ignoring = h => {
      const sh = h.io.sh
      h.io.sh = (cmd, args, opts) => cmd === 'git' && args[0] === 'check-ignore' ? ok('') : cmd === 'git' && args[0] === 'ls-files' ? fail('') : sh(cmd, args, opts)
      return h
    }
    const idle = ['● PR opened.', '╭─ ✿ ────────────────────────────╮', '│ type, or / for commands        │', '╰────────────────────────────────╯', ' claude-opus-5-5 · high']
    const paused = () => {
      const h = harness({ agent: 'pi', screen: idle })
      h.files[STORE] = JSON.stringify(PROFILES)
      h.files[PIN] = pinFile('opus-haiku')
      return ignoring(h)
    }
    const plain = paused()
    assert.equal(await reanudarCommand({}, ISSUE, URL, plain.io), 0)
    assert.equal(plain.sends().length, 1)
    assert.equal(launches(plain).length, 0)
    assert.equal(JSON.parse(plain.files[PIN]).profile, 'opus-haiku')

    const flagged = paused()
    assert.equal(await reanudarCommand({ perfilPi: 'OpusFull' }, ISSUE, URL, flagged.io), 0)
    assert.equal(flagged.sends().length, 1)
    assert.equal(launches(flagged).length, 0)
    assert.equal(JSON.parse(flagged.files[PIN]).profile, 'OpusFull')

    // A --perfil-pi the CLI would not launch is refused before the line goes out, and the pin stays.
    const wrong = paused()
    await assert.rejects(() => reanudarCommand({ perfilPi: 'nope' }, ISSUE, URL, wrong.io), /No existe el perfil de Pi "nope"/)
    assert.equal(wrong.sends().length, 0)
    assert.equal(JSON.parse(wrong.files[PIN]).profile, 'opus-haiku')

    // Lautaro's decision on PR 347: "global" never replaces a stale pin, on the send and the relaunch paths: it refuses,
    // asks for a name, sends and launches nothing, and the pin stays.
    const STALE_GLOBAL = 'El worktree fija el perfil de Pi "opus-haiku", que ya no existe, y --perfil-pi global no lo reemplaza: pasá --perfil-pi <nombre> para fijar otro perfil en el worktree.'
    const globalPaused = paused()
    await assert.rejects(() => reanudarCommand({ perfilPi: 'global' }, ISSUE, URL, globalPaused.io), { message: STALE_GLOBAL })
    assert.equal(globalPaused.sends().length, 0)
    assert.equal(JSON.parse(globalPaused.files[PIN]).profile, 'opus-haiku')
    const globalExited = ignoring(piHarness('opus-haiku'))
    await assert.rejects(() => reanudarCommand({ perfilPi: 'global' }, ISSUE, URL, globalExited.io), { message: STALE_GLOBAL })
    assert.equal(launches(globalExited).length, 0)
    assert.equal(JSON.parse(globalExited.files[PIN]).profile, 'opus-haiku')

    // The relaunch path: the fake host shows no new pi session, so the launch is refused after it started, pin rewritten.
    const exited = ignoring(piHarness('opus-haiku'))
    exited.io.listFiles = () => []
    await assert.rejects(() => reanudarCommand({ perfilPi: 'opus-sonnet' }, ISSUE, URL, exited.io), /No observé una sesión nueva de Pi/)
    assert.equal(launches(exited).length, 1)
    assert.ok(launches(exited)[0].args.some(arg => arg.includes("--model 'claude-bridge/claude-opus-5-5' --thinking high")))
    assert.equal(JSON.parse(exited.files[PIN]).profile, 'opus-sonnet')
  })
})

describe('reanudar: an open PR whose bounce stopped (#292)', () => {
  const OLD = 'El issue #212 ya tiene un PR abierto (#81); usá `orca-stack rebote 81`.'
  const withPrView = (h, view) => {
    const original = h.io.sh
    h.io.sh = (cmd, args, opts) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && args[2] === '81' ? json(view) : original(cmd, args, opts)
    return h
  }

  test("issue #292 Rule 7: reanudar points to rebote --continuar when the open PR's last Rebote mark is on its head", async () => {
    const onHead = withPrView(harness({ pr: true }), { headRefOid: 'abc', comments: [{ body: 'Rebote conflicto: abc' }], reviews: [] })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, onHead.io), error =>
      error.message === `${OLD} Si el autor del rebote se cortó, usá orca-stack rebote 81 --continuar.`)
    assert.equal(onHead.sends().length, 0)
    const otherSha = withPrView(harness({ pr: true }), { headRefOid: 'def', comments: [{ body: 'Rebote: abc' }], reviews: [] })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, otherSha.io), error => error.message === OLD)
    assert.equal(otherSha.sends().length, 0)
    const ghDown = harness({ pr: true })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, ghDown.io), error => error.message === OLD)
    assert.equal(ghDown.sends().length, 0)
  })
})

describe('main-autonomo T1: reanudar picks the worker and trusts what orca-stack recorded', () => {
  const PI_IDLE = ['● PR opened.', '╭─ ✿ ────────────────────────────╮', '│ type, or / for commands        │', '╰────────────────────────────────╯']
  const briefLine = name => `Read and follow the brief in ${path.join('/home', 'orca', 'briefs', `${name}.md`)}`
  const term = (n, title, agentIdentity = title) => ({ handle: `term-${n}`, tabId: `tab-${n}`, leafId: `leaf-${n}`, title, agentIdentity, worktreePath: WT })
  const THREE = [term(1, 'codex'), term(2, 'claude'), term(3, 'codex')]
  const BRIEF_ONLY = [path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')]
  const sentTo = h => h.sends().map(({ args }) => args[args.indexOf('--terminal') + 1])
  const textOf = h => h.sends().map(({ args }) => args[args.indexOf('--text') + 1])
  const withRoot = (config, run) => async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orca-stack-main-autonomo-'))
    writeFileSync(path.join(root, '.orca-stack.json'), JSON.stringify({ setup: 'completo', modo: 'multiagente', ...config }))
    try {
      await run(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test('S5: with several done agents it resumes the terminal of the newest worker record, never a review or a subagent', async () => {
    const h = harness({
      terminals: THREE,
      agents: [
        { paneKey: 'tab-1:leaf-1', state: 'done', agentType: 'codex', prompt: briefLine('orca-stack-212'), updatedAt: 100 },
        { paneKey: 'tab-2:leaf-2', state: 'done', agentType: 'claude', prompt: briefLine('orca-stack-revision-81-claude'), updatedAt: 300 },
        { paneKey: 'tab-3:leaf-3', state: 'done', agentType: 'codex', prompt: `Message from main: ${URL} . Continue the ticket per your brief: ${BRIEF_PATH}.`, updatedAt: 200 },
        { paneKey: 'tab-9:leaf-9', parentPaneKey: 'tab-3:leaf-3', state: 'done', agentType: 'codex', prompt: briefLine('orca-stack-212'), updatedAt: 400 },
      ],
    })
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.deepEqual(sentTo(h), ['term-3'])
    assert.deepEqual(textOf(h), [LINE])
  })

  test('S5: --terminal <handle> overrides the choice', async () => {
    const agents = [1, 2, 3].map(n => ({ paneKey: `tab-${n}:leaf-${n}`, state: 'done', agentType: n === 2 ? 'claude' : 'codex' }))
    const h = harness({ terminals: THREE, agents })
    assert.equal(await reanudarCommand({ terminal: 'term-1' }, ISSUE, URL, h.io), 0)
    assert.deepEqual(sentTo(h), ['term-1'])
    assert.deepEqual(textOf(h), [LINE])
  })

  test('S5 negative: no worker record and no --terminal keeps the refusal, now naming --terminal and the handles', async () => {
    const agents = [1, 2, 3].map(n => ({ paneKey: `tab-${n}:leaf-${n}`, state: 'done', agentType: 'codex' }))
    const h = harness({ terminals: THREE, agents })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), error =>
      error.message === 'Hay 3 agentes done en el worktree de #212: no adivino a cuál reanudar. Elegí uno con --terminal <handle> (term-1, term-2, term-3).')
    assert.equal(h.sends().length, 0)
    assert.deepEqual(Object.keys(h.files), BRIEF_ONLY)
  })

  test('S5 negative: --terminal naming a terminal outside the worktree, or one without a done agent, is refused', async () => {
    const agents = [{ paneKey: 'tab-1:leaf-1', state: 'done', agentType: 'codex' }, { paneKey: 'tab-3:leaf-3', state: 'done', agentType: 'codex' }]
    const outside = harness({ terminals: THREE, agents })
    await assert.rejects(() => reanudarCommand({ terminal: 'term-9' }, ISSUE, URL, outside.io), error =>
      error.message === 'La terminal term-9 no está en el worktree de #212 (term-1, term-2, term-3): no reanudo.')
    const noAgent = harness({ terminals: THREE, agents })
    await assert.rejects(() => reanudarCommand({ terminal: 'term-2' }, ISSUE, URL, noAgent.io), error =>
      error.message === 'La terminal term-2 de #212 no tiene un agente en done (sin agente): no reanudo.')
    for (const h of [outside, noAgent]) {
      assert.equal(h.sends().length, 0)
      assert.deepEqual(Object.keys(h.files), BRIEF_ONLY)
    }
  })

  test('S6: a pi pane that Orca detects as claude is resumed as pi', withRoot({ agentes: { usa: ['pi'], preguntarAntes: [] } }, async root => {
    for (const agentType of ['pi', 'claude']) {
      const h = pinned(harness({ root, screen: PI_IDLE, terminals: [term(1, 'pi', 'claude')], agents: [{ paneKey: 'tab-1:leaf-1', state: 'done', agentType }] }))
      assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0, agentType)
      assert.deepEqual(sentTo(h), ['term-1'], agentType)
      assert.deepEqual(textOf(h), [LINE], agentType)
    }
  }))

  test('S6 PRESERVE: without a stack title, Orca\'s record and then its detected identity still decide', async () => {
    const h = harness({ terminals: [term(1, '✳ Brief', 'codex')], agents: [{ paneKey: 'tab-1:leaf-1', state: 'done', agentType: 'codex' }] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.deepEqual(sentTo(h), ['term-1'])
  })

  test('S3: resuming a paused worker or relaunching an exited one writes {"version":1,"granted":[]} in its git dir', async () => {
    const consent = path.join(ROOT, '.git', 'orca-stack', 'rdd-consentimiento.json')
    const paused = harness()
    assert.equal(await reanudarCommand({}, ISSUE, URL, paused.io), 0)
    assert.equal(paused.files[consent], '{"version":1,"granted":[]}\n')
    assert.ok(paused.outputs.includes(`Consentimiento RDD (política): ${consent} = {"version":1,"granted":[]}`))
    assert.ok(paused.calls.some(({ args, cwd }) => args.join(' ') === 'rev-parse --path-format=absolute --git-dir' && cwd === WT))
    const relaunch = harness({ state: null, screen: ['PS C:\\wt\\orca-stack-212>'] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, relaunch.io), 0)
    assert.equal(relaunch.files[consent], '{"version":1,"granted":[]}\n')
  })

  test('S3: reanudar keeps an existing policy file, so main\'s granted head survives a paused RDD review', async () => {
    const consent = path.join(ROOT, '.git', 'orca-stack', 'rdd-consentimiento.json')
    const h = harness()
    h.files[consent] = '{"version":1,"granted":["abc1234def"]}\n'
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.equal(h.files[consent], '{"version":1,"granted":["abc1234def"]}\n')
    assert.ok(h.outputs.includes(`Consentimiento RDD (política): dejo ${consent} como está.`))
  })

  test('S3 negative: with "humano" reanudar writes no consent file', withRoot({ agentes: { usa: ['codex'], preguntarAntes: [], codex: { rddConsentimiento: 'humano' } } }, async root => {
    const h = harness({ root })
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.equal(h.sends().length, 1)
    assert.ok(!Object.keys(h.files).some(file => file.endsWith('rdd-consentimiento.json')))
  }))

  // #357 (main-autonomo-2 S1): a paused agy behind its "esc to dismiss" splash, recorded on 2026-11-14 (Antigravity CLI 1.5.9).
  const SPLASH = ['\u{2503} Introducing Gemini 4 Hydrogen', '\u{2503} Our daily driver for rapid coding and dependable agentic execution!', '\u{2503} esc to dismiss']
  const AGY_PROMPT = ['Antigravity CLI 1.5.9', 'Gemini 4 Hydrogen (High)', '>']
  const ESC = '\u{1b}'
  const S1_LINE = `agy no recibi\u{f3} el brief. Peg\u{e1} en la terminal term-1 esta l\u{ed}nea: Read and follow the brief in ${BRIEF_PATH}`
  const agyHarness = ({ escs = 1, send } = {}) => {
    const h = harness({ agent: 'agy', screen: SPLASH, ...(send ? { send } : {}) })
    const original = h.io.sh
    let sentEscs = 0
    h.io.sh = (cmd, args, opts) => {
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'send' && args[args.indexOf('--text') + 1] === ESC) {
        sentEscs += 1
        h.calls.push({ cmd, args })
        return ok('')
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') {
        h.calls.push({ cmd, args })
        return json({ result: { terminal: { tail: sentEscs >= escs ? AGY_PROMPT : SPLASH } } })
      }
      return original(cmd, args, opts)
    }
    const escSends = () => h.sends().filter(({ args }) => args[args.indexOf('--text') + 1] === ESC)
    const lineSends = () => h.sends().filter(({ args }) => args[args.indexOf('--text') + 1] === LINE)
    const attempted = () => Object.keys(h.files).some(file => file.endsWith('reanudar.json'))
    return { ...h, escSends, lineSends, attempted }
  }

  test('S1: reanudar dismisses agy\'s splash with Esc and sends the resume line once to the empty prompt', async () => {
    const h = agyHarness()
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.deepEqual(h.escSends().map(({ args }) => args), [['terminal', 'send', '--terminal', 'term-1', '--text', ESC]])
    assert.equal(h.lineSends().length, 1)
    assert.ok(h.sends().indexOf(h.escSends()[0]) < h.sends().indexOf(h.lineSends()[0]))
  })

  test('S1 negative: a splash that stays after 3 Escs fails with the line to paste, sends no resume line and records no attempt', async () => {
    const h = agyHarness({ escs: Infinity })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), error => error.message === S1_LINE)
    assert.equal(h.escSends().length, 3)
    assert.equal(h.lineSends().length, 0)
    assert.equal(h.attempted(), false)
  })

  test('S1: agy with no delivery receipt fails with exactly the line to paste and never resends', async () => {
    const h = agyHarness({ send: ok('') })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), error => error.message === S1_LINE)
    assert.equal(h.lineSends().length, 1)
    assert.equal(h.attempted(), true)
    // The attempt is recorded: a second run with the same comment sends nothing.
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), /Ya intenté reanudar con el comentario 6205678817/)
    assert.equal(h.lineSends().length, 1)
  })

  test('S1 PRESERVE: codex with no delivery receipt keeps the no-resend guard message and gets no Esc', async () => {
    const h = harness({ send: ok('') })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), error =>
      error.message === 'No hay recibo de entrega de orca terminal send en term-1: la l\u{ed}nea pudo haber llegado. No la reenv\u{ed}o; revis\u{e1} la terminal antes de volver a reanudar.')
    assert.equal(h.sends().length, 1)
    assert.equal(h.sends()[0].args[h.sends()[0].args.indexOf('--text') + 1], LINE)
  })
})

describe('#431 reanudar: a worker an account switch left pending', () => {
  test('S8: a quota-stopped worker pending in its agent\'s episode is relaunched, even with a dirty worktree, instead of getting a line in its paused session', async () => {
    const h = harness({ screen: ["You've hit your usage limit."], dirty: ' M file.js\n' })
    const episode = path.join(ROOT, '.git', 'orca-stack', 'cuentas.json')
    h.files[episode] = JSON.stringify({ codex: { at: 1760616000000, exhausted: ['x1'], from: 'x1', to: 'x2', resumed: { 212: true } } })
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.ok(!h.sends().some(({ args }) => args.includes(LINE)))
    assert.equal(h.calls.filter(({ cmd, args }) => cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create').length, 1)
    assert.deepEqual(JSON.parse(h.files[episode]).codex.resumed, { 212: false })
  })
})

describe('#454 reanudar: the relaunch rebinds the Run task', () => {
  const RUN = 'run_084b4726f7fd'
  const TASKS = [{ id: 'task_f887345917b8', status: 'completed', title: '#417 pi' }, { id: 'task_b9ee2b19bb17', status: 'ready', title: '#212 pi' }]
  const START = ['orchestration', 'worker-start', '--run', RUN, '--task', 'task_b9ee2b19bb17', '--terminal', 'term-new', '--json']
  const withRun = (h, { tasks = TASKS, start = json({ ok: true, result: { taskId: 'task_new', dispatchId: 'ctx_new' } }) } = {}) => {
    const sh = h.io.sh
    h.io.sh = (cmd, args, opts) => {
      if (cmd === 'orca' && args[0] === 'orchestration') {
        h.calls.push({ cmd, args, cwd: opts?.cwd })
        if (args[1] === 'run-current') return json({ ok: true, result: { runId: RUN } })
        if (args[1] === 'task-list') return json({ ok: true, result: { runId: RUN, tasks } })
        if (args[1] === 'worker-start') return start
      }
      return sh(cmd, args, opts)
    }
    return h
  }
  const orchestration = h => h.calls.filter(({ cmd, args }) => cmd === 'orca' && args[0] === 'orchestration').map(({ args }) => args)
  const creates = h => h.calls.filter(({ cmd, args }) => cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create')
  // The #444 case: pi exited, its task "#<n> pi" is back to ready with its dispatch closed.
  const exitedPi = () => {
    const h = pinned(harness({ agent: 'pi', state: null, screen: ['PS C:\\wt\\orca-stack-212>'] }))
    h.io.gentleSkills = () => '/pi/skills'
    const sessionDir = path.join('/home', '.pi', 'agent', 'sessions', 'wt')
    const session = path.join(sessionDir, '2026-11-25T00-00-00-000Z_s.jsonl')
    h.io.listFiles = dir => (dir === path.dirname(sessionDir) ? [sessionDir] : dir === sessionDir ? [session] : [])
    h.io.modifiedAt = () => Number.MAX_SAFE_INTEGER
    h.files[session] = [JSON.stringify({ type: 'session', cwd: WT }), '{}', '{}', '{}', JSON.stringify({ type: 'message', message: { role: 'system', content: '<tools>\n- read' } }), JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall' }], stopReason: 'toolUse' } })].join('\n')
    return h
  }
  const exitedCodex = () => harness({ state: null, screen: ['PS C:\\wt\\orca-stack-212>'] })

  test('S1: an exited pi whose task "#212 pi" is ready launches without the brief, gets worker-start --run --task --terminal on the new terminal, then the single comment URL line', async () => {
    const h = withRun(exitedPi())
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.deepEqual(orchestration(h), [['orchestration', 'run-current', '--json'], ['orchestration', 'task-list', '--run', RUN, '--json'], START])
    assert.equal(creates(h).length, 1)
    assert.ok(!creates(h)[0].args.some(arg => /brief in/.test(arg)), creates(h)[0].args.join(' '))
    assert.deepEqual(h.sends().map(send => send.args.slice(2)), [['--terminal', 'term-new', '--text', LINE, '--enter', '--wait-submit', '10', '--json']])
    const created = h.calls.indexOf(creates(h)[0])
    const started = h.calls.findIndex(({ args }) => args[1] === 'worker-start')
    const sent = h.calls.indexOf(h.sends()[0])
    assert.ok(created < started && started < sent, `${created} ${started} ${sent}`)
    assert.ok(h.outputs.includes(`orca orchestration ${START.slice(1).join(' ')}`), h.outputs.join('\n'))
    assert.ok(h.outputs.includes(`Reanudación enviada a term-new (#212): ${LINE}`), h.outputs.join('\n'))
    assert.ok(h.outputs.some(line => line.startsWith('✔ pi despachado')), h.outputs.join('\n'))
  })

  test('S2: a TUI still open in done gets only the URL line, with no worker-start and no task-list', async () => {
    const h = withRun(harness(), { tasks: [{ id: 'task_212', status: 'ready', title: '#212 codex' }] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.deepEqual(h.sends().map(send => send.args.slice(2)), [['--terminal', 'term-1', '--text', LINE, '--enter', '--wait-submit', '10', '--json']])
    assert.deepEqual(orchestration(h), [])
    assert.equal(creates(h).length, 0)
  })

  test('S4: a failed worker-start, or an unconfirmed line after it, prints the error and the new terminal, exits non-zero, and a rerun does not relaunch a second time', async () => {
    const refused = { status: 1, stdout: JSON.stringify({ ok: false, error: { message: 'task_not_ready: Task task_212 cannot start' } }), stderr: '' }
    const h = withRun(exitedCodex(), { tasks: [{ id: 'task_212', status: 'ready', title: '#212 codex' }], start: refused })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), error => {
      assert.match(error.message, /task_not_ready: Task task_212 cannot start/)
      assert.match(error.message, /term-new/)
      return true
    })
    assert.deepEqual(orchestration(h).at(-1), ['orchestration', 'worker-start', '--run', RUN, '--task', 'task_212', '--terminal', 'term-new', '--json'])
    assert.equal(creates(h).length, 1)
    assert.equal(h.sends().length, 0)
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), /Ya intent\u00E9 reanudar con el comentario 6205678817/)
    assert.equal(creates(h).length, 1)
    assert.equal(orchestration(h).filter(args => args[1] === 'worker-start').length, 1)

    const unconfirmed = withRun(harness({ state: null, screen: ['PS C:\\wt\\orca-stack-212>'], send: ok('') }), { tasks: [{ id: 'task_212', status: 'ready', title: '#212 codex' }] })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, unconfirmed.io), error =>
      error.message === 'No hay recibo de entrega de orca terminal send en term-new: la l\u{ed}nea pudo haber llegado. No la reenv\u{ed}o; revis\u{e1} la terminal antes de volver a reanudar.')
    assert.deepEqual(unconfirmed.sends().map(send => send.args[send.args.indexOf('--text') + 1]), [LINE])
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, unconfirmed.io), /Ya intent\u00E9 reanudar con el comentario 6205678817/)
    assert.equal(creates(unconfirmed).length, 1)

    const unknown = { status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'outcome_unknown', message: 'worker-start timed out' } }), stderr: '' }
    const lost = withRun(exitedCodex(), { tasks: [{ id: 'task_212', status: 'ready', title: '#212 codex' }], start: unknown })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, lost.io), error =>
      error.message === `orca orchestration worker-start falló: worker-start timed out\nEl resultado de worker-start es desconocido (outcome_unknown): el dispatch de la terminal nueva term-new puede haber arrancado; no relanzo. Comprobalo con \`orca orchestration task-list --run ${RUN} --json\`.`)
    assert.equal(lost.sends().length, 0)

    const noSession = withRun(exitedPi())
    noSession.io.listFiles = () => []
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, noSession.io), error =>
      error.message.startsWith('No observé una sesión nueva de Pi después del lanzamiento') && error.message.endsWith('; no doy el lanzamiento por iniciado. Terminal: term-new.'))
    assert.equal(orchestration(noSession).filter(args => args[1] === 'worker-start').length, 1)
    assert.equal(noSession.sends().length, 0)
  })

  test('#463 Rule 7: reanudar --help and the manual describe the ready, no-task and still-dispatched cases and drop the #457 warning', async () => {
    const oldLog = console.log
    let help = ''
    console.log = value => { help += `${value}\n` }
    try {
      await main(['reanudar', '--help'])
    } finally {
      console.log = oldLog
    }
    const manual = readFileSync(path.join(PACKAGE_ROOT, 'docs', 'manual.md'), 'utf8')
    const section = manual.slice(manual.indexOf('#### `reanudar`'), manual.indexOf('\n#### ', manual.indexOf('#### `reanudar`') + 1))
    for (const [name, text] of [['help', help], ['manual', section]]) {
      assert.match(text, /worker-start --run <run> --task <task_id> --terminal <handle>/, name)
      assert.match(text, /--task-title "#<(?:issue|n)> <agente>"/, name)
      assert.match(text, /#<(?:issue|n)> <agente> reanudado/, name)
      assert.doesNotMatch(text, /⚠ La tarea|relancé sin ligarla/, name)
    }
  })

  const BRIEF = path.join('/home', 'orca', 'briefs', 'orca-stack-212-reanudar.md')
  const OBJECTIVE = `orca-stack ${path.basename(ROOT)}: tickets despachados por main`
  const create = (title, run = RUN, terminal = 'term-new') => ['orchestration', 'worker-start', '--run', run, '--terminal', terminal, '--spec-file', BRIEF, '--task-title', title, '--json']
  const LISTED = [['orchestration', 'run-current', '--json'], ['orchestration', 'task-list', '--run', RUN, '--json']]
  const typedBriefs = h => h.sends().filter(send => /brief/.test(String(send.args[send.args.indexOf('--text') + 1] ?? '')))

  test('#463 Rule 1: with task "#212 codex" ready it rebinds it with worker-start --task and creates no task', async () => {
    const h = withRun(exitedCodex(), { tasks: [{ id: 'task_212', status: 'ready', title: '#212 codex' }] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.deepEqual(orchestration(h), [...LISTED, ['orchestration', 'worker-start', '--run', RUN, '--task', 'task_212', '--terminal', 'term-new', '--json']])
    assert.ok(!orchestration(h).some(args => args.includes('--task-title') || args[1] === 'run-create'))
    assert.deepEqual(h.sends().map(send => send.args[send.args.indexOf('--text') + 1]), [LINE])
  })

  test('#463 Rule 2: with no task "#212 codex" in the Run, or only a completed one, it creates the supervised task "#212 codex" in the bound Run', async () => {
    const others = [{ id: 'task_1', status: 'ready', title: '#212 pi' }, { id: 'task_2', status: 'ready', title: '#213 codex' }, { id: 'task_3', status: 'ready', title: '#212 codex (fork)' }]
    for (const tasks of [others, [{ id: 'task_212', status: 'completed', title: '#212 codex' }]]) {
      const h = withRun(exitedCodex(), { tasks })
      assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
      assert.deepEqual(orchestration(h), [...LISTED, ['orchestration', 'run-current', '--json'], create('#212 codex')])
      assert.equal(creates(h).length, 1)
      assert.deepEqual(typedBriefs(h), [])
      assert.ok(h.files[BRIEF].startsWith(`Message from main: ${URL}\n\n`))
    }
  })

  test('#463 Rule 2: with no Run bound to main it creates one with run-create, as despachar does, and the task "#212 codex" in it', async () => {
    const h = exitedCodex()
    const sh = h.io.sh
    h.io.sh = (cmd, args, opts) => {
      if (cmd === 'orca' && args[0] === 'orchestration' && args[1] === 'run-current') {
        h.calls.push({ cmd, args, cwd: opts?.cwd })
        return json({ ok: true, result: { runId: null } })
      }
      if (cmd === 'orca' && args[0] === 'orchestration' && args[1] === 'run-create') {
        h.calls.push({ cmd, args, cwd: opts?.cwd })
        return json({ ok: true, result: { run: { id: 'run_new' } } })
      }
      return sh(cmd, args, opts)
    }
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.deepEqual(orchestration(h).slice(-3), [['orchestration', 'run-current', '--json'], ['orchestration', 'run-create', '--objective', OBJECTIVE, '--json'], create('#212 codex', 'run_new')])
  })

  test('#463 Rule 3: with task "#212 codex" still dispatched it creates the supervised task "#212 codex reanudado" and prints no still-dispatched warning', async () => {
    const h = withRun(exitedCodex(), { tasks: [{ id: 'task_212', status: 'dispatched', title: '#212 codex', dispatchId: 'ctx_old212', assignee: 'term-old' }] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.deepEqual(orchestration(h), [...LISTED, ['orchestration', 'run-current', '--json'], create('#212 codex reanudado')])
    assert.equal(creates(h).length, 1)
    assert.deepEqual(h.outputs.filter(line => line.includes('sigue dispatched')), [])
    assert.ok(h.files[BRIEF].startsWith(`Message from main: ${URL}\n\n`))
  })

  test('#463 Rule 4: in each case --dry-run prints the commands with the [simulación] prefix, carries the comment URL and runs nothing', async () => {
    const cases = [
      [[{ id: 'task_212', status: 'ready', title: '#212 codex' }], `[simulación] orca orchestration worker-start --run ${RUN} --task task_212 --terminal <terminal> --json`],
      [[], `[simulación] orca orchestration worker-start --run <run> --terminal <terminal> --spec-file ${BRIEF} --task-title "#212 codex" --json`],
      [[{ id: 'task_212', status: 'dispatched', title: '#212 codex' }], `[simulación] orca orchestration worker-start --run <run> --terminal <terminal> --spec-file ${BRIEF} --task-title "#212 codex reanudado" --json`],
    ]
    for (const [tasks, start] of cases) {
      const h = withRun(exitedCodex(), { tasks })
      assert.equal(await reanudarCommand({ dryRun: true }, ISSUE, URL, h.io), 0)
      assert.ok(h.outputs.includes(start), h.outputs.join('\n'))
      assert.ok(h.outputs.some(line => line.startsWith('[simulación] orca terminal create')), h.outputs.join('\n'))
      assert.ok(h.outputs.some(line => line.includes(`Message from main: ${URL}`)), h.outputs.join('\n'))
      assert.deepEqual(orchestration(h), LISTED)
      assert.equal(creates(h).length, 0)
      assert.equal(h.sends().length, 0)
      assert.equal(h.files[BRIEF], undefined)
    }
  })

  test('#463 Rule 5: a failed worker-start of a new task fails naming Orca\'s error and leaves the issue\'s worktree as it was', async () => {
    const refused = { status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'terminal_not_found', message: 'terminal term-new is not a known agent terminal' } }), stderr: '' }
    for (const tasks of [[], [{ id: 'task_212', status: 'dispatched', title: '#212 codex' }]]) {
      const h = withRun(exitedCodex(), { tasks, start: refused })
      await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), error => error.message.includes('terminal term-new is not a known agent terminal'))
      assert.equal(orchestration(h).filter(args => args[1] === 'worker-start').length, 1)
      assert.equal(h.sends().length, 0)
      assert.deepEqual(h.calls.filter(({ cmd, args }) => cmd === 'git' && !['rev-parse', 'remote', 'worktree', 'status'].includes(args[0])), [])
      assert.deepEqual(Object.keys(h.files).filter(file => file.startsWith(WT)), [])
    }
  })

  test('#463 Rule 6: with no task "#212 pi" in the Run, a pi that comes up waiting with an empty input is stopped and launched once more on the same task, and the relaunch succeeds on the second launch\'s session', async () => {
    const h = withRun(exitedPi(), { tasks: [{ id: 'task_2', status: 'ready', title: '#213 pi' }] })
    let clock = 1760616000000
    let created = 0
    let sessionAt = 0
    h.io.now = () => clock
    h.io.modifiedAt = () => sessionAt
    const listFiles = h.io.listFiles
    h.io.listFiles = dir => (created >= 2 ? listFiles(dir) : [])
    const waiting = ['pi v1.5.2', '', '─ ✿ waiting for input ─── INSERT ─', '', '─'.repeat(40), '~/wt/orca-stack-212 (orca-stack-212)']
    const sh = h.io.sh
    h.io.sh = (cmd, args, opts) => {
      if (cmd === 'orca' && args[0] === 'orchestration' && args[1] === 'worker-stop') {
        h.calls.push({ cmd, args, cwd: opts?.cwd })
        clock += 60000
        return json({ ok: true, result: { processAction: 'closed_agent_terminal' } })
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create') {
        h.calls.push({ cmd, args, cwd: opts?.cwd })
        created += 1
        if (created === 2) sessionAt = clock + 1000
        return json({ result: { handle: `term-p${created}` } })
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read' && args[args.indexOf('--terminal') + 1].startsWith('term-p')) {
        h.calls.push({ cmd, args, cwd: opts?.cwd })
        return json({ result: { terminal: { tail: waiting } } })
      }
      return sh(cmd, args, opts)
    }
    assert.equal(await reanudarCommand({}, ISSUE, URL, h.io), 0)
    assert.equal(creates(h).length, 2)
    assert.deepEqual(h.calls.filter(({ cmd, args }) => cmd === 'orca' && args[0] === 'terminal' && args[1] === 'close'), [])
    assert.deepEqual(orchestration(h), [
      ...LISTED,
      ['orchestration', 'run-current', '--json'],
      create('#212 pi', RUN, 'term-p1'),
      ['orchestration', 'worker-stop', '--dispatch', 'ctx_new', '--json'],
      ['orchestration', 'worker-start', '--run', RUN, '--task', 'task_new', '--retry-of', 'ctx_new', '--terminal', 'term-p2', '--json'],
    ])
    assert.ok(h.outputs.some(line => line.startsWith('✔ pi despachado')), h.outputs.join('\n'))
  })

  const warned = h => h.outputs.filter(line => line.startsWith('⚠ La tarea'))

  test('#457 Rule 4: a ready task "#212 codex" is rebound and no matching task relaunches, both with no still-dispatched warning', async () => {
    const ready = withRun(exitedCodex(), { tasks: [{ id: 'task_212', status: 'ready', title: '#212 codex' }] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, ready.io), 0)
    assert.equal(orchestration(ready).filter(args => args[1] === 'worker-start').length, 1)
    assert.deepEqual(warned(ready), [])
    const none = withRun(exitedCodex(), { tasks: [{ id: 'task_213', status: 'dispatched', title: '#213 codex', dispatchId: 'ctx_213' }] })
    assert.equal(await reanudarCommand({}, ISSUE, URL, none.io), 0)
    assert.equal(creates(none).length, 1)
    assert.deepEqual(warned(none), [])
  })
})

describe('#364 reanudar: a pi whose local gentle-pi checkout lacks its Gentle AI binary', () => {
  const MISSING = { status: 'fail', detail: 'falta C:\\gs\\.gentle-ai\\v4.6.0\\gentle-ai.exe: sin \u00E9l pi no puede pushear ni correr el review RDD; instalalo con `cd C:\\gs && node scripts/install-gentle-ai.mjs`' }

  test('issue 364 rule 3: reanudar refuses an exited or a paused pi with the doctor message before touching a terminal', async () => {
    for (const state of [null, 'done']) {
      const h = pinned(harness({ agent: 'pi', state, screen: ['PS C:\\wt\\orca-stack-212>'] }))
      h.io.gentleSkills = () => '/pi/skills'
      h.io.gentleAiBinary = async () => MISSING
      const before = JSON.stringify(h.files)
      await assert.rejects(() => reanudarCommand({}, ISSUE, URL, h.io), { message: `No lanzo a pi, binario Gentle AI de gentle-pi: ${MISSING.detail}.` }, String(state))
      assert.equal(h.calls.some(({ cmd, args }) => cmd === 'orca' && ['create', 'send', 'worker-start', 'close'].includes(args[1])), false, String(state))
      assert.equal(JSON.stringify(h.files), before, String(state))
    }
  })
})
