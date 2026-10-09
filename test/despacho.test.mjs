import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { citedPaths, dispatch, launcherFor, missingPaths, renderBrief } from '../src/despacho.mjs'
import { layout } from '../src/util.mjs'
import { cleanup, read, tempDir, write } from './helpers.mjs'

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = (stdout = '') => ({ status: 0, stdout, stderr: '' })

const PROJECT = {
  setup: 'completo',
  modo: 'multiagente',
  ramaBase: 'main',
  agentes: { usa: ['claude', 'agy', 'codex', 'codex-cc', 'pi'], preguntarAntes: ['codex-cc'] },
  verificacion: { suite: 'npm test -- --run', typecheck: 'npm run typecheck' },
}

let home
let root
let worktree
beforeEach(() => {
  home = tempDir('despacho-home')
  root = path.join(tempDir('despacho-root'), 'proj')
  worktree = path.join(tempDir('despacho-wt'), 'proj-7')
  write(path.join(root, 'x'), '')
  write(path.join(worktree, 'src', 'app.ts'), '')
})
afterEach(() => {
  for (const dir of [home, path.dirname(root), path.dirname(worktree)]) cleanup(dir)
})

// A scripted environment: every external call is recorded; `over` answers specific ones ("cmd arg0 [arg1]").
const fakeIo = (over = {}, { config = PROJECT, piTools = 'available' } = {}) => {
  write(path.join(root, '.orca-stack.json'), JSON.stringify(config))
  const calls = []
  const out = []
  const written = []
  const sessionRoot = path.join(home, '.pi', 'agent', 'sessions')
  const sessionDir = path.join(sessionRoot, 'project')
  const sessionFile = path.join(sessionDir, '2026-10-09T00-00-00-000Z_session.jsonl')
  const files = new Map()
  const io = {
    home,
    cwd: root,
    win: true,
    out: line => out.push(line),
    sleep: async () => {},
    exists: existsSync,
    readFile: file => files.get(file) ?? readFileSync(file, 'utf8'),
    listFiles: dir => dir === sessionRoot ? [sessionDir] : dir === sessionDir ? [...files.keys()].filter(file => path.dirname(file) === sessionDir) : [],
    mkdirp: () => {},
    writeFile: (file, text) => {
      written.push([file, text])
      write(file, text)
    },
    gentleSkills: () => 'C:\\pi\\gentle-pi\\skills',
    sh: (cmd, args) => {
      calls.push([cmd, ...args])
      const found = over[`${cmd} ${args[0]} ${args[1] ?? ''}`.trim()] ?? over[`${cmd} ${args[0]}`]
      const custom = typeof found === 'function' ? found(args) : found
      if (custom) return custom
      if (cmd === 'git' && args[0] === 'ls-files') return { status: 1, stdout: '', stderr: '' } // not tracked
      if (cmd === 'git' && args[0] === 'rev-parse') return okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
      if (cmd === 'git' && args[0] === 'worktree') return okRes(`worktree ${root}\nbranch refs/heads/main\n`)
      if (cmd === 'git') return okRes('src/app.ts\n')
      if (cmd === 'gh' && args[0] === 'issue') return json({ state: 'OPEN', assignees: [], title: 't' })
      if (args.join(' ') === 'worktree ps --json') return json({ result: { worktrees: [] } })
      if (args.join(' ').startsWith('worktree create')) return json({ result: { worktree: { path: worktree, branch: 'refs/heads/proj-7' } } })
      if (args[0] === 'terminal' && args[1] === 'create') {
        if (String(args[args.indexOf('--command') + 1] ?? '').includes('pi -p')) {
          const text = piTools === 'none' ? '<tools>\n(none)' : '<tools>\n- read: Read file contents\n- bash: Execute commands'
          files.set(sessionFile, [
            JSON.stringify({ type: 'session', cwd: worktree }),
            '{}', '{}', '{}', JSON.stringify({ type: 'message', message: { role: 'system', content: '', sections: { tools: text } } }),
          ].join('\n'))
        }
        return json({ result: { terminal: { handle: 'term_1' } } })
      }
      if (args[0] === 'terminal' && args[1] === 'send' && args.includes('--wait-submit')) return json({ result: { submission: 'submitted', turnStarted: true } })
      if (args[0] === 'terminal' && args[1] === 'read') return json({ id: `req-${calls.length}`, ok: true, result: { terminal: { tail: ['ready'], latestCursor: calls.length } } })
      return okRes()
    },
  }
  // Calls that change something: every gh issue edit, orca worktree create, terminal create/send, git fetch.
  const writes = () =>
    calls.filter(c => (c[0] === 'gh' && c[2] === 'edit') || (c[0] === 'orca' && (c[2] === 'create' || c[2] === 'send')) || (c[0] === 'git' && c[1] === 'fetch'))

  return { io, calls, out, written, writes }
}

const run = (kind, args, env) => dispatch(kind, args, env.io)
const withModels = modelos => ({ ...PROJECT, agentes: { ...PROJECT.agentes, modelos } })

