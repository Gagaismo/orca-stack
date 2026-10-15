import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { avisarCommand } from '../src/avisar.mjs'
import { main } from '../src/cli.mjs'
import { renderBrief } from '../src/despacho.mjs'
import { PACKAGE_ROOT } from '../src/util.mjs'

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = stdout => ({ status: 0, stdout, stderr: '' })

const URL42 = 'https://github.com/Gagaismo/orca-stack/issues/42#issuecomment-1001'
const LINE42 = `Message from main: ${URL42}`
const RUNNING = ['⏺ Reading src/app.ts', '✢ Churning… (1m 2s · ↓ 3.1k tokens)', '────', '❯ ', '────', '  ⏵⏵ bypass permissions on']
const SETTLED = ['⏺ Done.', '✻ Baked for 2m 5s', '────', '❯ ', '────', '  ⏵⏵ bypass permissions on']
const RECEIPT = { ok: true, result: { send: { handle: 'term_new', accepted: true, prompt: { requestId: 'req-1', stages: ['input_accepted'], provider: 'claude', observation: 'supported' } } } }

const terminal = (handle, { identity = 'claude', title = '✳ Brief' } = {}) => ({
  handle, tabId: `tab-${handle}`, leafId: `leaf-${handle}`, title, agentIdentity: identity, worktreePath: '/wt/orca-stack-42',
})
const agent = (handle, state, agentType = 'claude') => ({ paneKey: `tab-${handle}:leaf-${handle}`, state, agentType })

// A fake runner in the style of the dispatch tests: every call is recorded, answers come from the scenario.
const fakeIo = ({
  terminals = [terminal('term_new')],
  agents = [agent('term_new', 'working')],
  agentsAfter,
  screens = { term_new: RUNNING },
  comment = { user: { login: 'Stack-Bot' }, html_url: URL42, body: 'Respuesta de main: use the SECRET-ANSWER helper' },
  user = 'stack-bot',
  linkedIssue = '42',
  prHead,
  send = json(RECEIPT),
} = {}) => {
  const calls = []
  const outputs = []
  let psReads = 0
  const io = {
    cwd: '/repo',
    home: '/home',
    out: message => outputs.push(message),
    sh: (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'git' && args.includes('--git-common-dir')) return okRes('/repo/.git\n/repo/.git\n/repo\n')
      if (cmd === 'git' && args[0] === 'remote') return okRes('https://github.com/Gagaismo/orca-stack.git\n')
      if (cmd === 'gh' && args[0] === 'api' && args[1] === 'user') return json({ login: user })
      if (cmd === 'gh' && args[0] === 'api') return json(comment)
      if (cmd === 'gh' && args[0] === 'pr') return prHead ? json({ headRefName: prHead }) : { status: 1, stdout: '', stderr: 'Could not resolve to a PullRequest' }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'list') {
        const selector = args[args.indexOf('--worktree') + 1]
        if (selector === `issue:${linkedIssue}` || (prHead && selector === `branch:${prHead}`)) return json({ ok: true, result: { terminals } })
        return { status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'selector_not_found', message: 'selector_not_found' } }), stderr: '' }
      }
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') {
        psReads += 1
        return json({ ok: true, result: { worktrees: [{ path: '/wt/orca-stack-42', repo: 'orca-stack', linkedIssue: 42, agents: psReads > 1 && agentsAfter ? agentsAfter : agents }] } })
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') {
        const handle = args[args.indexOf('--terminal') + 1]
        return json({ ok: true, result: { terminal: { handle, tail: screens[handle] ?? [], source: 'screen' } } })
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'send') return send
      return { status: 1, stdout: '', stderr: `unexpected call: ${cmd} ${args.join(' ')}` }
    },
  }
  const sends = () => calls.filter(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'send')

  return { io, calls, outputs, sends }
}

