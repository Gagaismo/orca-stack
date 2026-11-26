import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { WORKTREE_INCLUDE, orcaYaml } from '../src/init.mjs'
import { ROOT, backups, cleanup, cli, git, read, snapshot, tempDir, write } from './helpers.mjs'

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
    assert.deepEqual(JSON.parse(read(path.join(repo, '.orca-stack.json'))), { version: 1, lint: { enabled: true, comentarios: { alcance: 'repo' } } })
    // Empty: any list here would replace the committed and personal ones (lists are not merged).
    assert.deepEqual(JSON.parse(read(path.join(repo, '.orca-stack.local.json'))), {})
    assert.ok(read(path.join(repo, '.gitignore')).split(/\r?\n/).includes('.orca-stack.local.json'))
  })

  test('Rule 1: without ~/orca/stack/MAIN.md, init writes the block and warns once naming the file and orca-stack global', () => {
    const result = run()
    assert.equal(result.status, 0, result.out)
    assert.ok(read(path.join(repo, 'AGENTS.md')).includes('<!-- orca-stack:begin -->'))
    const warnings = result.out.split(/\r?\n/).filter(line => line.includes('MAIN.md'))
    assert.deepEqual(warnings, [`⚠ falta ~/orca/stack/MAIN.md, con las reglas de main a las que apunta el bloque: corré \`orca-stack global\``])
    assert.doesNotMatch(result.out, /contrato de trabajo completo/)
  })

  test('Rule 1: with ~/orca/stack/MAIN.md installed, init prints no MAIN.md warning', () => {
    write(path.join(home, 'orca', 'stack', 'MAIN.md'), '## Orca stack: reglas de `main`\n')
    const result = run()
    assert.equal(result.status, 0, result.out)
    assert.doesNotMatch(result.out, /MAIN\.md/)
  })

  test('AGENTS.md carries the full work contract and the policy lines; the contract is the same in every project', () => {
    write(path.join(home, 'orca', 'stack', 'MAIN.md'), '## Orca stack: reglas de `main`\n')
    const result = run()
    assert.match(result.out, /el bloque orca-stack ahora lleva el contrato de trabajo completo/)
    const text = read(path.join(repo, 'AGENTS.md'))
    // Issue 325: main's cycle (steps 1, 2 and 9) moved to MAIN.md; the block sends main there.
    const main = read(path.join(process.cwd(), 'assets', 'stack', 'MAIN.md'))
    assert.ok(text.includes('### Qué rol tenés'))
    assert.ok(text.includes('leé `~/orca/stack/MAIN.md` entero antes de actuar'))
    assert.ok(main.includes('## Reglas'))
    assert.ok(main.includes('cliente') && main.includes('inferido'))
    assert.ok(main.includes('agenda de la próxima llamada con el cliente'))
    assert.ok(main.includes('guion de demo'))
    assert.ok(main.includes('al menos un ejemplo negativo'))
    assert.doesNotMatch(text, /cada ticket lleva.*## Modos de falla/s)
    assert.doesNotMatch(main, /cada ticket lleva.*## Modos de falla/s)
    assert.ok(text.includes('## BLOQUEA'))
    assert.ok(text.includes('### Política del stack'))
    assert.ok(text.includes('implementación con gentle-ai ODD (main corre ODD para su trabajo de orquestación, nunca implementa tickets)'))
    assert.ok(text.includes('Planificación con las skills de Matt Pocock (grill-with-docs, to-spec, to-tickets, disparadas por el humano), e implementación con gentle-ai ODD en todo el stack'))
    for (const doc of [text, main]) assert.doesNotMatch(doc, /sdd/i, 'v4 has no SDD anywhere')
    for (const doc of [text, main]) assert.doesNotMatch(doc, /gpt-6|2026-10/)
    assert.ok(text.includes('Commit: <sha>') && text.includes('Verificado por main:'))
    assert.match(text, /despliegue.*pruebaFuncional.*recorrido real.*destino permitido/i)
    assert.ok(main.includes('después de cada deploy, también los que cambian solo configuración'))
    assert.ok(main.includes('atraviese los mismos controles que una llamada normal y llegue a un destino permitido'))
    assert.ok(main.includes('Con `{ "despues": false }` no se despliega ni se verifica'))
    assert.ok(main.includes('Si la verificación falla, avisale al humano de inmediato'))
    const setup = read(path.join(process.cwd(), 'assets', 'skills', 'orca-setup', 'SKILL.md'))
    assert.ok(setup.includes('Guardalo como `despliegue.pruebaFuncional` en `.orca-stack.json`'))
    assert.ok(setup.includes('Si `despues` es `false`, no preguntes ni configures verificación'))
    for (const doc of [text, main]) assert.doesNotMatch(doc, /model_provider=cc|auth.json/, 'launchers live in ORCA-STACK.md')
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

  // Issue 325: step 9 moved to MAIN.md, so the duplicated line is the MAIN.md pointer that the block keeps.
  test('rerunning init replaces a duplicated MAIN.md pointer line in the existing AGENTS.md block', () => {
    run()
    const agentsPath = path.join(repo, 'AGENTS.md')
    const original = read(agentsPath)
    const pointer = original.match(/^Si sos `main` .*MAIN\.md.*$/m)?.[0]
    assert.ok(pointer, 'generated contract contains the MAIN.md pointer')
    write(agentsPath, original.replace(pointer, `${pointer}\n${pointer}`))

    const result = run()
    assert.equal(result.status, 0, result.out)
    assert.equal((read(agentsPath).match(/^Si sos `main` /gm) ?? []).length, 1)
  })

  test('is idempotent and never overwrites an existing config', () => {
    run()
    write(path.join(repo, '.orca-stack.json'), '{"despacho":{"script":"scripts/x.sh"},"lint":{"enabled":true}}\n')
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

describe('orca-setup: branch protection on ramaBase', () => {
  const setup = () => read(path.join(process.cwd(), 'assets', 'skills', 'orca-setup', 'SKILL.md'))
  const step10 = () => setup().split('\n').find(line => line.startsWith('10. '))
  const written = () => setup().split('## 3. Escribí lo decidido')[1]

  test('rule 1: with CI, step 10 offers strict, one aggregate check and enforce_admins, with the serial-merge cost', () => {
    const step = step10()
    assert.match(step, /ofrecé también proteger `ramaBase`/)
    assert.match(step, /`required_status_checks\.strict = true`/)
    assert.match(step, /un solo check requerido[^.]*job `ci-ok` con `needs:` sobre todos los jobs, `if: always\(\)`/)
    assert.match(step, /`enforce_admins = true`/)
    assert.match(step, /Decí el costo: dentro de una tanda los merges pasan a ser de a uno, cada uno con `gh pr update-branch <n>` y una corrida completa de la CI/)
    assert.match(written(), /La protección de `ramaBase` se aplica con `gh api` solo si el humano dijo que sí/)
  })

  test('rule 2: a 403 asking to upgrade to GitHub Pro is told to the human and the setup goes on without protection', () => {
    assert.match(written(), /Si GitHub responde 403 "Upgrade to GitHub Pro or make this repository public"[^.]*decíselo al humano y seguí el setup sin protección/)
  })

  test('rule 3: without CI and with the proposed CI declined, no protection is offered', () => {
    assert.match(step10(), /Si el repo no tiene CI y el humano no quiso la propuesta, no hay check que exigir: no ofrezcas protección/)
  })

  test('rule 4: an already protected ramaBase shows what is set and proposes only what is missing', () => {
    assert.match(step10(), /Si `ramaBase` ya tiene protección \(`gh api repos\/<owner>\/<repo>\/branches\/<ramaBase>\/protection`\), mostrá lo que está puesto y proponé solo lo que falta/)
  })
})

describe('orca-setup: riesgo globs for single files and match listing (issue #282)', () => {
  const setup = () => read(path.join(process.cwd(), 'assets', 'skills', 'orca-setup', 'SKILL.md'))
  const step9 = () => setup().split('\n').find(line => line.startsWith('9. '))
  const written = () => setup().split('## 3. Escribí lo decidido')[1]

  test('Regla 1: Step 9 of orca-setup says to search for both directories and single files, including a file glob like **/auth.* next to **/auth/**', () => {
    const s9 = step9()
    assert.ok(s9, 'step 9 must exist')
    assert.match(s9, /directorios como archivos individuales/i)
    assert.match(s9, /auth\//)
    assert.match(s9, /auth\.ts/)
    assert.match(s9, /session\.ts/)
    assert.match(s9, /middleware\.ts/)
    assert.match(s9, /\*\.sql/)
    assert.match(s9, /Dockerfile/)
    assert.match(s9, /workflow/)
    assert.match(s9, /`\*\*\/auth\.\*`/)
    assert.match(s9, /`\*\*\/auth\/\*\*`/)
  })

  test('Regla 2: setup lists matching files for every proposed glob with git ls-files, flags unmatched globs as no matchea nada hoy, with the traslado example', () => {
    const s9 = step9()
    assert.ok(s9, 'step 9 must exist')
    assert.match(s9, /`git ls-files`/)
    assert.match(s9, /"no matchea nada hoy"/)
    assert.match(s9, /traslado/)
    assert.match(s9, /`\*\*\/auth\/\*\*` muestra "no matchea nada hoy"/)
    assert.match(s9, /`\*\*\/auth\.\*` muestra `packages\/api\/src\/auth\.ts`/)
  })

  test('Regla 3: setup does not add unaccepted globs and does not touch existing riesgo when rerun unless the human asks', () => {
    const s9 = step9()
    const w = written()
    assert.ok(s9, 'step 9 must exist')
    assert.match(s9, /No agregues ningún glob que el humano no haya aceptado/i)
    assert.match(s9, /no toques un `riesgo` existente al (?:volver a correr|rehacer) el setup (?:a menos|salvo) que el humano lo pida/i)
    assert.match(w, /no toques un `riesgo` existente al (?:volver a correr|reejecutar|rehacer)/i)
  })
})

const entries = text => text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))

describe('#432 orca.yaml and .worktreeinclude', () => {
  const own = name => read(path.join(ROOT, name))

  test('R1: orca-stack commits an orca.yaml whose scripts.setup runs npm install, the same text init generates for a repo with package-lock.json', () => {
    assert.match(own('orca.yaml'), /^scripts:\n {2}setup: \|\n {4}npm install\n$/m)
    write(path.join(repo, 'package-lock.json'), '{}\n')
    assert.equal(run().status, 0)
    assert.equal(read(path.join(repo, 'orca.yaml')), own('orca.yaml'))
  })

  test('R2: .worktreeinclude lists literal gitignored paths only, with .orca-stack.local.json, negative: no glob, no negation and no secret', () => {
    assert.equal(run().status, 0)
    for (const text of [own('.worktreeinclude'), read(path.join(repo, '.worktreeinclude'))]) {
      assert.deepEqual(entries(text), ['.orca-stack.local.json'])
      for (const entry of entries(text)) {
        assert.doesNotMatch(entry, /[*?[\]]|^!/, `${entry} is not a literal path`)
        assert.doesNotMatch(entry, /(^|\/)\.(env)\b|\.ssh|\.pem$|\.key$|credential|secret/i, `${entry} is a secret`)
      }
    }
    assert.equal(git(ROOT, 'check-ignore', '-q', '.orca-stack.local.json').status, 0, 'orca-stack does not ignore the path it copies')
    assert.equal(git(repo, 'check-ignore', '-q', '.orca-stack.local.json').status, 0, 'init does not ignore the path it copies')
  })

  test('R3: negative: a repo with its own orca.yaml and .worktreeinclude keeps them byte for byte and init says it skipped them', () => {
    write(path.join(repo, 'orca.yaml'), 'scripts:\r\n  setup: pnpm i\r\n')
    write(path.join(repo, '.worktreeinclude'), '.vscode/settings.json\n')
    const result = run()
    assert.equal(result.status, 0, result.out)
    assert.equal(read(path.join(repo, 'orca.yaml')), 'scripts:\r\n  setup: pnpm i\r\n')
    assert.equal(read(path.join(repo, '.worktreeinclude')), '.vscode/settings.json\n')
    assert.match(result.out, /^orca\.yaml: ya existe, no se toca$/m)
    assert.match(result.out, /^\.worktreeinclude: ya existe, no se toca$/m)
    assert.deepEqual(backups(home), [])
  })

  test('R4: init sets npm install as the setup step when package-lock.json exists, and writes no setup script when it detects none', () => {
    const none = run()
    assert.equal(none.status, 0, none.out)
    assert.match(none.out, /^creo orca\.yaml$/m)
    assert.match(none.out, /^creo \.worktreeinclude$/m)
    const bare = read(path.join(repo, 'orca.yaml'))
    assert.equal(entries(bare).length, 0, 'no setup script without a detected install step')
    assert.match(bare, /package-lock\.json.*pnpm-lock\.yaml.*yarn\.lock/)
    cleanup(path.join(repo, 'orca.yaml'))
    write(path.join(repo, 'package-lock.json'), '{}\n')
    run()
    assert.deepEqual(entries(read(path.join(repo, 'orca.yaml'))), ['scripts:', 'setup: |', 'npm install'])
  })

  test('R5: running init twice changes nothing the second time', () => {
    write(path.join(repo, 'package-lock.json'), '{}\n')
    assert.equal(run().status, 0)
    const before = snapshot(repo)
    const second = run()
    assert.equal(second.status, 0, second.out)
    assert.deepEqual(snapshot(repo), before)
    assert.deepEqual(backups(home), [])
    assert.doesNotMatch(second.out, /^creo (orca\.yaml|\.worktreeinclude)$/m)
  })

  test('R6: negative: neither orca-stack nor init turns on worktree.sharedDirectories', () => {
    write(path.join(repo, 'package-lock.json'), '{}\n')
    run()
    for (const text of [own('orca.yaml'), read(path.join(repo, 'orca.yaml'))]) {
      assert.deepEqual(entries(text).filter(line => /sharedDirectories|^worktree:/.test(line)), [])
    }
  })

  test('R8: the manual describes both files and what init does with them', () => {
    const manual = read(path.join(ROOT, 'docs', 'manual.md'))
    const initSection = manual.split('#### `init`')[1].split('\n#### ')[0]
    assert.match(initSection, /crea `orca\.yaml` y `\.worktreeinclude` si faltan/)
    assert.match(manual, /`scripts\.setup`/)
    assert.match(manual, /`\.worktreeinclude`.*rutas literales/)
    assert.match(manual, /`worktree\.sharedDirectories`/)
    assert.match(manual, /Command source & orca\.yaml/)
  })
})

describe('#487 init comment rule and lockfile detection', () => {
  const FULL_CITATION = /(?:\bGagaismo\/orca-stack#\d+\b|\bADR[ -]?\d{4}\b|docs\/adr\/\d{4}-)/
  const BARE_ISSUE = /(?<![\w&])#\d+\b/
  const EXCUSE = /(?<![\p{L}\p{N}_])(?:TODO|FIXME|HACK|XXX)(?![\p{L}\p{N}_])|\b(?:hack|workarounds?|for now|upgrade when)\b|\bshortcut:/iu

  const commentLinesOf = (rel, text) => {
    const ext = path.extname(rel).toLowerCase()
    if (ext === '.md' || ext === '.json') return []
    const found = []
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const number = index + 1
      if (number === 1 && raw.startsWith('#!')) continue
      const match = raw.match(/(?:^|\s)(#.*)$/)
      if (match) found.push({ line: match[1].trim(), number })
    }
    return found
  }

  const assertDecisionRecordComments = (rel, text) => {
    for (const { line, number } of commentLinesOf(rel, text)) {
      assert.match(line, FULL_CITATION, `${rel}:${number} lacks a full Gagaismo/orca-stack#<n> or ADR citation: ${line}`)
      const withoutFull = line.replace(/\bGagaismo\/orca-stack#\d+\b/g, '')
      assert.doesNotMatch(withoutFull, BARE_ISSUE, `${rel}:${number} has a bare #<n> reference: ${line}`)
      assert.doesNotMatch(line, EXCUSE, `${rel}:${number} contains an Excuse marker: ${line}`)
    }
  }

  const freshRepo = name => {
    const dir = path.join(tempDir('repo'), name)
    write(path.join(dir, 'README.md'), `# ${name}\n`)
    git(dir, 'init', '-q', '-b', 'main')
    return dir
  }

  test('R1, R5: every comment init writes in generated files is a Decision Record citing Gagaismo/orca-stack#<n> or an ADR, never a bare #<n>', () => {
    const before = snapshot(repo)
    const result = run()
    assert.equal(result.status, 0, result.out)
    const after = snapshot(repo)
    const written = Object.keys(after).filter(rel => !(rel in before) && !rel.endsWith('/')).sort()
    for (const expected of ['orca.yaml', '.worktreeinclude', '.githooks/pre-push', '.github/workflows/orca-stack-lint.yml']) {
      assert.ok(written.includes(expected), `expected init to write ${expected}, got: ${written.join(', ')}`)
    }
    for (const rel of written) assertDecisionRecordComments(rel, read(path.join(repo, rel)))
    assert.match(read(path.join(repo, '.githooks/pre-push')), /Gagaismo\/orca-stack#424/)
    assert.match(read(path.join(repo, '.github/workflows/orca-stack-lint.yml')), /Gagaismo\/orca-stack#424/)

    const npmRepo = freshRepo('npm-repo')
    try {
      write(path.join(npmRepo, 'package-lock.json'), '{}\n')
      assert.equal(cli(home, ['init'], { cwd: npmRepo }).status, 0)
      assertDecisionRecordComments('orca.yaml', read(path.join(npmRepo, 'orca.yaml')))
    } finally {
      cleanup(path.dirname(npmRepo))
    }
  })

  test('R2, R5: init writes no descriptive tautology comments in generated files such as the old .worktreeinclude and orca.yaml headers', () => {
    const result = run()
    assert.equal(result.status, 0, result.out)
    const worktreeInclude = read(path.join(repo, '.worktreeinclude'))
    assert.ok(!worktreeInclude.includes('# Gitignored local files Orca copies into each new worktree.'))
    const yaml = read(path.join(repo, 'orca.yaml'))
    assert.ok(!yaml.includes('# Orca runs scripts.setup in each new worktree right after creating it.'))
    for (const [rel, text] of [['.worktreeinclude', worktreeInclude], ['orca.yaml', yaml]]) {
      assertDecisionRecordComments(rel, text)
    }
  })

  test('R3, R5: orca.yaml detects package-lock.json, pnpm-lock.yaml and yarn.lock in priority order, and names all three lockfiles when none exists', () => {
    const cases = [
      { name: 'npm', lockfiles: ['package-lock.json'], expected: 'npm install' },
      { name: 'pnpm', lockfiles: ['pnpm-lock.yaml'], expected: 'pnpm install --frozen-lockfile' },
      { name: 'yarn', lockfiles: ['yarn.lock'], expected: 'yarn install --frozen-lockfile' },
      { name: 'npm-over-pnpm-yarn', lockfiles: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'], expected: 'npm install' },
      { name: 'pnpm-over-yarn', lockfiles: ['pnpm-lock.yaml', 'yarn.lock'], expected: 'pnpm install --frozen-lockfile' },
    ]
    for (const { name, lockfiles, expected } of cases) {
      const dir = freshRepo(name)
      try {
        for (const lock of lockfiles) write(path.join(dir, lock), '{}\n')
        const res = cli(home, ['init'], { cwd: dir })
        assert.equal(res.status, 0, res.out)
        assert.deepEqual(entries(read(path.join(dir, 'orca.yaml'))), ['scripts:', 'setup: |', expected], name)
      } finally {
        cleanup(path.dirname(dir))
      }
    }

    const none = run()
    assert.equal(none.status, 0, none.out)
    const bare = read(path.join(repo, 'orca.yaml'))
    assert.deepEqual(entries(bare), [])
    assert.doesNotMatch(bare, /\(no package-lock\.json\)/)
    for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
      assert.ok(bare.includes(lock), `missing ${lock} in:\n${bare}`)
    }
  })

  test('R4: init never rewrites an existing orca.yaml, .worktreeinclude, pre-push or lint workflow even when their comments are old or a pnpm lockfile is present', () => {
    const existing = {
      'orca.yaml': '# Orca runs scripts.setup in each new worktree right after creating it.\n# orca-stack init found no install step (no package-lock.json): add one.\n',
      '.worktreeinclude': '# Gitignored local files Orca copies into each new worktree.\n.orca-stack.local.json\n',
      '.githooks/pre-push': '#!/bin/sh\n# Early warning only (#424)\nexec orca-stack lint\n',
      '.github/workflows/orca-stack-lint.yml': '# Written by orca-stack init (#424)\nname: orca-stack lint\n',
    }
    write(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    for (const [rel, content] of Object.entries(existing)) write(path.join(repo, rel), content)

    const result = run()
    assert.equal(result.status, 0, result.out)
    for (const [rel, content] of Object.entries(existing)) {
      assert.equal(read(path.join(repo, rel)), content, rel)
      assert.ok(result.out.split(/\r?\n/).includes(`${rel}: ya existe, no se toca`), `missing skip line for ${rel}`)
    }
    assert.deepEqual(backups(home), [])
  })

  test('PRESERVE: exported orcaYaml and WORKTREE_INCLUDE match what init writes, and init preserves existing files and idempotency', () => {
    write(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    assert.equal(run().status, 0)
    assert.equal(read(path.join(repo, 'orca.yaml')), orcaYaml(repo))
    assert.equal(read(path.join(repo, '.worktreeinclude')), WORKTREE_INCLUDE)
    assert.deepEqual(entries(WORKTREE_INCLUDE), ['.orca-stack.local.json'])

    const before = snapshot(repo)
    const second = run()
    assert.equal(second.status, 0, second.out)
    assert.deepEqual(snapshot(repo), before)
    assert.deepEqual(backups(home), [])
  })
})