describe('despachar: refusals', () => {
  test('setup pending', async () => {
    const env = fakeIo({}, { config: { ...PROJECT, setup: undefined } })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, env), /setup .* pendiente/)
    assert.equal(env.calls.filter(c => c[0] === 'gh').length, 0)
  })

  test('agent not in agentes.usa', async () => {
    const env = fakeIo({}, { config: { ...PROJECT, agentes: { usa: ['claude'] } } })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, env), /no está en agentes\.usa/)
  })

  test('preguntarAntes needs --confirmado', async () => {
    await assert.rejects(run('ticket', { n: '7', agent: 'codex-cc' }, fakeIo()), /preguntarle al humano[\s\S]*--confirmado/)
    await run('ticket', { n: '7', agent: 'codex-cc', confirmado: true, dryRun: true }, fakeIo())
  })

  test('assigned and closed issues', async () => {
    const assigned = fakeIo({ 'gh issue': json({ state: 'OPEN', assignees: [{ login: 'me' }] }) })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, assigned), /ya tiene assignee/)
    const closed = fakeIo({ 'gh issue': json({ state: 'CLOSED', assignees: [] }) })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, closed), /cerrado/)
    assert.deepEqual(assigned.writes(), [])
  })

  test('existing worktree (git) and live agent (orca)', async () => {
    const git = fakeIo({ 'git worktree': okRes(`worktree ${root}\nworktree C:/x/proj-7\nbranch refs/heads/proj-7\n`) })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, git), /Ya hay un worktree para proj-7/)
    // `orca worktree rm` leaves the entry as prunable until `git worktree prune`: it is not taken.
    const pruned = fakeIo({ 'git worktree': okRes(`worktree ${root}\nbranch refs/heads/main\n\nworktree C:/x/proj-7\nHEAD abc\nbranch refs/heads/proj-7\nprunable gitdir file points to non-existent location\n`) })
    await run('ticket', { n: '7', agent: 'agy', dryRun: true }, pruned)
    const live = fakeIo({ 'orca worktree ps': json({ result: { worktrees: [{ repo: 'proj', path: 'C:/other/place', linkedIssue: 7, agents: [{ state: 'working' }] }] } }) })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, live), /agente vivo/)
    assert.deepEqual(live.writes(), [])
  })

  test('review: reviewer is the implementer, same model family, missing line', async () => {
    const pr = body => ({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body, number: 9 }) })
    await assert.rejects(run('review', { n: '9', agent: 'agy' }, fakeIo(pr('x\nImplementador: agy\n'))), /nadie revisa su propio PR/)
    await assert.rejects(run('review', { n: '9', agent: 'codex-cc', confirmado: true }, fakeIo(pr('Implementador: codex\n'), { config: withModels({ 'codex-cc': 'gpt-6-luna' }) })), /familia gpt, comparten modelo/)
    await assert.rejects(run('review', { n: '9', agent: 'agy' }, fakeIo(pr('sin línea'))), /no tiene la línea "Implementador/)
  })

  test('review: the family comes from the configured model, and pi may review a Claude agent', async () => {
    const pr = body => ({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body, number: 9 }) })
    // codex-cc on GLM reviews codex (gpt); with no model it proves nothing and is not stopped either.
    await run('review', { n: '9', agent: 'codex-cc', confirmado: true, dryRun: true }, fakeIo(pr('Implementador: codex'), { config: withModels({ 'codex-cc': { revisar: { modelo: 'z-ai/glm-5.3-flash' } } }) }))
    await run('review', { n: '9', agent: 'codex-cc', confirmado: true, dryRun: true }, fakeIo(pr('Implementador: codex')))
    // agy on a Claude model does not review claude; pi does, and claude reviews pi.
    await assert.rejects(run('review', { n: '9', agent: 'agy' }, fakeIo(pr('Implementador: claude'), { config: withModels({ agy: 'claude-sonnet-5-5' }) })), /familia claude/)
    await run('review', { n: '9', agent: 'pi', dryRun: true }, fakeIo(pr('Implementador: claude')))
    await run('review', { n: '9', agent: 'claude', dryRun: true }, fakeIo(pr('Implementador: pi')))
  })

  test('a guardia.bloquear rule stops despachar and revisar, from any layer', async () => {
    const until = new Date(Date.now() + 86_400_000 * 3)
    const hasta = `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, '0')}-${String(until.getDate()).padStart(2, '0')}`
    write(layout(home).config, JSON.stringify({ guardia: { bloquear: [{ agente: 'codex', hasta, motivo: 'codex no tiene cuota: usá codex-cc.' }] } }))
    // The project layer has its own list: the personal block still applies.
    const env = fakeIo({}, { config: { ...PROJECT, guardia: { bloquear: [{ agente: 'agy', hasta: '2020-01-01' }] } } })
    await assert.rejects(run('ticket', { n: '7', agent: 'codex' }, env), /No despacho a codex: codex no tiene cuota: usá codex-cc\./)
    assert.deepEqual(env.writes(), [])
    await run('ticket', { n: '7', agent: 'agy', dryRun: true }, env) // an expired rule does nothing
    const pr = { 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: agy', number: 9 }) }
    await assert.rejects(run('review', { n: '9', agent: 'codex' }, fakeIo(pr)), /No despacho a codex/)
    write(layout(home).config, JSON.stringify({ guardia: { bloquear: [{ agente: 'codex', hasta: '29/10' }] } }))
    await assert.rejects(run('ticket', { n: '7', agent: 'codex' }, fakeIo()), /fecha "hasta" que no es AAAA-MM-DD/)
  })
})

