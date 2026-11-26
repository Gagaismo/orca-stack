import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { estadoCommand } from '../src/estado.mjs'
import { upsertBlock } from '../src/marker.mjs'
import { policyBlock } from '../src/templates.mjs'
import { sha256 } from '../src/util.mjs'
import { SHARED_USERS, FIXTURE_USERS } from '../scripts/sync-shared.mjs'
import { cleanup, cli, read, ROOT, tempDir, write } from './helpers.mjs'

const ACTIVE_MODS = [
  'bandeja-mensajes',
  'grilling-ok',
  'guardia-despacho',
  'main-md',
  'marchas',
  'modo-autonomo',
  'reloj-cache',
  'tablero-despacho',
]

const seedInstalledPuente = home => {
  const modDir = path.join(home, '.claude', 'mods', 'puente-gentle')
  const files = {}
  for (const [rel, content] of [
    ['.claude-plugin/plugin.json', '{"name":"puente-gentle"}\n'],
    ['hooks/hooks.json', '{"modules":["register.tsx"]}\n'],
    ['hooks/puente.ts', 'export const OLD = true\n'],
  ]) {
    const file = path.join(modDir, ...rel.split('/'))
    write(file, content)
    files[file] = { sha256: sha256(Buffer.from(content, 'utf8')), backup: null, existedBefore: false }
  }
  write(path.join(modDir, '.claude-plugin', 'types', 'index.d.ts'), 'export {}\n')

  const settingsFile = path.join(home, '.claude', 'settings.json')
  const otherDir = path.join(home, '.claude', 'mods', 'bandeja-mensajes')
  write(settingsFile, JSON.stringify({
    env: {
      CLAUDE_CODE_PLUGIN_DIRS: [otherDir, modDir].join(path.delimiter),
    },
  }, null, 2) + '\n')

  write(path.join(home, '.orca-stack', 'state.json'), JSON.stringify({
    schema: 1,
    tool: 'orca-stack',
    version: '0.24.0',
    installedAt: '2026-11-25T00:00:00.000Z',
    files,
    dirsCreated: [],
    mods: ['bandeja-mensajes', 'puente-gentle'],
    skills: [],
    settings: {
      file: settingsFile,
      pluginDirsAdded: [otherDir, modDir],
      createdFile: false,
      createdEnv: false,
      createdKey: false,
    },
    claudeMd: null,
    codexAgentsMd: null,
    config: null,
    pi: { packagesInstalled: [], npmGlobalInstalled: false, piInstalled: false },
    backups: [],
  }, null, 2))

  return { modDir, settingsFile, files }
}

const HEAD = 'abc1234000000000000000000000000000000001'
const T = minute => `2026-11-25T10:${String(minute).padStart(2, '0')}:00Z`
const comment = (body, createdAt = T(1)) => ({ body, createdAt })
const review = (body, submittedAt = T(1)) => ({ body, submittedAt })
const prData = (n, extra = {}) => ({
  number: n,
  headRefOid: HEAD,
  headRefName: `Gagaismo/issue-${n}`,
  baseRefName: 'main',
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  url: `https://github.com/Gagaismo/orca-stack/pull/${n}`,
  body: 'Implementador: claude\n\n## Evidencia\n\n| Rule | Test |\n| --- | --- |\n| R1 | `x` |\n\nCloses #1',
  comments: [],
  reviews: [],
  files: [{ path: 'src/a.mjs' }],
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci-ok', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  ...extra,
})

const estadoHarness = (world, { root, home }) => {
  const out = []
  const err = []
  const io = {
    home,
    now: () => Date.parse('2026-11-25T12:00:00Z'),
    out: line => out.push(line),
    err: line => err.push(line),
    sh: (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return { status: 0, stdout: `${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`, stderr: '' }
      }
      if (cmd === 'git' && args[0] === 'worktree') {
        return { status: 0, stdout: `worktree ${root}\nbranch refs/heads/main\n`, stderr: '' }
      }
      if (cmd === 'orca') {
        return { status: 0, stdout: '[]', stderr: '' }
      }
      if (cmd === 'gh' && args[0] === 'api' && args.some(a => a.includes('/contents/.orca-stack.json'))) {
        if (world.baseConfig !== undefined) return { status: 0, stdout: world.baseConfig, stderr: '' }
        return { status: 1, stdout: '', stderr: '404' }
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        const pr = world.prs.find(p => String(p.number) === String(args[2]))
        return pr ? { status: 0, stdout: JSON.stringify(pr), stderr: '' } : { status: 1, stdout: '', stderr: 'not found' }
      }
      return { status: 1, stdout: '', stderr: `unexpected: ${cmd} ${args.join(' ')}` }
    },
  }

  return { out, err, io }
}

