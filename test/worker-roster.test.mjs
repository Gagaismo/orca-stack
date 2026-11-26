import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { main } from '../src/cli.mjs'
import { WRAPPERS } from '../src/constants.mjs'
import { dispatch, despacharCommand, reboteCommand, revisarCommand } from '../src/despacho.mjs'
import { doctorCommand } from '../src/doctor.mjs'
import { estadoCommand } from '../src/estado.mjs'
import { upsertBlock } from '../src/marker.mjs'
import { perksOf } from '../src/perks.mjs'
import { policyBlock } from '../src/templates.mjs'
import { PACKAGE_ROOT } from '../src/util.mjs'
import { cleanup, cli, git, read, tempDir, write } from './helpers.mjs'

const HEAD = `abc1234${'a'.repeat(33)}`
const MERGE = 'main mergea sola cuando la CI está verde'
const T = minute => `2026-11-15T10:${String(minute).padStart(2, '0')}:00Z`

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = (stdout = '') => ({ status: 0, stdout, stderr: '' })
const fail = stderr => ({ status: 1, stdout: '', stderr })
const run = (name, conclusion, status = 'COMPLETED') => ({ __typename: 'CheckRun', name, workflowName: 'CI', status, conclusion: status === 'COMPLETED' ? conclusion : '', startedAt: T(0) })
const GREEN = [run('test', 'SUCCESS'), run('ci-ok', 'SUCCESS')]

const prData = (number, { head = HEAD, body = 'Implementador: pi\n\nCloses #7\n\n## Evidencia\n| R1 | `t` |', comments = [], reviews = [], files = ['src/a.mjs'], checks = GREEN, state = 'OPEN', mergeable = 'MERGEABLE', headRefName = 'Gagaismo/orca-stack-7' } = {}) =>
  ({ number, headRefOid: head, headRefName, body, comments, reviews, files: files.map(file => ({ path: file, additions: 1, deletions: 0 })), statusCheckRollup: checks, baseRefName: 'main', mergeable, state })
const review = (who, sha, { verdict = 'nada', at = T(5) } = {}) => ({ body: `Revisor: ${who}\nCommit: ${sha}\n\n## BLOQUEA\n${verdict}\n\n## SUGERENCIAS\nnada`, submittedAt: at, state: 'COMMENTED' })
const comment = (body, at = T(5)) => ({ body, createdAt: at, author: { login: 'stack-bot' } })

const EXPECTED_CLAUDE_ERROR = 'claude ya no es un agente worker (ADR 0006): despachá a pi, agy o codex.'

let dirs = []
const temp = prefix => {
  const dir = tempDir(prefix)
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop())
})

const makeDispatchEnv = (over = {}, configOver = {}) => {
  const home = temp('r488-d-home')
  const root = path.join(temp('r488-d-root'), 'proj')
  const worktree = path.join(temp('r488-d-wt'), 'proj-7')
  const config = {
    setup: 'completo',
    modo: 'multiagente',
    ramaBase: 'main',
    agentes: { usa: ['agy', 'codex', 'pi'], preguntarAntes: [], pi: { perfil: 'global' } },
    verificacion: { suite: 'npm test', typecheck: 'ninguno' },
    ...configOver,
  }
  write(path.join(root, '.orca-stack.json'), JSON.stringify(config))
  write(path.join(root, 'x'), '')
  write(path.join(worktree, 'x'), '')
  write(path.join(home, '.pi', 'gentle-ai', 'profiles.json'), JSON.stringify({ active: 'default', profiles: { default: { orchestrator: { model: 'claude-bridge/claude-opus-5-5' } } } }))

  const calls = []
  const out = []
  const writes = []
  const io = {
    home,
    cwd: root,
    win: true,
    now: () => Date.parse('2026-11-15T12:00:00Z'),
    out: line => out.push(line),
    err: () => {},
    sleep: async () => {},
    exists: existsSync,
    readFile: file => readFileSync(file, 'utf8'),
    listFiles: () => [],
    mkdirp: () => {},
    writeFile: (file, text) => {
      writes.push([file, text])
      write(file, text)
    },
    rename: renameSync,
    gentleSkills: () => 'C:\\pi\\gentle-pi\\skills',
    sh: (cmd, args) => {
      calls.push([cmd, ...args])
      const key = `${cmd} ${args[0]} ${args[1] ?? ''}`.trim()
      const hit = over[key] ?? over[`${cmd} ${args[0]}`]
      if (hit) return typeof hit === 'function' ? hit(args) : hit
      if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('--git-common-dir')) return okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
      if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('--git-dir')) return okRes(`${path.join(root, '.git')}\n`)
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return okRes(`${HEAD}\n`)
      if (cmd === 'git' && args[0] === 'remote') return okRes('https://github.com/Gagaismo/orca-stack.git\n')
      if (cmd === 'git' && args[0] === 'worktree') return okRes(`worktree ${root}\nbranch refs/heads/main\n`)
      if (cmd === 'git' && args[0] === 'status') return okRes('')
      if (cmd === 'git' && args[0] === 'ls-tree') return okRes('x\n')
      if (cmd === 'git') return okRes('')
      if (cmd === 'gh' && args[0] === 'issue') return json({ state: 'OPEN', assignees: [], title: 't' })
      if (cmd === 'gh' && args[0] === 'pr') return json({ state: 'OPEN', number: 9, headRefName: 'Gagaismo/orca-stack-7', headRefOid: HEAD, baseRefName: 'main', mergeable: 'MERGEABLE', body: 'Implementador: codex\nCloses #7', comments: [], reviews: [], statusCheckRollup: [] })
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') return json({ ok: true, result: { worktrees: [] } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'list') return json({ ok: true, result: { terminals: [] } })
      return okRes()
    },
  }
  return { io, calls, out, writes, root, home, worktree }
}

