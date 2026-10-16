import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { main } from '../src/cli.mjs'
import { upsertBlock } from '../src/marker.mjs'
import { reanudarCommand } from '../src/reanudar.mjs'
import { policyBlock } from '../src/templates.mjs'
import { PACKAGE_ROOT } from '../src/util.mjs'

const ISSUE = '212'
const URL = 'https://github.com/Gagaismo/orca-stack/issues/212#issuecomment-6205678817'
const LINE = `Message from main: ${URL} . Continue the ticket per your brief.`
const ROOT = process.cwd()
const WT = path.join(path.dirname(ROOT), 'orca-stack-212')
const sendReceipt = { status: 0, stdout: JSON.stringify({ ok: true, result: { send: { accepted: true, prompt: { requestId: 'request-1', stages: ['input_accepted'], observation: 'supported' } } } }), stderr: '' }
const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const ok = stdout => ({ status: 0, stdout, stderr: '' })
const fail = stderr => ({ status: 1, stdout: '', stderr })

const harness = ({ root = ROOT, home = '/home', state = 'done', agent = 'codex', screen = ['\u{273b} Baked for 2m 5s'], dirty = '', pr = false, comment = {}, send = sendReceipt, psDown = false, dryRun = false, agents, terminals, brief, now = () => 1760616000000 } = {}) => {
  const outputs = []
  const calls = []
  const files = {
    [path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')]: brief ?? 'Original ticket brief\nKeep this unchanged.\n',
  }
  if (brief === false) delete files[path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')]
  const io = {
    cwd: root, home, win: false, now, exists: file => file in files,
    readFile: file => { if (!(file in files)) throw new Error(`ENOENT ${file}`); return files[file] },
    writeFile: (file, content) => { files[file] = content }, rename: (from, to) => { files[to] = files[from]; delete files[from] },
    mkdirp: () => {}, sleep: async () => {}, out: line => outputs.push(line),
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
        return json({ result: { terminal: { tail: handle === 'term-new' ? ['\u{2722} Churning... (1m 2s)'] : screen } } })
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'send') {
        const line = args[args.indexOf('--text') + 1]
        return line?.startsWith('Read and follow the brief in') ? json({ result: { send: { turnStarted: true } } }) : send
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create') return json({ result: { handle: 'term-new' } })
      return fail(`unexpected call: ${cmd} ${args.join(' ')}`)
    },
  }
  const sends = () => calls.filter(({ cmd, args }) => cmd === 'orca' && args[0] === 'terminal' && args[1] === 'send')
  return { io, files, outputs, calls, sends, dryRun }
}

describe('orca-stack reanudar (#214)', () => {
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
    assert.equal(shell.sends().length, 1)
    assert.notEqual(shell.sends()[0].args[shell.sends()[0].args.indexOf('--text') + 1], LINE)
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
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, working.io), /avisar/)
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
    assert.ok(dry.outputs.some(line => line.includes('Read and follow the brief in') && line.includes('orca-stack-212-reanudar.md')))
    assert.ok(dry.outputs.some(line => line.includes(`Message from main: ${URL}`)))
    assert.equal(dry.files[path.join('/home', 'orca', 'briefs', 'orca-stack-212.md')], 'Original ticket brief\nKeep this unchanged.\n')
    const dirty = harness({ state: null, screen: ['PS C:\\wt\\orca-stack-212>'], dirty: ' M file.js\n' })
    await assert.rejects(() => reanudarCommand({}, ISSUE, URL, dirty.io), /sucio/)
    assert.equal(dirty.sends().length, 0)
    const needsConfirmation = harness({ state: null, agent: 'codex-cc', screen: ['PS C:\\wt\\orca-stack-212>'], dryRun: true })
    await assert.rejects(() => reanudarCommand({ dryRun: true }, ISSUE, URL, needsConfirmation.io), /preguntarAntes/)

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
    assert.match(brief, /After posting a Consulta:, the next action is a tool call on work that is not blocked/)
  })

  test('Rule 10: contract names pause recovery and init renders the managed block into AGENTS', () => {
    const contract = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'CONTRATO.md'), 'utf8')
    assert.ok(contract.includes('worker-en-pausa #<n> <agente>'))
    assert.match(contract, /`orca-stack avisar` y `orca-stack reanudar` son las \u00FAnicas formas en que main llega a una terminal de worker/)
    assert.ok(contract.includes('orca-stack reanudar <issue> <url-del-comentario>'))
    const init = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'orca-stack.mjs'), 'init'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    const agents = readFileSync(path.join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8')
    assert.ok(agents.includes('worker-en-pausa #<n> <agente>'))
    const block = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md' })
    assert.equal(upsertBlock(agents, block), agents, 'init rendered the current managed contract block')
  })
})
