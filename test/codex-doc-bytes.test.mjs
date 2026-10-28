import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { codexDocBytesFor } from '../src/codex-doc-bytes.mjs'
import { MARKER_BEGIN, MARKER_END } from '../src/constants.mjs'
import { ROOT, backups, cleanup, cli, git, read, snapshot, tempDir, write } from './helpers.mjs'

const dirs = []
const temp = prefix => {
  const dir = tempDir(prefix)
  dirs.push(dir)

  return dir
}

afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop())
})

// Only node on PATH: no real codex binary runs (its codemode step would rewrite config.toml under the test).
// A throwaway directory goes first so global installs its command there, never into node's own (writable on CI) bin.
const runGlobal = (home, codexDir, args = []) => {
  const commandDir = path.join(home, 'path-bin')
  mkdirSync(commandDir, { recursive: true })
  const env = { PATH: [commandDir, path.dirname(process.execPath)].join(path.delimiter), CODEX_HOME: codexDir }

  return cli(home, ['global', '--skip-pi', ...args], { env })
}

// The orca-stack block exactly as `init` writes it into a project's AGENTS.md, markers excluded.
const initBlockBytes = () => {
  const home = temp('doc-bytes-init-home')
  const repo = temp('doc-bytes-init-repo')
  git(repo, 'init', '-q', '-b', 'main')
  const result = cli(home, ['init'], { cwd: repo })
  assert.equal(result.status, 0, result.out)
  const text = read(path.join(repo, 'AGENTS.md'))
  const start = text.indexOf(MARKER_BEGIN) + MARKER_BEGIN.length
  const inner = text.slice(start, text.indexOf(MARKER_END)).replace(/^\r?\n/, '').replace(/\r?\n$/, '')

  return Buffer.byteLength(inner)
}

const docBytesLine = text => /^project_doc_max_bytes = (\d+)\r?$/m.exec(text)?.[1]

describe('#269: global raises codex project_doc_max_bytes', () => {
  test('rule 1: the smallest power of two that is at least 65536 and at least twice the size measured', () => {
    assert.equal(codexDocBytesFor(98_049 + 38_693), 524288)
    assert.equal(codexDocBytesFor(38_693), 131072)
    assert.equal(codexDocBytesFor(10_000), 65536)
    assert.equal(codexDocBytesFor(32_768), 65536)
    assert.equal(codexDocBytesFor(32_769), 131072)
  })

  test('rule 1: global writes the value for the block init writes into $CODEX_HOME/config.toml, and the global AGENTS.md does not change it', () => {
    const home = temp('doc-bytes-home')
    const codexDir = temp('doc-bytes-codex')
    write(path.join(codexDir, 'config.toml'), 'model = "gpt-5"\n')
    write(path.join(codexDir, 'AGENTS.md'), 'x'.repeat(98_049))

    const result = runGlobal(home, codexDir)
    assert.equal(result.status, 0, result.out)
    const expected = codexDocBytesFor(initBlockBytes())
    assert.equal(expected, 131072)
    assert.equal(read(path.join(codexDir, 'config.toml')), `project_doc_max_bytes = ${expected}\nmodel = "gpt-5"\n`)
    assert.match(result.out, /project_doc_max_bytes = 131072; sin valor, codex usaba 32768/)
    assert.equal(existsSync(path.join(home, '.codex')), false)
  })

  test('rule 2: a value equal to or above the target is left untouched and global says so; it never lowers it', () => {
    for (const value of [131072, 1048576]) {
      const home = temp('doc-bytes-high-home')
      const codexDir = temp('doc-bytes-high-codex')
      const config = path.join(codexDir, 'config.toml')
      const text = `project_doc_max_bytes = ${value}\n[projects.'c:\\repo']\ntrust_level = "trusted"\n`
      write(config, text)

      const result = runGlobal(home, codexDir)
      assert.equal(result.status, 0, result.out)
      assert.equal(read(config), text)
      assert.ok(result.out.includes(`project_doc_max_bytes ya es ${value} (alcanza con 131072): no lo toco`), result.out)
      assert.deepEqual(backups(home).filter(name => name.endsWith('config.toml')), [])
    }
  })

  test('rule 2: a lower value is raised, and running global twice changes nothing the second time', () => {
    const home = temp('doc-bytes-twice-home')
    const codexDir = temp('doc-bytes-twice-codex')
    const config = path.join(codexDir, 'config.toml')
    write(config, 'project_doc_max_bytes = 32768\n')

    const first = runGlobal(home, codexDir)
    assert.equal(first.status, 0, first.out)
    assert.equal(read(config), 'project_doc_max_bytes = 131072\n')
    assert.match(first.out, /project_doc_max_bytes = 131072; antes 32768/)
    const after = snapshot(codexDir)

    const second = runGlobal(home, codexDir)
    assert.equal(second.status, 0, second.out)
    assert.deepEqual(snapshot(codexDir), after)
    assert.match(second.out, /project_doc_max_bytes ya es 131072/)
  })

  test('rule 3: config.toml is backed up first, the rest of the file stays byte for byte, and --dry-run writes nothing', () => {
    const home = temp('doc-bytes-bytes-home')
    const codexDir = temp('doc-bytes-bytes-codex')
    const config = path.join(codexDir, 'config.toml')
    const original = [
      '# my codex config',
      'model = "gpt-5"   # pinned',
      'project_doc_max_bytes = 40_000  # raised by hand',
      '',
      '[profiles.big]',
      'project_doc_max_bytes = 1',
      '',
    ].join('\r\n')
    write(config, original)

    const dry = runGlobal(home, codexDir, ['--dry-run'])
    assert.equal(dry.status, 0, dry.out)
    assert.equal(read(config), original)
    assert.equal(existsSync(path.join(home, '.orca-stack')), false)

    const result = runGlobal(home, codexDir)
    assert.equal(result.status, 0, result.out)
    assert.equal(read(config), original.replace('project_doc_max_bytes = 40_000  #', 'project_doc_max_bytes = 131072  #'))
    const saved = backups(home).filter(name => name.endsWith('config.toml'))
    assert.equal(saved.length, 1, result.out)
    assert.equal(readFileSync(path.join(home, ...saved[0].split('/')), 'utf8'), original)
  })

  test('rules 2 and 3: a line starting with a bracket inside a multiline array or string is not a table header', () => {
    const home = temp('doc-bytes-array-home')
    const codexDir = temp('doc-bytes-array-codex')
    const config = path.join(codexDir, 'config.toml')
    const original = [
      'model = "gpt"',
      'notify = [',
      '  ["say", "done"],',
      ']',
      'instructions = """',
      '[not.a.table]',
      'project_doc_max_bytes = 1',
      '"""',
      'project_doc_max_bytes = 65536',
      '',
      '[profiles.x]',
      'a = 1',
      '',
    ].join('\n')
    write(config, original)

    const first = runGlobal(home, codexDir)
    assert.equal(first.status, 0, first.out)
    const raised = original.replace('project_doc_max_bytes = 65536', 'project_doc_max_bytes = 131072')
    assert.equal(read(config), raised)
    assert.match(first.out, /project_doc_max_bytes = 131072; antes 65536/)

    const second = runGlobal(home, codexDir)
    assert.equal(second.status, 0, second.out)
    assert.equal(read(config), raised)
    assert.match(second.out, /project_doc_max_bytes ya es 131072/)
  })

  test('preserve: without codex\'s home global skips the step and creates nothing there', () => {
    const home = temp('doc-bytes-nocodex-home')
    const codexDir = path.join(temp('doc-bytes-nocodex'), 'missing')

    const result = runGlobal(home, codexDir)
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /\(project_doc_max_bytes\)\r?\n {2}se omite: no hay .*missing \(CODEX_HOME apunta a una carpeta que no existe\)/)
    assert.equal(existsSync(codexDir), false)
  })
})