const makeEstadoEnv = (world = {}, config = {}) => {
  const root = temp('r488-e-root')
  const home = temp('r488-e-home')
  write(path.join(root, '.orca-stack.json'), JSON.stringify({ ramaBase: 'main', merge: MERGE, ...config }))
  const out = []
  const err = []
  const calls = []
  const io = {
    cwd: root,
    home,
    now: () => Date.parse('2026-11-15T12:00:00Z'),
    out: line => out.push(line),
    err: line => err.push(line),
    exists: existsSync,
    readFile: file => readFileSync(file, 'utf8'),
    writeFile: (file, text) => write(file, text),
    mkdirp: () => {},
    rename: renameSync,
    sh: (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'git' && args.includes('--git-common-dir')) return okRes(`${root}/.git\n${root}/.git\n${root}\n`)
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return okRes(`worktree ${root}\nHEAD 1\nbranch refs/heads/main\n`)
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') return json({ ok: true, result: { worktrees: [] } })
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        const found = (world.prs ?? []).find(one => String(one.number) === args[2])
        return found ? json(found) : fail('not found')
      }
      if (cmd === 'gh' && args[0] === 'api') return fail('HTTP 404')
      return fail(`unexpected call: ${cmd} ${args.join(' ')}`)
    },
  }
  return { io, out, err, calls }
}

const oneJson = h => JSON.parse(h.out[0])