describe('#391 Remove puente-gentle mod and Gentle Shell consult', () => {
  test('S1: puente-gentle mod is deleted, sync-shared drops it, and global no longer installs it or consultar_gentle_shell', () => {
    assert.equal(existsSync(path.join(ROOT, 'mods', 'puente-gentle')), false, 'mods/puente-gentle must be removed')
    assert.equal(SHARED_USERS.includes('puente-gentle'), false, 'SHARED_USERS must not include puente-gentle')
    assert.equal(FIXTURE_USERS.includes('puente-gentle'), false, 'FIXTURE_USERS must not include puente-gentle')

    const home = tempDir('rm391-s1-home')
    try {
      const res = cli(home, ['global', '--skip-pi'])
      assert.equal(res.status, 0, res.out)
      assert.equal(existsSync(path.join(home, '.claude', 'mods', 'puente-gentle')), false)
      const settings = JSON.parse(read(path.join(home, '.claude', 'settings.json')))
      const dirs = settings.env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter)
      assert.equal(dirs.some(d => path.basename(d) === 'puente-gentle'), false, dirs.join('\n'))
      assert.deepEqual(dirs, ACTIVE_MODS.map(m => path.join(home, '.claude', 'mods', m)))
      assert.doesNotMatch(res.out, /puente-gentle|consultar_gentle_shell|el puente/i)
    } finally {
      cleanup(home)
    }
  })

  test('S2a: global removes a previously installed puente-gentle copy, keeps user files with a warning, respects --dry-run, and is idempotent', () => {
    const home = tempDir('rm391-s2a-home')
    try {
      const { modDir, settingsFile } = seedInstalledPuente(home)

      const dry = cli(home, ['global', '--skip-pi', '--dry-run'])
      assert.equal(dry.status, 0, dry.out)
      assert.equal(existsSync(modDir), true, 'dry-run must not delete puente-gentle')
      assert.match(dry.out, /puente-gentle/)

      const first = cli(home, ['global', '--skip-pi'])
      assert.equal(first.status, 0, first.out)
      assert.equal(existsSync(modDir), false, 'global must remove installed puente-gentle folder (including generated types)')
      const dirs = JSON.parse(read(settingsFile)).env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter)
      assert.equal(dirs.some(d => path.basename(d) === 'puente-gentle'), false, dirs.join('\n'))
      const stateAfter = JSON.parse(read(path.join(home, '.orca-stack', 'state.json')))
      assert.equal(stateAfter.mods.includes('puente-gentle'), false)
      assert.equal(Object.keys(stateAfter.files).some(k => k.includes('puente-gentle')), false)
      assert.equal(stateAfter.settings.pluginDirsAdded.some(d => path.basename(d) === 'puente-gentle'), false)

      const second = cli(home, ['global', '--skip-pi'])
      assert.equal(second.status, 0, second.out)
      assert.equal(existsSync(modDir), false)
    } finally {
      cleanup(home)
    }

    const userHome = tempDir('rm391-s2a-user')
    try {
      const { modDir } = seedInstalledPuente(userHome)
      const userFile = path.join(modDir, 'notes.txt')
      write(userFile, 'my notes\n')
      const res = cli(userHome, ['global', '--skip-pi'])
      assert.equal(res.status, 0, res.out)
      assert.equal(read(userFile), 'my notes\n')
      assert.match(res.out, /⚠ .*puente-gentle[\\/]notes\.txt.*no lo instaló orca-stack/i)
    } finally {
      cleanup(userHome)
    }
  })

  test('S2b: doctor stops checking gentle-pi skills as puente-gentle resolves them and warns naming orca-stack global when an old puente-gentle copy remains', () => {
    const home = tempDir('rm391-s2b-home')
    try {
      const install = cli(home, ['global', '--skip-pi'])
      assert.equal(install.status, 0, install.out)
      const clean = cli(home, ['doctor', '--offline', '--skip-pi'])
      assert.doesNotMatch(clean.out, /puente-gentle|skills de gentle-pi/i)

      const modDir = path.join(home, '.claude', 'mods', 'puente-gentle')
      write(path.join(modDir, '.claude-plugin', 'plugin.json'), '{"name":"puente-gentle"}\n')
      const withDir = cli(home, ['doctor', '--offline', '--skip-pi'])
      assert.equal(withDir.status, clean.status, 'warning must not change exit code')
      const warnLine = withDir.out.split(/\r?\n/).find(l => l.includes('puente-gentle'))
      assert.ok(warnLine, `expected puente-gentle warn in:\n${withDir.out}`)
      assert.match(warnLine, /^\s*⚠ /)
      assert.match(warnLine, /orca-stack global/)
    } finally {
      cleanup(home)
    }

    const envHome = tempDir('rm391-s2b-env')
    try {
      assert.equal(cli(envHome, ['global', '--skip-pi']).status, 0)
      const clean = cli(envHome, ['doctor', '--offline', '--skip-pi'])
      const settingsFile = path.join(envHome, '.claude', 'settings.json')
      const settings = JSON.parse(read(settingsFile))
      settings.env.CLAUDE_CODE_PLUGIN_DIRS += path.delimiter + path.join(envHome, '.claude', 'mods', 'puente-gentle')
      write(settingsFile, JSON.stringify(settings, null, 2) + '\n')
      const withEnv = cli(envHome, ['doctor', '--offline', '--skip-pi'])
      assert.equal(withEnv.status, clean.status)
      const warnLine = withEnv.out.split(/\r?\n/).find(l => l.includes('puente-gentle'))
      assert.ok(warnLine, `expected puente-gentle warn for CLAUDE_CODE_PLUGIN_DIRS in:\n${withEnv.out}`)
      assert.match(warnLine, /^\s*⚠ /)
      assert.match(warnLine, /orca-stack global/)
    } finally {
      cleanup(envHome)
    }
  })

  test('S3: src/estado.mjs and src/despacho.mjs comments name estado as the source and stop referencing puente.ts or puente-gentle', () => {
    for (const file of ['src/estado.mjs', 'src/despacho.mjs']) {
      const text = read(path.join(ROOT, file))
      assert.doesNotMatch(text, /puente-gentle|puente\.ts|mirrors\s+mods\/puente/i, file)
    }
  })

  test('S4: estado no longer blocks a PR on a published Gentle Shell consult comment (#446 removed)', async () => {
    const root = tempDir('rm391-s4-root')
    const home = tempDir('rm391-s4-home')
    try {
      write(path.join(root, '.orca-stack.json'), JSON.stringify({ ramaBase: 'main', reviewParaMerge: false }))
      const consultComment = comment(
        `Revisor: pi (consulta cuentas-cuota, publicada por main)\nCommit: ${HEAD}\n\n## BLOQUEA\n1. \`src/x.mjs:1\` (introducido, test, implementación): hallazgo.\n\n## SUGERENCIAS\nnada`,
        T(5),
      )
      const world = {
        prs: [prData(500, { comments: [consultComment] })],
        baseConfig: JSON.stringify({ ramaBase: 'main', reviewParaMerge: false }),
      }
      const hText = estadoHarness(world, { root, home })
      assert.equal(await estadoCommand({}, ['500'], hText.io), 0)
      assert.match(hText.out[0], /falta=$/)

      const hJson = estadoHarness(world, { root, home })
      assert.equal(await estadoCommand({ json: true }, ['500'], hJson.io), 0)
      assert.deepEqual(JSON.parse(hJson.out[0]), { pr: 500, head: HEAD, ok: true, falta: [], merge: null })
    } finally {
      cleanup(root)
      cleanup(home)
    }
  })

  test('S6 (negative): estado still reports missing reviews on riesgo paths and ignores unrequested RDD reviews', async () => {
    const root = tempDir('rm391-s6-root')
    const home = tempDir('rm391-s6-home')
    try {
      const config = {
        ramaBase: 'main',
        riesgo: ['migrations/**'],
        agentes: {
          usa: ['claude', 'agy', 'codex', 'pi'],
          preguntarAntes: [],
          pi: { review: 'rdd' },
          modelos: {
            claude: 'claude-sonnet-5-5',
            pi: 'claude-opus-5-5',
            agy: 'gemini-4-neon-high',
            codex: 'gpt-6-luna',
          },
        },
      }
      write(path.join(root, '.orca-stack.json'), JSON.stringify(config))

      const nonPi = estadoHarness({
        prs: [prData(501, {
          files: [{ path: 'migrations/001.sql' }],
          reviews: [review(`Revisor: agy\nCommit: ${HEAD}\n\n## BLOQUEA\nnada\n\n## SUGERENCIAS\nnada`, T(2))],
        })],
      }, { root, home })
      assert.equal(await estadoCommand({ json: true }, ['501'], nonPi.io), 1)
      const nonPiJson = JSON.parse(nonPi.out[0])
      assert.equal(nonPiJson.ok, false)
      assert.ok(nonPiJson.falta.some(f => f.includes('(d)') && f.includes('orca-stack revisar 501 pi')), nonPiJson.falta.join('\n'))

      const unrequestedRdd = estadoHarness({
        prs: [prData(502, {
          body: 'Implementador: pi\n\n## Evidencia\n\n| Rule | Test |\n| --- | --- |\n| R1 | `x` |\n\nCloses #2',
          files: [{ path: 'migrations/002.sql' }],
          reviews: [review(`Revisor: pi (RDD: risk)\nCommit: ${HEAD}\n\n## BLOQUEA\nnada\n\n## SUGERENCIAS\nnada`, T(2))],
        })],
      }, { root, home })
      assert.equal(await estadoCommand({ json: true }, ['502'], unrequestedRdd.io), 1)
      const unreqJson = JSON.parse(unrequestedRdd.out[0])
      assert.equal(unreqJson.ok, false)
      assert.ok(unreqJson.falta.some(f => f.includes('Un review RDD de pi que main no pidió antes')), unreqJson.falta.join('\n'))

      const requestedRdd = estadoHarness({
        prs: [prData(502, {
          body: 'Implementador: pi\n\n## Evidencia\n\n| Rule | Test |\n| --- | --- |\n| R1 | `x` |\n\nCloses #2',
          files: [{ path: 'migrations/002.sql' }],
          comments: [comment(`RDD: ${HEAD} (risk)`, T(1))],
          reviews: [review(`Revisor: pi (RDD: risk)\nCommit: ${HEAD}\n\n## BLOQUEA\nnada\n\n## SUGERENCIAS\nnada`, T(2))],
        })],
      }, { root, home })
      assert.equal(await estadoCommand({ json: true }, ['502'], requestedRdd.io), 0)
      assert.equal(JSON.parse(requestedRdd.out[0]).ok, true)
    } finally {
      cleanup(root)
      cleanup(home)
    }
  })

  test('S5 & S8: AGENTS.md, CONTRATO.md, MAIN.md, ORCA-STACK.md, docs/, README.md and briefs do not mention puente-gentle, consultar_gentle_shell or Gentle Shell consults', () => {
    const briefs = readdirSync(path.join(ROOT, 'assets', 'stack'))
      .filter(name => name.startsWith('brief-') && name.endsWith('.md'))
      .map(name => ['assets', 'stack', name])
    const targets = [
      ['AGENTS.md'],
      ['README.md'],
      ['assets', 'stack', 'CONTRATO.md'],
      ['assets', 'stack', 'MAIN.md'],
      ['assets', 'stack', 'MARCHAS.md'],
      ['assets', 'stack', 'ORCA-STACK.md'],
      ['assets', 'skills', 'arena', 'SKILL.md'],
      ['docs', 'manual.md'],
      ['docs', 'guia-setup.md'],
      ...briefs,
    ]
    const FORBIDDEN = /puente-gentle|consultar_gentle_shell|consultas?\s+a\s+Gentle\s+Shell|Gentle\s+Shell\s+consult|consult\s+bridge|consulted\s+as\s+a\s+peer|consulta\s+<tema>,\s*publicada\s+por\s+main|consulta\s+confirmada|el\s+puente/i
    for (const parts of targets) {
      const rel = parts.join('/')
      const text = readFileSync(path.join(ROOT, ...parts), 'utf8')
      assert.doesNotMatch(text, FORBIDDEN, `${rel} still references puente-gentle or Gentle Shell consult`)
    }
    const main = readFileSync(path.join(ROOT, 'assets', 'stack', 'MAIN.md'), 'utf8')
    const step6 = main.split(/\r?\n/).find(line => line.startsWith('6. ')) ?? ''
    assert.match(step6, /orca-stack estado|estado/)
    assert.match(step6, /falta/)
  })

  test('S7 (Rule 5): MAIN.md step 5 explains re-arming Monitor after Gentle Shell 1800 s expiry and vigilar resuming without repeating events', () => {
    const main = readFileSync(path.join(ROOT, 'assets', 'stack', 'MAIN.md'), 'utf8')
    const step5 = main.split(/\r?\n/).find(line => line.startsWith('5. ')) ?? ''
    assert.match(step5, /1800\s*s/)
    assert.match(step5, /rearm/i)
    assert.match(step5, /vigilar/)
    assert.match(step5, /sin repetir eventos/i)
  })

  test('PRESERVE: CLI help for rebote and estado, and AGENTS.md contract block sync with policyBlock', () => {
    const home = tempDir('rm391-preserve')
    try {
      const reboteHelp = cli(home, ['rebote', '--help'])
      assert.equal(reboteHelp.status, 0)
      assert.doesNotMatch(reboteHelp.out, /puente-gentle/i)
      assert.match(reboteHelp.out, /estado/)

      const estadoHelp = cli(home, ['estado', '--help'])
      assert.equal(estadoHelp.status, 0)
      assert.doesNotMatch(estadoHelp.out, /puente-gentle|consulta <tema>/i)
    } finally {
      cleanup(home)
    }

    const agents = read(path.join(ROOT, 'AGENTS.md'))
    const blockOff = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md' })
    assert.equal(upsertBlock(agents, blockOff), agents, 'AGENTS.md managed block must stay in sync with CONTRATO.md')
  })
})
