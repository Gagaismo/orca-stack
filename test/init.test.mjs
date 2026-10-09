import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { backups, cleanup, cli, git, read, snapshot, tempDir, write } from './helpers.mjs'

let home
let repo
beforeEach(() => {
  home = tempDir('home')
  repo = path.join(tempDir('repo'), 'proyecto')
  write(path.join(repo, 'README.md'), '# proyecto\n')
  git(repo, 'init', '-q', '-b', 'main')
})
afterEach(() => {
  cleanup(home)
  cleanup(path.dirname(repo))
})

const run = (...args) => cli(home, ['init', ...args], { cwd: repo })

describe('init', () => {
  test('--dry-run writes nothing', () => {
    const before = snapshot(repo)
    const result = run('--dry-run')
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /\[simulación\]/)
    assert.deepEqual(snapshot(repo), before)
  })

  test('creates the blocks, the two config files and the .gitignore entry, with portable paths only', () => {
    const result = run()
    assert.equal(result.status, 0, result.out)
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const text = read(path.join(repo, file))
      assert.match(text, /<!-- orca-stack:begin -->[\s\S]*<!-- orca-stack:end -->/, file)
      assert.ok(text.includes('~/orca/stack/ORCA-STACK.md'), file)
      assert.ok(!text.includes(home), `${file} must not contain the home path`)
      assert.doesNotMatch(text, /[A-Z]:\\Users\\|\/Users\/|\/home\//, file)
    }
    assert.match(read(path.join(repo, 'CLAUDE.md')), /AGENTS\.md/)
    assert.ok(read(path.join(repo, 'CLAUDE.md')).split('\n').length < 15, 'CLAUDE.md keeps the short block')
    assert.deepEqual(JSON.parse(read(path.join(repo, '.orca-stack.json'))), { version: 1 })
    // Empty: any list here would replace the committed and personal ones (lists are not merged).
    assert.deepEqual(JSON.parse(read(path.join(repo, '.orca-stack.local.json'))), {})
    assert.ok(read(path.join(repo, '.gitignore')).split(/\r?\n/).includes('.orca-stack.local.json'))
  })

  test('AGENTS.md carries the full work contract and the policy lines; the contract is the same in every project', () => {
    const result = run()
    assert.match(result.out, /el bloque orca-stack ahora lleva el contrato de trabajo completo/)
    const text = read(path.join(repo, 'AGENTS.md'))
    assert.ok(text.includes('### Qué rol tenés'))
    assert.ok(text.includes('## Reglas'))
    assert.ok(text.includes('cliente') && text.includes('inferido'))
    assert.ok(text.includes('agenda de la próxima llamada con el cliente'))
    assert.ok(text.includes('guion de demo'))
    assert.ok(text.includes('al menos un ejemplo negativo'))
    assert.doesNotMatch(text, /cada ticket lleva.*## Modos de falla/s)
    assert.ok(text.includes('## BLOQUEA'))
    assert.ok(text.includes('### Política del stack'))
    assert.doesNotMatch(text, /gpt-6|2026-10/)
    assert.ok(text.includes('Commit: <sha>') && text.includes('Verificado por main:'))
    assert.match(text, /despliegue.*pruebaFuncional.*recorrido real.*destino permitido/i)
    assert.ok(text.includes('después de cada deploy, también los que cambian solo configuración'))
    assert.ok(text.includes('atraviese los mismos controles que una llamada normal y llegue a un destino permitido'))
    assert.ok(text.includes('Con `{ "despues": false }` no se despliega ni se verifica'))
    assert.ok(text.includes('Si la verificación falla, avisale al humano de inmediato'))
    const setup = read(path.join(process.cwd(), 'assets', 'skills', 'orca-setup', 'SKILL.md'))
    assert.ok(setup.includes('Guardalo como `despliegue.pruebaFuncional` en `.orca-stack.json`'))
    assert.ok(setup.includes('Si `despues` es `false`, no preguntes ni configures verificación'))
    assert.doesNotMatch(text, /model_provider=cc|auth.json/, 'launchers live in ORCA-STACK.md')
    const other = path.join(tempDir('repo'), 'otro')
    write(path.join(other, 'README.md'), '# otro\n')
    git(other, 'init', '-q', '-b', 'main')
    try {
      cli(home, ['init'], { cwd: other })
      assert.equal(read(path.join(other, 'AGENTS.md')), text)
    } finally {
      cleanup(path.dirname(other))
    }
    assert.doesNotMatch(run().out, /contrato de trabajo completo/, 'quiet when nothing changes')
  })

  test('is idempotent and never overwrites an existing config', () => {
    run()
    write(path.join(repo, '.orca-stack.json'), '{"despacho":{"script":"scripts/x.sh"}}\n')
    const before = snapshot(repo)
    const second = run()
    assert.equal(second.status, 0, second.out)
    assert.deepEqual(snapshot(repo), before)
    assert.deepEqual(backups(home), [])
    const ignore = read(path.join(repo, '.gitignore')).split(/\r?\n/).filter(line => line === '.orca-stack.local.json')
    assert.equal(ignore.length, 1)
  })

  test('keeps existing AGENTS.md content and appends .gitignore without losing lines', () => {
    write(path.join(repo, 'AGENTS.md'), '# Contrato\n\nReglas propias.\n')
    write(path.join(repo, '.gitignore'), 'node_modules/')
    run()
    const agents = read(path.join(repo, 'AGENTS.md'))
    assert.ok(agents.startsWith('# Contrato\n\nReglas propias.\n'))
    assert.equal(read(path.join(repo, '.gitignore')), 'node_modules/\n.orca-stack.local.json\n')
    assert.equal(backups(home).filter(b => b.includes('AGENTS.md')).length, 1)
  })

  // Claude Code skips its own AGENTS.md loading once a CLAUDE.md exists, so the import is what loads the contract.
  const imports = text => text.split(/\r?\n/).filter(line => line.trim() === '@AGENTS.md').length

  test('a new CLAUDE.md imports AGENTS.md instead of asking to read it', () => {
    run()
    const text = read(path.join(repo, 'CLAUDE.md'))
    assert.equal(imports(text), 1)
    assert.doesNotMatch(text, /Política canónica/, 'the policy is loaded once, through AGENTS.md')
  })

  test('an existing CLAUDE.md keeps its content and gets the import inside the block', () => {
    write(path.join(repo, 'CLAUDE.md'), '# CLAUDE.md\n\nEl contrato de trabajo es AGENTS.md. Leelo entero.\n')
    run()
    const text = read(path.join(repo, 'CLAUDE.md'))
    assert.ok(text.startsWith('# CLAUDE.md\n\nEl contrato de trabajo es AGENTS.md. Leelo entero.\n'))
    const block = text.slice(text.indexOf('<!-- orca-stack:begin -->'))
    assert.equal(imports(block), 1)
    assert.doesNotMatch(block, /Política canónica/, 'short block')
  })

  test('a CLAUDE.md with many rules also gets the short block, not the policy twice', () => {
    write(path.join(repo, 'CLAUDE.md'), Array.from({ length: 20 }, (_, i) => `Regla ${i}`).join('\n') + '\n')
    run()
    const text = read(path.join(repo, 'CLAUDE.md'))
    assert.equal(imports(text), 1)
    assert.doesNotMatch(text, /Política canónica/)
  })

  test('a CLAUDE.md that already imports AGENTS.md is not given a second import', () => {
    write(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n')
    run()
    assert.equal(imports(read(path.join(repo, 'CLAUDE.md'))), 1)
  })

  test('migrates the legacy orca-stack:auto block instead of adding a second one', () => {
    const legacy = '<!-- orca-stack:auto -->\n## Orca Stack integration\n\nRead C:\\Users\\x\\orca\\stack\\ORCA-STACK.md.\n<!-- /orca-stack:auto -->\n'
    write(path.join(repo, 'AGENTS.md'), `# Contrato\n\n${legacy}\n## TestSprite\n`)
    write(path.join(repo, 'CLAUDE.md'), `# CLAUDE.md\n\n${legacy}`)
    const result = run()
    assert.equal(result.status, 0, result.out)
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const text = read(path.join(repo, file))
      assert.doesNotMatch(text, /orca-stack:auto/, file)
      assert.doesNotMatch(text, /C:\\Users/, file)
      assert.equal(text.split('<!-- orca-stack:begin -->').length, 2, file)
    }
    assert.match(read(path.join(repo, 'AGENTS.md')), /<!-- orca-stack:end -->\n\n## TestSprite\n$/)
  })

  test('fails clearly outside a git repo', () => {
    const outside = tempDir('outside')
    try {
      const result = cli(home, ['init'], { cwd: outside })
      assert.equal(result.status, 1)
      assert.match(result.out, /no es un repo de git/)
      assert.equal(existsSync(path.join(outside, 'AGENTS.md')), false)
    } finally {
      cleanup(outside)
    }
  })
})