describe('issue #488: claude leaves the worker roster and one record review from the roster', () => {
  test('R1: despachar and revisar refuse claude before touching anything with exact ADR 0006 error; pi, agy and codex still work', async () => {
    const ticketEnv = makeDispatchEnv()
    await assert.rejects(despacharCommand({}, '7', 'claude', ticketEnv.io), error => error.message === EXPECTED_CLAUDE_ERROR)
    assert.deepEqual(ticketEnv.calls, [])
    assert.deepEqual(ticketEnv.writes, [])

    const reviewEnv = makeDispatchEnv()
    await assert.rejects(revisarCommand({}, '9', 'claude', reviewEnv.io), error => error.message === EXPECTED_CLAUDE_ERROR)
    assert.deepEqual(reviewEnv.calls, [])
    assert.deepEqual(reviewEnv.writes, [])

    const home = temp('r488-cli-home')
    for (const args of [['despachar', '7', 'claude'], ['revisar', '9', 'claude']]) {
      const res = cli(home, args)
      assert.equal(res.status, 1, res.out)
      assert.ok(res.out.includes(`✖ ${EXPECTED_CLAUDE_ERROR}`), res.out)
    }

    for (const agent of ['pi', 'agy', 'codex']) {
      const d = makeDispatchEnv()
      assert.equal(await dispatch('ticket', { n: '7', agent, dryRun: true }, d.io), 0, `despachar ${agent}`)
      const impl = agent === 'codex' ? 'agy' : 'codex'
      const r = makeDispatchEnv({ 'gh pr': json({ headRefName: 'feat', headRefOid: HEAD, body: `Implementador: ${impl}`, number: 9 }) })
      assert.equal(await dispatch('review', { n: '9', agent, dryRun: true }, r.io), 0, `revisar ${agent}`)
    }
  })

  test('R2: doctor warns (warn, not fail) when agentes.usa includes claude in any layer, and estado never proposes claude as reviewer', async () => {
    const home = temp('r488-doc-home')
    const repo = temp('r488-doc-repo')
    assert.equal(git(repo, 'init').status, 0)
    const layers = [
      { file: path.join(home, '.orca-stack', 'config.json'), label: '~/.orca-stack/config.json' },
      { file: path.join(repo, '.orca-stack.json'), label: '.orca-stack.json' },
      { file: path.join(repo, '.orca-stack.local.json'), label: '.orca-stack.local.json' },
    ]
    for (const layer of layers) {
      for (const candidate of layers) write(candidate.file, JSON.stringify({ setup: 'completo', agentes: { usa: ['pi'] } }))
      write(layer.file, JSON.stringify({ setup: 'completo', agentes: { usa: ['claude', 'pi'] } }))
      const before = layers.map(c => read(c.file))
      const res = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo })
      assert.match(res.out, new RegExp(`⚠ agente retirado - claude.*se ignora.*${layer.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*agentes\\.usa`), res.out)
      assert.doesNotMatch(res.out, /✖.*claude.*agentes\.usa/, res.out)
      assert.deepEqual(layers.map(c => read(c.file)), before)
    }

    for (const [impl, usa, files] of [
      ['pi', ['claude', 'pi'], ['src/auth/login.mjs']],
      ['pi', ['claude', 'pi'], ['src/a.mjs']],
      ['agy', ['claude', 'agy'], ['src/a.mjs']],
      ['codex', ['claude', 'codex'], ['src/a.mjs']],
    ]) {
      const h = makeEstadoEnv(
        { prs: [prData(70, { body: `Implementador: ${impl}\n\nCloses #7`, files })] },
        { riesgo: ['src/auth/'], agentes: { usa } },
      )
      assert.equal(await estadoCommand({ json: true }, ['70'], h.io), 1)
      const text = oneJson(h).falta.join('\n')
      assert.doesNotMatch(text, /revisar 70 claude/, text)
    }
  })

  test('R3 & R4 example 1: roster pi, agy, codex on pi PR proposes agy (or codex if agy in preguntarAntes) and one clean review of either passes', async () => {
    for (const files of [['src/a.mjs'], ['src/auth/login.mjs']]) {
      const config = { riesgo: ['src/auth/'], agentes: { usa: ['pi', 'agy', 'codex'], preguntarAntes: [] } }
      const missing = makeEstadoEnv({ prs: [prData(70, { files })] }, config)
      assert.equal(await estadoCommand({ json: true }, ['70'], missing.io), 1)
      assert.ok(oneJson(missing).falta.some(line => line.includes('orca-stack revisar 70 agy')), oneJson(missing).falta.join('\n'))

      const askAgy = makeEstadoEnv({ prs: [prData(70, { files })] }, { ...config, agentes: { usa: ['pi', 'agy', 'codex'], preguntarAntes: ['agy'] } })
      assert.equal(await estadoCommand({ json: true }, ['70'], askAgy.io), 1)
      assert.ok(oneJson(askAgy).falta.some(line => line.includes('orca-stack revisar 70 codex')), oneJson(askAgy).falta.join('\n'))

      for (const reviewer of ['agy', 'codex']) {
        const clean = makeEstadoEnv({ prs: [prData(70, { files, reviews: [review(reviewer, HEAD)] })] }, config)
        assert.equal(await estadoCommand({ json: true }, ['70'], clean.io), 0, `${reviewer} on ${files[0]}`)
        assert.deepEqual(oneJson(clean).falta, [])
      }
    }
  })

  test('R3 & R4 example 2: roster pi, agy with agy blocked asks rebote --rdd risk and clean requested RDD review of pi passes', async () => {
    const config = {
      riesgo: ['src/auth/'],
      agentes: { usa: ['pi', 'agy'] },
      guardia: { bloquear: [{ agente: 'agy', hasta: '2026-11-20', motivo: 'agy sin cuota' }] },
    }
    const req = comment(`RDD: ${HEAD.slice(0, 7)} (risk)`, T(4))
    const rddRev = { body: `Revisor: pi (RDD: risk)\nCommit: ${HEAD}\n\n## BLOQUEA\nnada`, submittedAt: T(6) }

    for (const files of [['src/a.mjs'], ['src/auth/login.mjs']]) {
      const missing = makeEstadoEnv({ prs: [prData(70, { files })] }, config)
      assert.equal(await estadoCommand({ json: true }, ['70'], missing.io), 1)
      const text = oneJson(missing).falta.join('\n')
      assert.ok(text.includes('orca-stack rebote 70 --rdd risk'), text)
      assert.doesNotMatch(text, /revisar 70 agy/, text)

      const passed = makeEstadoEnv({ prs: [prData(70, { files, comments: [req], reviews: [rddRev] })] }, config)
      assert.equal(await estadoCommand({ json: true }, ['70'], passed.io), 0, files[0])
      assert.deepEqual(oneJson(passed).falta, [])
    }

    const bounce = makeDispatchEnv(
      {
        'gh pr': json({ state: 'OPEN', number: 70, headRefName: 'Gagaismo/orca-stack-7', headRefOid: HEAD, baseRefName: 'main', mergeable: 'MERGEABLE', body: 'Implementador: pi\nCloses #7', comments: [], reviews: [], statusCheckRollup: [] }),
        'git worktree': () => okRes(`worktree ${bounce.root}\nbranch refs/heads/main\n\nworktree ${bounce.worktree}\nHEAD ${HEAD}\nbranch refs/heads/Gagaismo/orca-stack-7\n`),
      },
      { agentes: { usa: ['pi', 'agy'], pi: { perfil: 'global' } }, guardia: { bloquear: [{ agente: 'agy', hasta: '2026-11-20' }] } },
    )
    assert.equal(await reboteCommand({ rdd: 'risk', dryRun: true }, '70', bounce.io), 0)
    assert.ok(bounce.out.some(line => line.includes(`RDD: ${HEAD} (risk)`)), bounce.out.join('\n'))
  })

  test('R3 & R4 example 3: roster solo pi asks rebote --rdd risk, never names absent agents, and clean requested RDD review passes', async () => {
    const config = { riesgo: ['src/auth/'], agentes: { usa: ['pi'] } }
    const req = comment(`RDD: ${HEAD.slice(0, 7)} (risk)`, T(4))
    const rddRev = { body: `Revisor: pi (RDD: risk)\nCommit: ${HEAD}\n\n## BLOQUEA\nnada`, submittedAt: T(6) }

    for (const files of [['src/a.mjs'], ['src/auth/login.mjs']]) {
      const missing = makeEstadoEnv({ prs: [prData(70, { files })] }, config)
      assert.equal(await estadoCommand({ json: true }, ['70'], missing.io), 1)
      const text = oneJson(missing).falta.join('\n')
      assert.ok(text.includes('orca-stack rebote 70 --rdd risk'), text)
      assert.doesNotMatch(text, /\b(agy|codex|claude)\b/i, text)

      const unrequested = makeEstadoEnv({ prs: [prData(70, { files, reviews: [rddRev] })] }, config)
      assert.equal(await estadoCommand({ json: true }, ['70'], unrequested.io), 1, 'unrequested RDD must not count')

      const passed = makeEstadoEnv({ prs: [prData(70, { files, comments: [req], reviews: [rddRev] })] }, config)
      assert.equal(await estadoCommand({ json: true }, ['70'], passed.io), 0, files[0])
      assert.deepEqual(oneJson(passed).falta, [])
    }
  })

  test('R5 negatives: agy PR with roster pi, agy gets pi review (never agy); riesgo second review by pi and RDD mode markers stay unchanged', async () => {
    const agyConfig = { riesgo: ['src/auth/'], agentes: { usa: ['pi', 'agy'] } }
    const agyPr = { body: 'Implementador: agy\n\nCloses #7', files: ['src/a.mjs'] }

    const agySelf = makeEstadoEnv({ prs: [prData(70, { ...agyPr, reviews: [review('agy', HEAD)] })] }, agyConfig)
    assert.equal(await estadoCommand({ json: true }, ['70'], agySelf.io), 1)
    assert.ok(oneJson(agySelf).falta.some(line => line.includes('orca-stack revisar 70 pi')), oneJson(agySelf).falta.join('\n'))
    assert.doesNotMatch(oneJson(agySelf).falta.join('\n'), /revisar 70 agy/)

    const agyByPi = makeEstadoEnv({ prs: [prData(70, { ...agyPr, reviews: [review('pi', HEAD)] })] }, agyConfig)
    assert.equal(await estadoCommand({ json: true }, ['70'], agyByPi.io), 0)

    const riskConfig = { riesgo: ['src/auth/'], agentes: { usa: ['pi', 'agy', 'codex'] } }
    const codexRisk = makeEstadoEnv({ prs: [prData(70, { body: 'Implementador: codex\n\nCloses #7', files: ['src/auth/login.mjs'], reviews: [review('agy', HEAD)] })] }, riskConfig)
    assert.equal(await estadoCommand({ json: true }, ['70'], codexRisk.io), 1)
    assert.ok(oneJson(codexRisk).falta.some(line => line.includes('falta un review de pi sobre el commit') && line.includes('orca-stack revisar 70 pi')))

    const codexRiskBoth = makeEstadoEnv({ prs: [prData(70, { body: 'Implementador: codex\n\nCloses #7', files: ['src/auth/login.mjs'], reviews: [review('agy', HEAD), review('pi', HEAD)] })] }, riskConfig)
    assert.equal(await estadoCommand({ json: true }, ['70'], codexRiskBoth.io), 0)

    const rddConfig = { riesgo: ['src/auth/'], agentes: { usa: ['pi', 'agy', 'codex'], pi: { review: 'rdd' } } }
    const req = comment(`RDD: ${HEAD.slice(0, 7)} (risk)`, T(4))
    const rddRev = { body: `Revisor: pi (RDD: risk)\nCommit: ${HEAD}\n\n## BLOQUEA\nnada`, submittedAt: T(6) }
    const rddOk = makeEstadoEnv({ prs: [prData(70, { files: ['src/auth/login.mjs'], comments: [req], reviews: [rddRev] })] }, rddConfig)
    assert.equal(await estadoCommand({ json: true }, ['70'], rddOk.io), 0)

    const sinOnRisk = makeEstadoEnv({ prs: [prData(70, { files: ['src/auth/login.mjs'], comments: [comment(`Sin review: trivial\nCommit: ${HEAD}`)] })] }, rddConfig)
    assert.equal(await estadoCommand({ json: true }, ['70'], sinOnRisk.io), 1)
  })

  test('R6: CONTRATO.md, AGENTS.md, MAIN.md step 6, docs/manual.md and README.md document rules 1-4 without removing Claude Code wrapper', () => {
    const contract = read(path.join(PACKAGE_ROOT, 'assets', 'stack', 'CONTRATO.md'))
    const agents = read(path.join(PACKAGE_ROOT, 'AGENTS.md'))
    const mainDoc = read(path.join(PACKAGE_ROOT, 'assets', 'stack', 'MAIN.md'))
    const manual = read(path.join(PACKAGE_ROOT, 'docs', 'manual.md'))
    const readme = read(path.join(PACKAGE_ROOT, 'README.md'))
    const step6 = mainDoc.split(/\r?\n/).find(line => line.startsWith('6. ')) ?? ''

    assert.equal(contract.includes('| claude (worker) |'), false)
    assert.match(contract, /`?claude`? ya no es un agente worker/i)
    assert.match(contract, /roster/i)
    assert.match(contract, /orca-stack rebote <pr> --rdd/)
    const rendered = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md', perks: perksOf({}) })
    assert.equal(upsertBlock(agents, rendered), agents, 'AGENTS.md managed block must match CONTRATO.md')

    assert.match(step6, /`?claude`? ya no es un agente worker/i)
    assert.match(step6, /roster/i)
    assert.match(step6, /un review cruzado|un review limpio/i)
    assert.match(step6, /preguntarAntes/)
    assert.match(step6, /orca-stack rebote <pr> --rdd/)
    assert.doesNotMatch(step6, /dos reviews limpios de dos familias/)

    for (const [name, doc] of [['docs/manual.md', manual], ['README.md', readme]]) {
      assert.match(doc, /`?claude`? ya no es un agente worker/i, name)
      assert.match(doc, /roster/i, name)
      assert.doesNotMatch(doc, /dos reviews limpios de dos familias/, name)
    }

    assert.ok(WRAPPERS.claude, 'WRAPPERS.claude stays intact')
  })

  test('PRESERVE: CLI main, doctorCommand, estadoCommand and reboteCommand keep existing behavior', async () => {
    const h = makeEstadoEnv({ prs: [prData(70, { body: 'Implementador: codex\n\nCloses #7', reviews: [review('agy', HEAD)] })] })
    assert.equal(await main(['estado', '70', '--json'], h.io), 0)
    assert.equal(oneJson(h).ok, true)

    const docHome = temp('r488-pres-home')
    const prev = process.env.ORCA_STACK_HOME
    process.env.ORCA_STACK_HOME = docHome
    try {
      const code = await doctorCommand({ offline: true, skipPi: true })
      assert.ok(code === 0 || code === 1)
    } finally {
      if (prev === undefined) delete process.env.ORCA_STACK_HOME
      else process.env.ORCA_STACK_HOME = prev
    }
  })
})