test('#269 rule 6: the README table of what global installs names project_doc_max_bytes in codex\'s config.toml', () => {
  const readme = read(path.join(ROOT, 'README.md'))
  const table = readme.slice(readme.indexOf('## Qué instala'), readme.indexOf('### `doctor`'))
  const row = table.split('\n').find(line => line.startsWith('| Codex: `project_doc_max_bytes`'))
  assert.ok(row, 'missing the codex row')
  assert.ok(row.endsWith('| `$CODEX_HOME/config.toml` (o `~/.codex/config.toml`) |'), row)
  assert.ok(row.includes(`hoy ${codexDocBytesFor(initBlockBytes())}`), row)
})

describe('#269: doctor checks codex project_doc_max_bytes', () => {
  const setup = configText => {
    const home = temp('doc-bytes-doctor-home')
    const repo = temp('doc-bytes-doctor-repo')
    const codexDir = temp('doc-bytes-doctor-codex')
    write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify({ agentes: { usa: ['codex'] } }))
    assert.equal(git(repo, 'init').status, 0)
    write(path.join(repo, 'AGENTS.md'), 'y'.repeat(42_369))
    if (configText !== null) write(path.join(codexDir, 'config.toml'), configText)
    write(path.join(codexDir, 'AGENTS.md'), 'x'.repeat(98_049))

    return cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo, env: { CODEX_HOME: codexDir } })
  }

  test('rule 4: warns naming both numbers when the value, or the 32 KiB default when unset, is below the repo AGENTS.md', () => {
    const unset = setup(null)
    assert.ok(unset.out.includes('⚠ codex project_doc_max_bytes - 32768 (el default de codex, sin valor en config.toml) es menos que los 42369 bytes de AGENTS.md'), unset.out)

    const low = setup('project_doc_max_bytes = 40000\n')
    assert.ok(low.out.includes('⚠ codex project_doc_max_bytes - 40000 (config.toml) es menos que los 42369 bytes de AGENTS.md'), low.out)

    const afterArray = setup('notify = [\n  ["say", "done"],\n]\nproject_doc_max_bytes = 40000\n')
    assert.ok(afterArray.out.includes('⚠ codex project_doc_max_bytes - 40000 (config.toml) es menos que los 42369 bytes de AGENTS.md'), afterArray.out)
  })

  test('rule 4 negative: no warning when the value covers the repo AGENTS.md', () => {
    const covered = setup('project_doc_max_bytes = 131072\n')
    assert.ok(covered.out.includes('✔ codex project_doc_max_bytes - 131072 cubre los 42369 bytes de AGENTS.md'), covered.out)
    assert.doesNotMatch(covered.out, /⚠ codex project_doc_max_bytes/)
  })

  test('preserve: doctor prints no project_doc_max_bytes line in a repo that does not use codex', () => {
    const home = temp('doc-bytes-doctor-nocodex')
    const repo = temp('doc-bytes-doctor-nocodex-repo')
    write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify({ agentes: { usa: ['claude'] } }))
    assert.equal(git(repo, 'init').status, 0)
    write(path.join(repo, 'AGENTS.md'), 'y'.repeat(42_369))

    const result = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo })
    assert.doesNotMatch(result.out, /project_doc_max_bytes/)
  })
})
