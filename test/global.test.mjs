import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { spawnSync } from 'node:child_process'

import { ROOT, backups, cleanup, cli, git, read, snapshot, tempDir, write } from './helpers.mjs'

const MODS = ['bandeja-mensajes', 'grilling-ok', 'guardia-despacho', 'modo-autonomo', 'puente-gentle', 'reloj-cache', 'tablero-despacho']

let home
beforeEach(() => {
  home = tempDir('home')
})
afterEach(() => cleanup(home))

const settingsPath = () => path.join(home, '.claude', 'settings.json')
const claudeMdPath = () => path.join(home, '.claude', 'CLAUDE.md')

describe('global', () => {
  test('--dry-run writes nothing at all', () => {
    const before = snapshot(home)
    const result = cli(home, ['global', '--dry-run', '--skip-pi'])
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /\[simulación\]/)
    assert.match(result.out, /CLAUDE_CODE_PLUGIN_DIRS/)
    assert.deepEqual(snapshot(home), before)
    assert.equal(existsSync(path.join(home, '.orca-stack')), false)
  })

  test('installs policy, wrappers, skills, mods, settings, CLAUDE.md block, config and state', () => {
    const result = cli(home, ['global', '--skip-pi', '--humano', 'Ana'])
    assert.equal(result.status, 0, result.out)
    const ext = process.platform === 'win32' ? 'cmd' : 'sh'
    for (const agent of ['claude', 'codex', 'agy']) {
      assert.ok(existsSync(path.join(home, 'orca', 'stack', 'scripts', `${agent}-orca-stack.${ext}`)), agent)
    }
    assert.ok(existsSync(path.join(home, 'orca', 'stack', 'ORCA-STACK.md')))
    assert.doesNotMatch(read(path.join(home, 'orca', 'stack', 'ORCA-STACK.md')), /\{\{/)
    for (const root of ['.claude', '.agents']) {
      const policy = read(path.join(home, root, 'skills', 'orca-stack-policy', 'SKILL.md'))
      assert.ok(policy.includes(path.join(home, 'orca', 'stack', 'ORCA-STACK.md')), 'policy path rendered')
      assert.ok(existsSync(path.join(home, root, 'skills', 'ponytail-review', 'SKILL.md')))
    }
    for (const mod of MODS) {
      assert.ok(existsSync(path.join(home, '.claude', 'mods', mod, '.claude-plugin', 'plugin.json')), mod)
      assert.ok(existsSync(path.join(home, '.claude', 'mods', mod, 'hooks', 'hooks.json')), mod)
    }
    assert.equal(existsSync(path.join(home, '.claude', 'mods', 'puente-gentle', 'tests')), false)
    const dirs = JSON.parse(read(settingsPath())).env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter)
    assert.deepEqual(dirs, MODS.map(m => path.join(home, '.claude', 'mods', m)))
    assert.match(read(claudeMdPath()), /<!-- orca-stack:begin -->[\s\S]*<!-- orca-stack:end -->/)
    assert.match(read(claudeMdPath()), /Política canónica/)
    assert.doesNotMatch(read(claudeMdPath()), /### Qué rol tenés|## BLOQUEA/, 'the global block never carries the project work contract')
    assert.deepEqual(JSON.parse(read(path.join(home, '.orca-stack', 'config.json'))), { humano: 'Ana' })
    assert.equal(JSON.parse(read(path.join(home, '.orca-stack', 'state.json'))).tool, 'orca-stack')
  })

  test('a second run is idempotent: same bytes, no backups, no duplicate plugin dirs', () => {
    cli(home, ['global', '--skip-pi', '--humano', 'Ana'])
    const first = snapshot(home)
    const second = cli(home, ['global', '--skip-pi', '--humano', 'Ana'])
    assert.equal(second.status, 0, second.out)
    assert.deepEqual(snapshot(home), first)
    assert.deepEqual(backups(home), [])
    const dirs = JSON.parse(read(settingsPath())).env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter)
    assert.equal(new Set(dirs).size, dirs.length)
  })

  test('settings.json merge keeps foreign keys and the existing plugin dirs, and remove restores them', () => {
    const foreign = path.join(home, 'mis-mods', 'otro')
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(git status)'] },
      env: { FOO: 'bar', CLAUDE_CODE_PLUGIN_DIRS: foreign },
      hooks: { Stop: [] },
    }
    write(settingsPath(), JSON.stringify(original, null, 2) + '\n')
    const result = cli(home, ['global', '--skip-pi'])
    assert.equal(result.status, 0, result.out)
    const merged = JSON.parse(read(settingsPath()))
    assert.equal(merged.model, 'opus')
    assert.deepEqual(merged.permissions, original.permissions)
    assert.deepEqual(merged.hooks, original.hooks)
    assert.equal(merged.env.FOO, 'bar')
    const dirs = merged.env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter)
    assert.equal(dirs[0], foreign, 'foreign entry stays first')
    assert.equal(dirs.length, 1 + MODS.length)
    assert.equal(backups(home).filter(b => b.includes('settings.json')).length, 1)

    cli(home, ['global', '--skip-pi'])
    assert.equal(JSON.parse(read(settingsPath())).env.CLAUDE_CODE_PLUGIN_DIRS, merged.env.CLAUDE_CODE_PLUGIN_DIRS)

    assert.equal(cli(home, ['remove']).status, 0)
    assert.deepEqual(JSON.parse(read(settingsPath())), original)
  })

  test('a settings.json that is not valid JSON is refused and left untouched', () => {
    write(settingsPath(), '{ nope')
    const result = cli(home, ['global', '--skip-pi'])
    assert.equal(result.status, 1)
    assert.match(result.out, /settings\.json/)
    assert.equal(read(settingsPath()), '{ nope')
  })

  test('CLAUDE.md: the block is replaced in place and everything outside the markers is untouched', () => {
    const before = '# Mis reglas\n\nNo tocar esto.\n'
    const after = '\n<!-- gentle-ai:sdd-orchestrator -->\nbloque ajeno\n<!-- /gentle-ai:sdd-orchestrator -->\n'
    write(claudeMdPath(), before)
    cli(home, ['global', '--skip-pi'])
    let text = read(claudeMdPath())
    assert.ok(text.startsWith(before))
    // someone edits inside the block and adds a foreign block after it
    text = text.replace('Política canónica', 'EDITADO') + after
    write(claudeMdPath(), text)
    const result = cli(home, ['global', '--skip-pi'])
    assert.equal(result.status, 0, result.out)
    const replaced = read(claudeMdPath())
    assert.ok(!replaced.includes('EDITADO'))
    assert.ok(replaced.startsWith(before))
    assert.ok(replaced.endsWith(after))
    assert.equal(replaced.match(/orca-stack:begin/g).length, 1)

    cli(home, ['remove'])
    assert.equal(read(claudeMdPath()), before + after.replace(/^\n/, '\n'))
  })

  test('with --force a different pre-existing file is backed up (outside its folder) and restored by remove', () => {
    const file = path.join(home, 'orca', 'stack', 'ORCA-STACK.md')
    write(file, 'mi versión')
    cli(home, ['global', '--skip-pi', '--force'])
    assert.notEqual(read(file), 'mi versión')
    const saved = backups(home).filter(b => b.includes('ORCA-STACK.md'))
    assert.equal(saved.length, 1)
    assert.ok(saved[0].startsWith('.orca-stack/backups/'), saved[0])
    cli(home, ['remove'])
    assert.equal(read(file), 'mi versión')
  })

  test('install then remove leaves the home as it was, apart from backups', () => {
    const pristine = snapshot(home)
    assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
    assert.notDeepEqual(snapshot(home), pristine)
    const dry = snapshot(home)
    assert.equal(cli(home, ['remove', '--dry-run']).status, 0)
    assert.deepEqual(snapshot(home), dry, 'remove --dry-run changes nothing')
    const removed = cli(home, ['remove'])
    assert.equal(removed.status, 0, removed.out)
    const left = Object.keys(snapshot(home)).filter(name => !name.includes('.orca-stack/backups/'))
    assert.deepEqual(
      left.filter(name => !name.endsWith('/')),
      [],
    )
    assert.equal(existsSync(path.join(home, '.orca-stack', 'state.json')), false)
  })

  test('remove keeps a config.json the user edited', () => {
    cli(home, ['global', '--skip-pi', '--humano', 'Ana'])
    const config = path.join(home, '.orca-stack', 'config.json')
    write(config, JSON.stringify({ humano: 'Ana', mensajes: { destinatarios: ['Beto'] } }))
    cli(home, ['remove'])
    assert.ok(existsSync(config))
  })

  test('remove without an install says there is nothing to undo', () => {
    const result = cli(home, ['remove'])
    assert.equal(result.status, 0)
    assert.match(result.out, /nada que deshacer/)
  })
})