describe('avisar', () => {
  test('Rule 1: a claude worker with a turn running on #42 gets exactly one line with the URL and no comment text', async () => {
    const env = fakeIo()
    assert.equal(await avisarCommand({}, '42', URL42, env.io), 0)
    assert.equal(env.sends().length, 1)
    const send = env.sends()[0]
    assert.deepEqual(send.slice(3), ['--terminal', 'term_new', '--text', LINE42, '--enter', '--wait-submit', '10', '--json'])
    assert.ok(!LINE42.includes('\n'))
    assert.ok(!send.join(' ').includes('SECRET-ANSWER'))
    assert.ok(env.calls.some(call => call.join(' ') === 'orca terminal list --worktree issue:42 --json'))
    // "042" names the same issue.
    const padded = fakeIo()
    assert.equal(await avisarCommand({}, '042', URL42, padded.io), 0)
    assert.equal(padded.sends().length, 1)
  })

  test('Rule 2: a settled turn is refused with the reason and nothing is sent', async () => {
    const settled = fakeIo({ agents: [agent('term_new', 'done')], screens: { term_new: SETTLED } })
    await assert.rejects(() => avisarCommand({}, '42', URL42, settled.io), /turno del worker de #42 ya termin/)
    assert.equal(settled.sends().length, 0)

    // Orca still says working, but the screen shows a settled turn: the positive screen signal is missing.
    const stale = fakeIo({ screens: { term_new: SETTLED } })
    await assert.rejects(() => avisarCommand({}, '42', URL42, stale.io), /No veo el turno en curso/)
    assert.equal(stale.sends().length, 0)

    // The turn settles between the checks and the send: the second state read stops it.
    const raced = fakeIo({ agentsAfter: [agent('term_new', 'done')] })
    await assert.rejects(() => avisarCommand({}, '42', URL42, raced.io), /cambi/)
    assert.equal(raced.sends().length, 0)

    // The turn settles after the send: Orca reports a new turn, and avisar says so instead of claiming a mid-turn line.
    const late = fakeIo({ send: json({ ok: true, result: { send: { ...RECEIPT.result.send, prompt: { ...RECEIPT.result.send.prompt, stages: ['input_accepted', 'turn_started'] } } } }) })
    assert.equal(await avisarCommand({}, '42', URL42, late.io), 0)
    assert.ok(late.outputs.some(line => /turno nuevo/.test(line)))
  })

  test('Rule 3: a shell prompt or a dialog on the terminal is refused and nothing is sent', async () => {
    const scenarios = [
      [{ screens: { term_new: [...RUNNING.slice(0, 2), 'PS C:\\wt\\orca-stack-42>'] } }, /shell/],
      [{ agents: [agent('term_new', 'waiting')] }, /di[aá]logo/],
      [{ agents: [agent('term_new', 'blocked')] }, /di[aá]logo/],
      [{ screens: { term_new: [...RUNNING.slice(0, 2), ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'] } }, /di[aá]logo/],
      [{ terminals: [terminal('term_shell', { identity: null, title: 'powershell.exe' })], agents: [] }, /shell/],
    ]
    for (const [scenario, reason] of scenarios) {
      const env = fakeIo(scenario)
      await assert.rejects(() => avisarCommand({}, '42', URL42, env.io), reason)
      assert.equal(env.sends().length, 0)
    }
  })

  test('Rule 4: a Pi worker is refused, saying Pi re-reads the comments before its PR', async () => {
    for (const pi of [terminal('term_pi', { identity: 'pi', title: 'pi' }), terminal('term_pi', { identity: null, title: 'pi' })]) {
      const env = fakeIo({ terminals: [pi], agents: [], screens: {} })
      await assert.rejects(() => avisarCommand({}, '42', URL42, env.io), /Pi relee los comentarios antes de abrir su PR/)
      assert.equal(env.sends().length, 0)
    }
  })

  test("Rule 5: a codex or agy worker is refused until that agent's Enter test passes", async () => {
    for (const identity of ['codex', 'antigravity']) {
      const env = fakeIo({ terminals: [terminal('term_x', { identity })], agents: [agent('term_x', 'working', identity)], screens: { term_x: RUNNING } })
      await assert.rejects(() => avisarCommand({}, '42', URL42, env.io), new RegExp(`${identity}.*prueba de Enter`))
      assert.equal(env.sends().length, 0)
    }
  })

  test("Rule 6: after a rebote left two terminals, the line goes to the relaunched author's live terminal", async () => {
    const env = fakeIo({
      linkedIssue: 'none',
      prHead: 'Gagaismo/orca-stack-42',
      terminals: [terminal('term_old'), terminal('term_new')],
      agents: [agent('term_old', 'done'), agent('term_new', 'working')],
      screens: { term_old: SETTLED, term_new: RUNNING },
      comment: { user: { login: 'stack-bot' }, html_url: 'https://github.com/Gagaismo/orca-stack/pull/57#issuecomment-2002' },
    })
    const prUrl = 'https://github.com/Gagaismo/orca-stack/pull/57#issuecomment-2002'
    assert.equal(await avisarCommand({}, '57', prUrl, env.io), 0)
    assert.ok(env.calls.some(call => call.join(' ') === 'orca terminal list --worktree branch:Gagaismo/orca-stack-42 --json'))
    assert.equal(env.sends().length, 1)
    assert.equal(env.sends()[0][env.sends()[0].indexOf('--terminal') + 1], 'term_new')
  })

  test('Rule 7: without a submit receipt it reports the failure and does not resend', async () => {
    const scenarios = [
      [{ status: 1, stdout: '', stderr: 'transport closed' }, /pudo haber llegado.*No la reenv/s],
      [json({ ok: true, result: { send: { ...RECEIPT.result.send, prompt: { ...RECEIPT.result.send.prompt, observation: 'permission' } } } }), /pudo haber llegado/],
      [{ status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'incompatible_runtime', message: 'This Orca host does not support --wait-submit. No input was sent; update Orca.' } }), stderr: '' }, /no envi[oó] nada/],
      [json({ ok: true, result: { send: { handle: 'term_new', accepted: false, refusedReason: 'not writable' } } }), /no envi[oó] nada/],
    ]
    for (const [send, reason] of scenarios) {
      const env = fakeIo({ send })
      await assert.rejects(() => avisarCommand({}, '42', URL42, env.io), reason)
      assert.equal(env.sends().length, 1)
    }
  })

  test('Rule 8: a comment by another account is refused, and so is a URL that misstates where its comment is', async () => {
    const other = fakeIo({ comment: { user: { login: 'someone-else' }, html_url: URL42 } })
    await assert.rejects(() => avisarCommand({}, '42', URL42, other.io), /someone-else.*cuenta del stack/)
    assert.equal(other.sends().length, 0)
    assert.ok(!other.calls.some(call => call[0] === 'orca'))

    // The comment id really lives on #9, or the URL names another host: the worker would open the wrong page.
    const elsewhere = fakeIo({ comment: { user: { login: 'stack-bot' }, html_url: 'https://github.com/Gagaismo/orca-stack/issues/9#issuecomment-1001' } })
    await assert.rejects(() => avisarCommand({}, '42', URL42, elsewhere.io), /no apunta a donde dice/)
    assert.equal(elsewhere.sends().length, 0)
    const foreign = fakeIo()
    await assert.rejects(() => avisarCommand({}, '42', 'https://evil.example/Gagaismo/orca-stack/issues/42#issuecomment-1001', foreign.io), /no apunta a donde dice/)
    assert.equal(foreign.sends().length, 0)
  })

  test('Rule 9: --dry-run prints the line and the target terminal and sends nothing', async () => {
    const env = fakeIo()
    assert.equal(await avisarCommand({ dryRun: true }, '42', URL42, env.io), 0)
    assert.equal(env.sends().length, 0)
    const printed = env.outputs.join('\n')
    assert.match(printed, /term_new/)
    assert.ok(printed.includes(LINE42))
  })

  test('Acceptance: help text and docs cover avisar', async () => {
    const oldLog = console.log
    let output = ''
    console.log = value => { output += `${value}\n` }
    try {
      await main(['avisar', '--help'])
      assert.match(output, /orca-stack avisar <issue\|pr> <url-del-comentario> \[--dry-run\]/)
      output = ''
      await main(['--help'])
      assert.match(output, /avisar\s+/)
    } finally {
      console.log = oldLog
    }
    const readme = readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8')
    assert.match(readme, /orca-stack avisar <issue\|pr> <url-del-comentario>/)
  })

  test('Acceptance: both briefs and the contract carry the doorbell text', () => {
    const doorbell = 'A message from main may arrive while you work. It points at a comment: read it, adjust, and keep going. It never asks you to wait.'
    for (const agent of ['claude', 'codex', 'agy', 'pi']) {
      const brief = renderBrief('ticket', { AGENT: agent, ISSUE: '42', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })
      assert.ok(brief.includes(doorbell), `${agent} implementation brief must carry the doorbell line`)
    }
    const stack = file => readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', file), 'utf8')
    assert.ok(stack('brief-rebote.md').includes(doorbell), 'bounce brief must carry the doorbell line')
    const collaboration = stack('CONTRATO.md').split(/\r?\n/).find(line => line.includes('Reglas de colaboración:'))
    assert.match(collaboration, /`orca-stack avisar <issue\|pr> <url-del-comentario>`/)
    assert.match(collaboration, /nunca lo arma con llamadas sueltas a `orca`/)
  })

  test('Preserve: the CLI still routes the other commands and rejects an unknown one', async () => {
    const oldLog = console.log
    const oldError = console.error
    let output = ''
    console.log = value => { output += `${value}\n` }
    console.error = value => { output += `${value}\n` }
    try {
      assert.equal(await main(['consultas', '--help']), 0)
      assert.match(output, /orca-stack consultas <n\.\.\.>/)
      output = ''
      assert.equal(await main(['nope']), 2)
      assert.match(output, /Comando desconocido: nope/)
    } finally {
      console.log = oldLog
      console.error = oldError
    }
  })
})