describe('revisar: one worktree per reviewer', () => {
  const pr = over => fakeIo({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: codex', number: 9 }), ...over })

  test('a second reviewer of the same PR gets its own worktree, brief and session', async () => {
    const taken = { 'git worktree': okRes(`worktree ${root}\nbranch refs/heads/main\n\nworktree C:/x/revision-9-agy\nbranch refs/heads/revision-9-agy\n`) }
    await assert.rejects(run('review', { n: '9', agent: 'agy' }, pr(taken)), /Ya hay un worktree para revision-9-agy/)
    const env = pr(taken)
    await run('review', { n: '9', agent: 'pi', dryRun: true }, env)
    const text = env.out.join('\n')
    for (const part of ['--name revision-9-pi', 'proj-revision-9-pi.md', '--session-id proj-revision-9-pi']) assert.ok(text.includes(part), part)
  })
})

describe('despachar: the TUI wait', () => {
  test('a still screen is stable even though every read carries a new request id', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'claude' }, env)
    const sent = env.calls.find(c => c[1] === 'terminal' && c[2] === 'send')
    assert.ok(sent?.includes('--text') && sent.some(a => String(a).startsWith('Read and follow the brief in ')))
  })

  test('codex trust screen fails with the repo trust hint and never sends the brief', async () => {
    const env = fakeIo({
      'orca terminal read': args => json({ result: { terminal: { tail: ['Trust this folder?'] } } }),
    })
    await assert.rejects(run('ticket', { n: '7', agent: 'codex' }, env), /confiá la raíz del repo en Codex[\s\S]*\[projects\.'/i)
    assert.ok(!env.calls.some(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send'))
    assert.ok(!env.out.some(line => line.includes('✔ codex despachado')))
  })

  test('revisar applies the same trust check before sending its brief', async () => {
    const env = fakeIo({
      'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: agy', number: 9 }),
      'orca terminal read': args => json({ result: { terminal: { tail: ['Trust this folder?'] } } }),
    })
    await assert.rejects(run('review', { n: '9', agent: 'codex' }, env), /confiá la raíz del repo en Codex/i)
    assert.ok(!env.calls.some(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send'))
  })

  test('revisar reports success after Orca observes its review turn start', async () => {
    const env = fakeIo({
      'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: agy', number: 9 }),
    })
    await run('review', { n: '9', agent: 'codex' }, env)
    assert.ok(env.calls.some(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send' && c.includes('--wait-submit')))
    assert.ok(env.out.some(line => line.includes('✔ codex despachado')))
  })

  test('a launched agent that exits to PowerShell fails without sending or reporting success', async () => {
    const env = fakeIo({
      'orca terminal read': args => json({ result: { terminal: { tail: ['PS C:\\work>'] } } }),
    })
    await assert.rejects(run('ticket', { n: '7', agent: 'claude' }, env), /shell prompt[\s\S]*PS C:/i)
    assert.ok(!env.calls.some(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send'))
    assert.ok(!env.out.some(line => line.includes('✔ claude despachado')))
  })

  test('only an observed submitted turn prints dispatch success', async () => {
    const env = fakeIo({
      'orca terminal send': args => args.includes('--wait-submit')
        ? json({ result: { submission: 'submitted', turnStarted: true } })
        : okRes(),
    })
    await run('ticket', { n: '7', agent: 'claude' }, env)
    const send = env.calls.find(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send')
    assert.ok(send.includes('--wait-submit') && send.includes('--json'))
    assert.ok(env.out.some(line => line.includes('✔ claude despachado')))
  })

  test('an old host without --wait-submit falls back to a changed terminal screen', async () => {
    let reads = 0
    const env = fakeIo({
      'orca terminal read': () => json({ result: { terminal: { tail: [reads++ < 3 ? 'ready' : 'prompt submitted'] } } }),
      'orca terminal send': args => args.includes('--wait-submit')
        ? { status: 1, stdout: '', stderr: 'unknown option --wait-submit' }
        : okRes(),
    })
    await run('ticket', { n: '7', agent: 'claude' }, env)
    const sends = env.calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send')
    assert.equal(sends.length, 2)
    assert.ok(sends[0].includes('--wait-submit') && !sends[1].includes('--wait-submit'))
    assert.ok(env.out.some(line => line.includes('✔ claude despachado')))
  })

  test('an accepted but unobserved prompt is not reported as a started turn', async () => {
    const env = fakeIo({
      'orca terminal send': args => args.includes('--wait-submit')
        ? json({ result: { inputAccepted: true, turnStarted: false } })
        : okRes(),
      'orca terminal read': args => json({ result: { terminal: { tail: ['ready'] } } }),
    })
    await assert.rejects(run('ticket', { n: '7', agent: 'claude' }, env), /no hay evidencia.*turno haya arrancado/i)
    assert.ok(!env.out.some(line => line.includes('✔ claude despachado')))
  })

  test('a send transport error prints recovery details and never reports success', async () => {
    const env = fakeIo({
      'orca terminal send': { status: 1, stdout: '', stderr: 'agent_prompt_blocked' },
    })
    await assert.rejects(run('ticket', { n: '7', agent: 'claude' }, env), /agent_prompt_blocked/)
    assert.ok(env.out.join('\n').includes('El despacho quedó a medias'))
    assert.ok(!env.out.some(line => line.includes('✔ claude despachado')))
  })

  test('a pi review with no tools fails fast, while the normal read/bash review tools pass', async () => {
    const pr = { 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: claude', number: 9 }) }
    const none = fakeIo(pr, { piTools: 'none' })
    await assert.rejects(run('review', { n: '9', agent: 'pi' }, none), /no tiene herramientas.*\(none\)/i)
    assert.ok(!none.out.some(line => line.includes('✔ pi despachado')))
    const available = fakeIo(pr, { piTools: 'available' })
    await run('review', { n: '9', agent: 'pi' }, available)
    assert.ok(available.out.some(line => line.includes('✔ pi despachado')))
  })
})

describe('despachar: failures along the way', () => {
  test('a failed git fetch aborts before any write', async () => {
    const env = fakeIo({ 'git fetch': { status: 1, stdout: '', stderr: 'fatal: no remote' } })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, env), /git fetch origin falló.*fatal: no remote/)
    assert.deepEqual(env.calls.filter(c => (c[0] === 'gh' && c[2] === 'edit') || (c[0] === 'orca' && c[2] === 'create')), [])
    assert.equal(env.written.length, 0)
  })

  test('an abort after the worktree exists lists what was left and how to recover', async () => {
    const env = fakeIo({ 'orca terminal create': { status: 1, stdout: '', stderr: 'boom' } })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, env), /boom/)
    const text = env.out.join('\n')
    assert.ok(text.includes('quedó a medias'))
    assert.ok(text.includes('el issue #7 asignado') && text.includes(`el worktree ${worktree}`) && text.includes('el brief '))
    assert.ok(text.includes(`orca worktree rm --worktree path:${worktree}`) && text.includes('OK del humano'))
    assert.ok(text.includes('gh issue edit 7 --remove-assignee @me') && text.includes('rechazar el despacho'))
  })

  test('an abort right after assigning only lists the assignee', async () => {
    const env = fakeIo({ 'orca worktree create': { status: 1, stdout: '', stderr: 'no repo' } })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, env), /no repo/)
    const text = env.out.join('\n')
    assert.ok(text.includes('el issue #7 asignado') && !text.includes('el worktree') && !text.includes('orca worktree rm'))
  })

  test('the implementer line is compared case-insensitively and trimmed', async () => {
    const pr = body => ({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body, number: 9 }) })
    await assert.rejects(run('review', { n: '9', agent: 'agy' }, fakeIo(pr('Implementador:   AGY  \n'))), /nadie revisa su propio PR/)
    await assert.rejects(run('review', { n: '9', agent: 'codex', confirmado: true }, fakeIo(pr('implementador: Codex-CC'), { config: withModels({ 'codex-cc': 'gpt-6-luna' }) })), /comparten modelo/)
  })
})