describe('wrappers', () => {
  test('the wrapper of this platform passes its own self-test', () => {
    cli(home, ['global', '--skip-pi'])
    const ext = process.platform === 'win32' ? 'cmd' : 'sh'
    const file = path.join(home, 'orca', 'stack', 'scripts', `claude-orca-stack.${ext}`)
    const run = spawnSync(file, ['--orca-stack-self-test'], { encoding: 'utf8', shell: process.platform === 'win32' })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /ORCA_STACK_MODE=auto/)
    assert.match(run.stdout, /ORCA_STACK_CAVEMAN_LEVEL=full/)
    assert.match(run.stdout, /ORCA_STACK_PONYTAIL_LEVEL=full/)
    assert.ok(run.stdout.includes(path.join(home, 'orca', 'stack', 'ORCA-STACK.md')), run.stdout)
  })

  test('the POSIX flavour is generated on request and passes its self-test under sh', t => {
    const result = cli(home, ['global', '--skip-pi'], { env: { ORCA_STACK_PLATFORM: 'linux' } })
    assert.equal(result.status, 0, result.out)
    for (const agent of ['claude', 'codex', 'agy']) {
      assert.ok(existsSync(path.join(home, 'orca', 'stack', 'scripts', `${agent}-orca-stack.sh`)), agent)
    }
    const sh = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' })
    if (sh.status !== 0) {
      t.skip('sh no disponible')

      return
    }
    const file = path.join(home, 'orca', 'stack', 'scripts', 'agy-orca-stack.sh')
    const run = spawnSync('sh', [file, '--orca-stack-self-test'], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /ORCA_STACK_MODE=auto/)
    assert.match(run.stdout, /ORCA_STACK_POLICY_PATH=.*ORCA-STACK\.md/)
    // never named like the real binary, so it cannot call itself
    assert.ok(!existsSync(path.join(home, 'orca', 'stack', 'scripts', 'agy')))
  })
})

describe('doctor', () => {
  test('a clean offline install passes; a missing wrapper fails with a non-zero exit', () => {
    cli(home, ['global', '--skip-pi', '--humano', 'Ana'])
    const ok = cli(home, ['doctor', '--offline', '--skip-pi'])
    assert.equal(ok.status, 0, ok.out)
    assert.match(ok.out, /✔ claude-orca-stack --orca-stack-self-test/)
    assert.match(ok.out, /✔ tablero-despacho/)
    const ext = process.platform === 'win32' ? 'cmd' : 'sh'
    cli(home, ['remove', '--dry-run'])
    write(path.join(home, 'orca', 'stack', 'scripts', `codex-orca-stack.${ext}`), 'roto')
    const broken = cli(home, ['doctor', '--offline', '--skip-pi'])
    assert.equal(broken.status, 1)
    assert.match(broken.out, /✖ codex-orca-stack/)
  })

  test('a mod missing from CLAUDE_CODE_PLUGIN_DIRS is reported', () => {
    cli(home, ['global', '--skip-pi'])
    const settings = JSON.parse(read(settingsPath()))
    settings.env.CLAUDE_CODE_PLUGIN_DIRS = settings.env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter).slice(1).join(path.delimiter)
    write(settingsPath(), JSON.stringify(settings))
    const result = cli(home, ['doctor', '--offline', '--skip-pi'])
    assert.equal(result.status, 1)
    assert.match(result.out, /✖ bandeja-mensajes - no está en env\.CLAUDE_CODE_PLUGIN_DIRS/)
  })

  test('checks despacho with the same layering as the mods (committed, then local)', () => {
    cli(home, ['global', '--skip-pi'])
    const repo = path.join(tempDir('repo'), 'proyecto')
    write(path.join(repo, 'README.md'), '# proyecto\n')
    git(repo, 'init', '-q', '-b', 'main')
    const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo })
    try {
      write(path.join(repo, '.orca-stack.local.json'), '{"despacho":{"script":"scripts/despachar.sh"}}\n')
      assert.match(doctor().out, /⚠ despacho\.script - scripts\/despachar\.sh no existe en el proyecto/)

      write(path.join(repo, '.orca-stack.json'), '{"version":1,"despacho":{"script":"scripts/despachar.sh"}}\n')
      write(path.join(repo, '.orca-stack.local.json'), '{"despacho":null}\n')
      assert.doesNotMatch(doctor().out, /despacho\.script/)
    } finally {
      cleanup(path.dirname(repo))
    }
  })

  test('the machine-specific launchers live in the rendered ORCA-STACK.md, not in the project contract', () => {
    cli(home, ['global', '--skip-pi'])
    const policy = read(path.join(home, 'orca', 'stack', 'ORCA-STACK.md'))
    assert.match(policy, /Launching agents for a manual dispatch/)
    assert.doesNotMatch(policy, /{{[A-Z_]+}}/)
    for (const agent of ['claude:', 'agy:', 'codex:', 'codex-cc:']) assert.ok(policy.includes(`- ${agent}`), agent)
    assert.match(policy, /claude-orca-stack/)
    assert.match(policy, /model_provider=cc/)
    const contract = read(path.join(ROOT, 'assets', 'stack', 'CONTRATO.md'))
    assert.doesNotMatch(contract, /model_provider=cc|orca-stack.cmd|auth.json/)
  })

  test('warns about a legacy block and a pending setup, and stays quiet once both are fixed', () => {
    cli(home, ['global', '--skip-pi'])
    const repo = path.join(tempDir('repo'), 'proyecto')
    write(path.join(repo, 'README.md'), '# proyecto\n')
    git(repo, 'init', '-q', '-b', 'main')
    const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo })
    try {
      write(path.join(repo, 'AGENTS.md'), '<!-- orca-stack:auto -->\nviejo\n<!-- /orca-stack:auto -->\n')
      write(path.join(repo, '.orca-stack.json'), '{"version":1}\n')
      const warned = doctor()
      assert.match(warned.out, /⚠ AGENTS\.md: bloque orca-stack viejo - `orca-stack init` lo migra y además agrega el contrato de trabajo completo/)
      assert.match(warned.out, /⚠ \.orca-stack\.json: setup pendiente - abrí una sesión de Claude en el checkout principal/)

      write(path.join(repo, 'AGENTS.md'), '# Contrato\n')
      write(path.join(repo, '.orca-stack.json'), '{"version":1,"setup":"completo"}\n')
      const clean = doctor()
      assert.doesNotMatch(clean.out, /bloque orca-stack viejo|setup pendiente/)
    } finally {
      cleanup(path.dirname(repo))
    }
  })

  test('reads the Orca agent overrides without writing', () => {
    cli(home, ['global', '--skip-pi'])
    const orca = path.join(home, 'orca-app')
    const ext = process.platform === 'win32' ? 'cmd' : 'sh'
    const scripts = path.join(home, 'orca', 'stack', 'scripts')
    const data = JSON.stringify({
      settings: {
        agentCmdOverrides: {
          claude: path.join(scripts, `claude-orca-stack.${ext}`),
          codex: '/otro/codex',
        },
      },
    })
    write(path.join(orca, 'profiles', 'p1', 'orca-data.json'), data)
    const before = snapshot(orca)
    const result = cli(home, ['doctor', '--offline', '--skip-pi'], { env: { ORCA_STACK_ORCA_DIR: orca } })
    assert.match(result.out, /✔ Orca \[p1\] claude - apunta al wrapper/)
    assert.match(result.out, /⚠ Orca \[p1\] codex - apunta a \/otro\/codex/)
    assert.match(result.out, /⚠ Orca \[p1\] antigravity - sin override/)
    assert.deepEqual(snapshot(orca), before)
  })
})