describe('briefs', () => {
  test('ticket brief defines RED/PRESERVE slices and evidence rows for rules and touched entries', async () => {
    const env = fakeIo({
      'gh issue view': json({
        state: 'OPEN', assignees: [], title: 'ticket with rules',
        body: '## Reglas\n1. `cliente` (`docs/example.md`): match this example.\n\n## Acceptance criteria\n- Keep this behavior',
      }),
    })
    await run('ticket', { n: '7', agent: 'agy' }, env)
    const brief = env.written[0][1]
    const touched = 'A public entry is touched when its own code changed in the diff, or when it calls a shared function whose code changed in the diff. A public entry is a command, endpoint, exported function, screen or scheduled job.'
    assert.match(brief, /\*\*RED:\*\* Write one test per rule[\s\S]*?examples, edges and errors/i)
    assert.match(brief, /\*\*PRESERVE:\*\* Write one test per existing public entry the change touches/i)
    assert.match(brief, /Nothing else/i)
    assert.ok(brief.includes(touched))
    assert.match(brief, /When a rule cites an artifact.*test against that artifact, not a paraphrase/i)
    assert.match(brief, /one row per rule.*one row per touched public entry/i)

    const roleBriefs = readFileSync(new URL('../assets/stack/ROLE-BRIEFS.md', import.meta.url), 'utf8')
    const contract = readFileSync(new URL('../assets/stack/CONTRATO.md', import.meta.url), 'utf8')
    assert.ok(roleBriefs.includes(touched))
    assert.match(roleBriefs, /RED is one test per rule[\s\S]*PRESERVE is one test per existing public entry[\s\S]*Nothing else/i)
    assert.match(roleBriefs, /If a rule\s+cites an artifact, test against that artifact, not a paraphrase/i)
    assert.doesNotMatch(contract, /A public entry is touched when its own code changed in the diff/)
    assert.match(contract, /## Evidencia` con una fila por cada regla[\s\S]*por cada entrada pública tocada.*assets\/stack\/brief-ticket\.md/i)
    const reviewSection = contract.split('### Review')[1].split('### Skills de Matt')[0]
    assert.match(reviewSection, /assets\/stack\/brief-revision\.md/)
    assert.doesNotMatch(reviewSection, /se revisa en tres ejes|deriva y corre sus propios tests/i)
    assert.match(reviewSection, /Bloquean:.*No bloquean/is)
    assert.match(reviewSection, /`implementación`.*`interpretación`.*humano.*`Decidido por main`/is)
    for (const marker of ['## BLOQUEA', '## SUGERENCIAS', 'Revisor:', 'Commit:', 'Implementador:', 'Verificado por main:', 'Decidido por main:', 'Suite:']) {
      assert.ok(contract.includes(marker), marker)
    }
  })

  test('ticket brief falls back to acceptance criteria and failure modes as RED list for legacy tickets', async () => {
    const env = fakeIo({
      'gh issue view': json({
        state: 'OPEN', assignees: [], title: 'legacy ticket',
        body: '## Acceptance criteria\n- Keep this behavior\n\n## Modos de falla\n- An external call fails',
      }),
    })
    await run('ticket', { n: '7', agent: 'agy' }, env)
    const brief = env.written[0][1]
    assert.match(brief, /If the ticket has no `## Reglas`, use its acceptance criteria and failure modes as the RED list/i)
  })

  test('ticket brief permits zero PRESERVE rows when no public entry is touched', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'agy' }, env)
    const brief = env.written[0][1]
    assert.match(brief, /If no existing public entry is touched, state "none touched"; do not add a placeholder row/i)
  })

  test('dispatching a legacy ticket with only Modos de falla preserves acceptance criteria as TDD slices', async () => {
    const env = fakeIo({
      'gh issue view': json({
        state: 'OPEN', assignees: [], title: 'legacy ticket',
        body: '## Acceptance criteria\n- Keep this behavior\n\n## Modos de falla\n- An external call fails',
      }),
    })
    await run('ticket', { n: '7', agent: 'agy' }, env)
    const brief = env.written[0][1]
    assert.match(brief, /If the ticket has no `## Reglas`, use its acceptance criteria and failure modes as the RED list/i)
    assert.doesNotMatch(brief, /requires? `?## Reglas`?/i)
  })

  test('ticket brief keeps markers literal, verification verbatim and the nota', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'agy', nota: 'Mirá `src/app.ts` antes de empezar.' }, env)
    const [file, brief] = env.written[0]
    assert.equal(file, path.join(home, 'orca', 'briefs', 'proj-7.md'))
    for (const marker of ['## Summary', '## Evidencia', '## Merge Danger', '## Desvíos del ticket', 'Implementador: agy', 'Closes #7']) assert.ok(brief.includes(marker), marker)
    assert.ok(brief.includes('npm test -- --run\nnpm run typecheck'))
    assert.ok(brief.includes('gh issue view 7 --comments') && brief.includes('--base main') && brief.includes('proj-7'))
    assert.ok(brief.includes('Mirá `src/app.ts` antes de empezar.'))
    assert.ok(!brief.includes('{{'))
    assert.notEqual(read(file).charCodeAt(0), 0xfeff)
    assert.deepEqual(env.writes().map(c => c.slice(0, 3).join(' ')), ['git fetch origin', 'gh issue edit', 'orca worktree create', 'orca terminal create', 'orca terminal send'])
    assert.deepEqual(env.calls.find(c => c[2] === 'send').slice(3), ['--terminal', 'term_1', '--text', `Read and follow the brief in ${file}`, '--enter', '--wait-submit', '10', '--json'])
  })

  test('review brief: sha, implementer, axes, red check and format', async () => {
    const env = fakeIo({ 'gh pr': json({ headRefName: 'feat/x', headRefOid: 'abc123', body: 'Implementador: codex', number: 9 }) })
    await run('review', { n: '9', agent: 'agy', dryRun: true }, env)
    const text = env.out.join('\n')
    const brief = renderBrief('review', {
      PR: '9', REPO: 'repo', AGENT: 'agy', IMPLEMENTER: 'codex', SHA: 'abc123', BASE: 'main', VERIFICATION: 'npm test',
    })
    for (const part of [
      'Revisor: agy', 'Commit: abc123', 'written by codex', '## BLOQUEA', '## SUGERENCIAS', 'Standards',
      'Derive and run your own tests', 'every numbered rule in `## Reglas`', 'A public entry is touched when its own code changed in the diff, or when it calls a shared function whose code changed in the diff. A public entry is a command, endpoint, exported function, screen or scheduled job.',
      'external service', 'real system', 'test code', 'implementación', 'interpretación', 'Delete your verifier test files',
      'tell `main` to send it to the human', '`main` must not settle it with `Decidido por main`',
      'acceptance criteria and failure modes', 'git checkout origin/<base> -- <files>', 'git checkout HEAD -- .',
    ]) assert.ok(brief.includes(part), part)
    for (const part of ['gh pr review 9 --comment --body-file', '--base-branch origin/feat/x', '--name revision-9-agy', 'proj-revision-9-agy.md']) assert.ok(text.includes(part), part)
  })

  test('a cited path that is not in the base tree aborts a real run with zero writes', async () => {
    const env = fakeIo()
    await assert.rejects(run('ticket', { n: '7', agent: 'agy', nota: 'Seguí `.agents/skills/impeccable/SKILL.md`.' }, env), /\.agents\/skills\/impeccable\/SKILL\.md/)
    assert.equal(env.written.length, 0)
    assert.deepEqual(env.calls.filter(c => c[0] === 'gh' && c[2] === 'edit'), [])
    assert.deepEqual(env.calls.filter(c => c[0] === 'orca' && c[1] === 'worktree' && c[2] === 'create'), [])
    assert.ok(!env.calls.some(c => c[1] === 'terminal'))
  })

  test('citedPaths skips commands, refs, urls and fenced blocks', () => {
    const text = 'Run `npm run test:mods`, see `origin/main`, `https://x.y/z.md`, `~/orca/a.md`, `src/a.ts:12`, `docs/` and `file:line`.\n```\n`fake/path.ts`\n```'
    assert.deepEqual(citedPaths(text), ['src/a.ts', 'docs/'])
    assert.deepEqual(missingPaths(text, p => p === 'docs'), ['src/a.ts'])
  })
})

describe('launchers', () => {
  const base = { mode: 'ticket', config: {}, win: true, home: 'C:\\Users\\me', briefPath: 'C:\\b.md', session: 'proj-7', skills: 'C:\\skills' }

  test('claude and agy take --model only when configured', () => {
    assert.match(launcherFor({ ...base, agent: 'claude' }), /^& ".*claude-orca-stack\.cmd" --dangerously-skip-permissions$/)
    const config = { agentes: { modelos: { agy: 'gemini-x' } } }
    assert.match(launcherFor({ ...base, agent: 'agy', config }), /agy-orca-stack\.cmd" --dangerously-skip-permissions --model gemini-x$/)
  })

  test('the target platform, not the host, decides the wrapper and the paths', () => {
    const posix = { ...base, win: false, home: '/home/me', briefPath: '/b.md', skills: '/s' }
    assert.equal(launcherFor({ ...posix, agent: 'claude' }), '"/home/me/orca/stack/scripts/claude-orca-stack.sh" --dangerously-skip-permissions')
    assert.ok(launcherFor({ ...posix, agent: 'codex' }).startsWith('"/home/me/orca/stack/scripts/codex-orca-stack.sh" '))
    assert.ok(launcherFor({ ...posix, agent: 'codex-cc' }).startsWith('export CMD_API_KEY='))
    assert.ok(launcherFor({ ...posix, agent: 'pi' }).includes("ENGRAM_DATA_DIR='/home/me/.gentle-shell/engram'"))
    assert.equal(launcherFor({ ...base, agent: 'claude' }), '& "C:\\Users\\me\\orca\\stack\\scripts\\claude-orca-stack.cmd" --dangerously-skip-permissions')
  })

  test('codex and codex-cc use implement or review model and effort', () => {
    const config = { agentes: { modelos: { codex: { implementar: { modelo: 'a', esfuerzo: 'high' }, revisar: { modelo: 'b', esfuerzo: 'low' } } } } }
    assert.match(launcherFor({ ...base, agent: 'codex', config }), /--model a -c model_reasoning_effort="high" -c approval_policy="never" -c sandbox_mode="danger-full-access"$/)
    assert.match(launcherFor({ ...base, agent: 'codex', config, mode: 'review' }), /--model b -c model_reasoning_effort="low"/)
    const cc = launcherFor({ ...base, agent: 'codex-cc' })
    assert.ok(cc.startsWith('$env:CMD_API_KEY = (Get-Content') && cc.includes('model_providers.cc.env_key=CMD_API_KEY') && !cc.includes('--model'))
  })

  test('pi: headless, clears the Orca variables, sets engram, autonomy and the Claude account', () => {
    const config = { piClaudeConfigDir: 'C:\\Users\\me\\.claude-pi' }
    const ps = launcherFor({ ...base, agent: 'pi', config })
    assert.ok(ps.startsWith('Remove-Item Env:ORCA_AGENT_HOOK_ENDPOINT, Env:ORCA_AGENT_HOOK_PORT'))
    assert.ok(ps.includes('Env:ORCA_STACK_CAVEMAN_LEVEL -ErrorAction SilentlyContinue'))
    assert.ok(ps.includes("$env:ENGRAM_DATA_DIR = 'C:\\Users\\me\\.gentle-shell\\engram'"))
    assert.ok(ps.includes("$env:GENTLE_PI_AUTONOMOUS_MODE = '1'") && ps.includes("$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\.claude-pi'"))
    assert.ok(ps.endsWith("pi -p --no-skills --skill 'C:\\skills' --session-id proj-7 'Read and carry out the brief in C:\\b.md. Non-interactive: never wait for user input.'"))
    assert.ok(!ps.includes('--tools'), "a ticket keeps all of pi's tools: subagents, SDD, engram")
    const sh = launcherFor({ ...base, agent: 'pi', win: false, mode: 'review', home: '/h', briefPath: '/b.md', skills: '/s' })
    assert.ok(sh.startsWith('unset ORCA_AGENT_HOOK_ENDPOINT ') && sh.includes("export ENGRAM_DATA_DIR='/h/.gentle-shell/engram' GENTLE_PI_AUTONOMOUS_MODE='1';"))
    assert.ok(sh.includes("--tools 'read,bash,grep,find,ls'") && !sh.includes('CLAUDE_CONFIG_DIR'))
  })

  test('the Claude account of pi comes from the personal layer only', async () => {
    write(layout(home).config, JSON.stringify({ agentes: { pi: { claudeConfigDir: '~/.claude-pi' } } }))
    const env = fakeIo({}, { config: { ...PROJECT, agentes: { ...PROJECT.agentes, pi: { claudeConfigDir: 'C:\\evil' } } } })
    await run('ticket', { n: '7', agent: 'pi', dryRun: true }, env)
    const launcher = env.out.find(l => l.startsWith('Lanzador'))
    assert.ok(launcher.includes(path.join(home, '.claude-pi')) && !launcher.includes('evil'))
    assert.ok(!env.calls.some(c => c[2] === 'send'))
  })
})

describe('pi: --perfil-pi', () => {
  const PROFILES = {
    kind: 'gentle-pi.agent_model_profiles',
    version: 1,
    active: 'samu-balanceado',
    profiles: {
      'opus-haiku': { orchestrator: { model: 'claude-bridge/claude-opus-5-5', thinking: 'high' }, 'gentle-ai-worker': { model: 'claude-bridge/claude-haiku-5-5', thinking: 'high' } },
      'samu-balanceado': { orchestrator: { model: 'claude-bridge/claude-opus-5-5', thinking: 'high' } },
    },
  }
  const store = () => path.join(home, '.pi', 'gentle-ai', 'profiles.json')
  const pinFile = () => path.join(worktree, '.pi', 'gentle-ai', 'profile.json')
  const exclude = () => path.join(root, '.git', 'info', 'exclude')
  const launcher = env => {
    const call = env.calls.find(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'create')

    return call[call.indexOf('--command') + 1]
  }
  const EXCLUDE_LINE = '/.pi/gentle-ai/profile.json'
  // Not ignored until the exclude entry is there (what git does).
  const notIgnored = { 'git check-ignore': () => ({ status: existsSync(exclude()) && read(exclude()).includes(EXCLUDE_LINE) ? 0 : 1, stdout: '', stderr: '' }) }
  // A .gitignore negation: git keeps reporting the file as not ignored.
  const negated = { 'git check-ignore': { status: 1, stdout: '', stderr: '' } }
  const tracked = { 'git ls-files': { status: 0, stdout: '.pi/gentle-ai/profile.json\n', stderr: '' } }
  const trackedPin = profile => write(pinFile(), JSON.stringify({ kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile }))
  beforeEach(() => write(store(), JSON.stringify(PROFILES)))

  test('writes the worktree pin, excludes it once, and launches pi with the profile orchestrator', async () => {
    const env = fakeIo(notIgnored)
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, env)
    assert.deepEqual(JSON.parse(read(pinFile())), { kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile: 'opus-haiku' })
    assert.equal(read(exclude()), '/.pi/gentle-ai/profile.json\n')
    assert.ok(launcher(env).includes("--model 'claude-bridge/claude-opus-5-5' --thinking high"), launcher(env))
    // The pin exists before pi starts.
    const order = env.calls.map(c => c.join(' '))
    assert.ok(order.findIndex(l => l.startsWith('git check-ignore')) < order.findIndex(l => l.startsWith('orca terminal create')))
  })

  test('the exclude entry is appended once and keeps what was there', async () => {
    write(exclude(), '# mine')
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, fakeIo(notIgnored))
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, fakeIo(notIgnored))
    assert.equal(read(exclude()), '# mine\n/.pi/gentle-ai/profile.json\n')
  })

  test('an already ignored pin touches no exclude file', async () => {
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, fakeIo())
    assert.ok(existsSync(pinFile()) && !existsSync(exclude()))
  })

  test('a tracked pin that declares the same profile is left untouched', async () => {
    trackedPin('opus-haiku')
    const env = fakeIo(tracked)
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, env)
    assert.equal(env.written.filter(([file]) => file === pinFile()).length, 0)
    assert.ok(!existsSync(exclude()))
    assert.ok(launcher(env).includes('--model'))
  })

  test('a tracked pin that declares another profile (or is unreadable) fails without writing', async () => {
    trackedPin('samu-balanceado')
    const env = fakeIo(tracked)
    await assert.rejects(run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, env), /versionado.*declara el perfil "samu-balanceado".*--perfil-pi samu-balanceado/)
    assert.equal(JSON.parse(read(pinFile())).profile, 'samu-balanceado')
    assert.ok(env.out.join('\n').includes('El despacho quedó a medias'))
    assert.ok(!env.calls.some(c => c[1] === 'terminal' && c[2] === 'create'))
    write(pinFile(), '{ not json')
    await assert.rejects(run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, fakeIo(tracked)), /versionado.*no se puede leer/)
    assert.equal(read(pinFile()), '{ not json')
  })

  test('a pin that a .gitignore negation keeps visible fails instead of writing; the exclude entry is added once', async () => {
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, fakeIo(negated)), /git no ignora \.pi\/gentle-ai\/profile\.json.*gana sobre info\/exclude/)
    }
    assert.ok(!existsSync(pinFile()))
    assert.equal(read(exclude()), '/.pi/gentle-ai/profile.json\n')
  })

  test('a clone-local pin on another profile fails before any write; the same one is fine', async () => {
    const pin = profile => write(path.join(root, '.git', 'gentle-ai', 'profile-pin.json'), JSON.stringify({ kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile }))
    pin('samu-balanceado')
    const env = fakeIo()
    await assert.rejects(run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, env), /fija el perfil de Pi "samu-balanceado"/)
    assert.deepEqual(env.writes(), [])
    pin('opus-haiku')
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku', dryRun: true }, fakeIo())
  })

  test('an unknown profile fails before any write and lists the existing ones', async () => {
    const env = fakeIo()
    await assert.rejects(run('ticket', { n: '7', agent: 'pi', perfilPi: 'nope' }, env), /No existe el perfil de Pi "nope".*opus-haiku, samu-balanceado/)
    assert.deepEqual(env.writes(), [])
    await assert.rejects(run('ticket', { n: '7', agent: 'pi', perfilPi: 'a b; rm' }, fakeIo()), /no es un nombre válido/)
    await assert.rejects(run('ticket', { n: '7', agent: 'agy', perfilPi: 'opus-haiku' }, fakeIo()), /solo vale para el agente pi/)
  })

  test('agentes.pi.perfil applies, the flag wins, and "preguntar" or nothing changes nothing', async () => {
    const withPerfil = perfil => ({ ...PROJECT, agentes: { ...PROJECT.agentes, pi: { perfil } } })
    await run('ticket', { n: '7', agent: 'pi' }, fakeIo({}, { config: withPerfil('samu-balanceado') }))
    assert.equal(JSON.parse(read(pinFile())).profile, 'samu-balanceado')
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, fakeIo({}, { config: withPerfil('samu-balanceado') }))
    assert.equal(JSON.parse(read(pinFile())).profile, 'opus-haiku')
    for (const config of [withPerfil('preguntar'), withPerfil(' Preguntar '), PROJECT]) {
      cleanup(path.dirname(pinFile()))
      const env = fakeIo({}, { config })
      await run('ticket', { n: '7', agent: 'pi' }, env)
      assert.ok(!existsSync(pinFile()) && !launcher(env).includes('--model') && !launcher(env).includes('--thinking'))
    }
    // No profiles store is needed when no profile is asked for.
    cleanup(store())
    await run('ticket', { n: '7', agent: 'pi', dryRun: true }, fakeIo())
  })

  test('an invalid thinking in the profile is warned about and not passed to pi', async () => {
    write(store(), JSON.stringify({ ...PROFILES, profiles: { 'opus-haiku': { orchestrator: { model: 'claude-bridge/claude-opus-5-5', thinking: 'turbo' } } } }))
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, env)
    assert.match(env.out.join('\n'), /thinking "turbo", que no es válido.*se ignora/)
    assert.ok(launcher(env).includes('--model') && !launcher(env).includes('--thinking'))
    const dry = fakeIo()
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku', dryRun: true }, dry)
    assert.ok(!dry.out.join('\n').includes('(turbo)'))
  })

  test('--dry-run narrates the pin and the model and writes nothing', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku', dryRun: true }, env)
    const text = env.out.join('\n')
    for (const part of ['[simulación] perfil de Pi "opus-haiku"', 'profile.json', 'exclude', "--model 'claude-bridge/claude-opus-5-5'"]) assert.ok(text.includes(part), part)
    assert.ok(!existsSync(pinFile()) && !existsSync(exclude()))
    assert.deepEqual(env.writes(), [])
    const review = fakeIo({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: claude', number: 9 }) })
    await run('review', { n: '9', agent: 'pi', perfilPi: 'opus-haiku', dryRun: true }, review)
    assert.ok(review.out.join('\n').includes('perfil de Pi "opus-haiku"'))
  })

  test('launcherFor adds --model only when given, in PowerShell and POSIX', () => {
    const base = { mode: 'ticket', config: {}, home: '/h', briefPath: '/b.md', session: 's', skills: '/s', agent: 'pi' }
    assert.ok(!launcherFor({ ...base, win: false }).includes('--model'))
    assert.ok(launcherFor({ ...base, win: false, piModel: 'p/m' }).includes("--session-id s --model 'p/m' 'Read"))
    assert.ok(launcherFor({ ...base, win: true, piModel: 'p/m', piThinking: 'bogus' }).includes("--model 'p/m' 'Read"))
  })
})

describe('--dry-run', () => {
  test('executes no write and prints the plan and the brief', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'agy', dryRun: true, nota: 'ojo' }, env)
    assert.deepEqual(env.writes(), [])
    assert.equal(env.written.length, 0)
    assert.ok(!existsSync(path.join(home, 'orca', 'briefs')))
    const text = env.out.join('\n')
    for (const part of ['[simulación] gh issue edit 7 --add-assignee @me', '[simulación] orca worktree create', '--base-branch origin/main', 'brief ->', 'Lanzador (agy)', '--- brief ---', 'ojo']) assert.ok(text.includes(part), part)
  })
})
