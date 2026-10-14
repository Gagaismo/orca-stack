import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { parseArgs } from '../src/cli.mjs'
import { FAMILIES, blockOf, familyOf } from '../src/despacho.mjs'
import { MARKER_BEGIN, MARKER_END } from '../src/constants.mjs'
import { buildBlock, removeBlock, upsertBlock } from '../src/marker.mjs'
import { mergePluginDirs, removePluginDirs } from '../src/settings.mjs'
import { cmdWrapper, render, shWrapper } from '../src/templates.mjs'
import { ROOT } from './helpers.mjs'

describe('marker blocks', () => {
  test('appends to a file that has none, replaces in place when present', () => {
    const first = upsertBlock('hola\n', 'uno')
    assert.equal(first, `hola\n\n${buildBlock('uno')}\n`)
    const second = upsertBlock(first + 'cola\n', 'dos')
    assert.equal(second, `hola\n\n${buildBlock('dos')}\ncola\n`)
  })

  test('removes the block and the blank line that separated it', () => {
    const text = `hola\n\n${buildBlock('uno')}\ncola\n`
    assert.deepEqual(removeBlock(text), { text: 'hola\n\ncola\n', found: true })
    assert.deepEqual(removeBlock(upsertBlock('', 'solo')), { text: '', found: true })
    assert.deepEqual(removeBlock('sin bloque\n'), { text: 'sin bloque\n', found: false })
  })

  test('keeps CRLF files CRLF', () => {
    const out = upsertBlock('a\r\nb\r\n', 'x')
    assert.ok(!/[^\r]\n/.test(out), 'no bare LF')
  })

  test('refuses duplicated markers', () => {
    const twice = `${buildBlock('a')}
${buildBlock('b')}
`
    assert.throws(() => upsertBlock(twice, 'x'), /duplicados/)
    assert.throws(() => removeBlock(twice), /duplicados/)
  })

  test('migrates a legacy orca-stack:auto block in place', () => {
    const legacy = 'antes\n\n<!-- orca-stack:auto -->\n## Viejo\nC:\\Users\\x\\ORCA-STACK.md\n<!-- /orca-stack:auto -->\n\ndespués\n'
    assert.equal(upsertBlock(legacy, 'nuevo'), `antes\n\n${buildBlock('nuevo')}\n\ndespués\n`)
  })

  test('drops a legacy block when the current block already exists', () => {
    const both = `${buildBlock('actual')}\n\n<!-- orca-stack:auto -->\nviejo\n<!-- /orca-stack:auto -->\n`
    assert.equal(upsertBlock(both, 'nuevo'), `${buildBlock('nuevo')}\n`)
  })

  test('refuses an unbalanced legacy block', () => {
    assert.throws(() => upsertBlock('<!-- orca-stack:auto -->\nsin fin\n', 'x'), /incompletos/)
  })

  test('refuses unbalanced markers instead of guessing', () => {
    assert.throws(() => upsertBlock(`${MARKER_BEGIN}\nsin fin`, 'x'), /incompletos/)
    assert.throws(() => removeBlock(`${MARKER_END}\n${MARKER_BEGIN}`), /incompletos/)
  })
})

describe('CLAUDE_CODE_PLUGIN_DIRS merge', () => {
  const sep = path.delimiter
  const a = path.resolve('/x/a')
  const b = path.resolve('/x/b')
  const c = path.resolve('/x/c')

  test('keeps existing entries and order, adds only the missing ones', () => {
    const { value, added } = mergePluginDirs([a, b].join(sep), [b, c])
    assert.equal(value, [a, b, c].join(sep))
    assert.deepEqual(added, [c])
  })

  test('starts from nothing and ignores blanks', () => {
    assert.equal(mergePluginDirs(undefined, [a]).value, a)
    assert.equal(mergePluginDirs(`${sep}${a}${sep}`, [a]).value, a)
  })

  test('removes only what was asked', () => {
    assert.deepEqual(removePluginDirs([a, b, c].join(sep), [b]), { value: [a, c].join(sep), removed: 1 })
  })
})

describe('templates and args', () => {
  test('render only replaces known tokens', () => {
    assert.equal(render('{{A}} {{B}}', { A: '1' }), '1 {{B}}')
  })

  test('wrappers answer --orca-stack-self-test and never run the real binary then', () => {
    assert.match(cmdWrapper('claude'), /--orca-stack-self-test/)
    assert.match(cmdWrapper('codex'), /where codex\.cmd/)
    assert.match(shWrapper('agy'), /exec "\$ORCA_STACK_AGENT"/)
    assert.ok(cmdWrapper('claude').includes('\r\n'))
  })

  test('parseArgs', () => {
    assert.deepEqual(parseArgs(['global', '--dry-run', '--humano=Ana']).flags.humano, 'Ana')
    assert.equal(parseArgs(['doctor', '--offline']).flags.offline, true)
    assert.throws(() => parseArgs(['global', '--nope']), /desconocida/)
    assert.throws(() => parseArgs(['global', '--humano']), /nombre/)
  })
})

// Built from pieces so this file does not contain the strings it forbids.
const author = ['laut', 'aro'].join('')
const personal = new RegExp('(c:/+users|/home)/+' + author, 'i') // tested on text with backslashes turned into slashes
const projectNames = new RegExp(['Sam' + 'uel', 'Jo' + 'aco', 'agentes-' + 'samu', 'Gluco' + 'Meal', author].join('|'), 'i')

describe('the repository itself', () => {
  const files = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      // .atl is the local skill registry gentle-ai writes (gitignored, holds the user's paths).
      if (['.git', 'node_modules', '.atl'].includes(name)) continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(ROOT)

  test('no personal paths or hardcoded users anywhere', () => {
    const offenders = []
    for (const file of files) {
      if (file.endsWith('.png') || file.endsWith('.ico')) continue
      const text = readFileSync(file, 'utf8')
      if (personal.test(text.split(String.fromCharCode(92)).join('/'))) {
        offenders.push(path.relative(ROOT, file))
      }
    }
    assert.deepEqual(offenders, [])
  })

  test('the mods, the docs and the README carry no project-specific names', () => {
    const offenders = []
    const published = f =>
      f.includes(`${path.sep}mods${path.sep}`) || f.includes(`${path.sep}docs${path.sep}`) || f === path.join(ROOT, 'README.md')
    for (const file of files.filter(published)) {
      const text = readFileSync(file, 'utf8')
      if (projectNames.test(text)) offenders.push(path.relative(ROOT, file))
    }
    assert.deepEqual(offenders, [])
  })

  test('every copy of the shared config module matches shared/orca-config.ts', () => {
    const shared = readFileSync(path.join(ROOT, 'shared', 'orca-config.ts'), 'utf8')
    for (const mod of ['puente-gentle', 'bandeja-mensajes', 'guardia-despacho', 'tablero-despacho']) {
      const copy = readFileSync(path.join(ROOT, 'mods', mod, 'hooks', 'orca-config.ts'), 'utf8')
      assert.equal(copy, shared, `${mod} is out of sync: run npm run sync-shared`)
    }
    const cases = JSON.parse(readFileSync(path.join(ROOT, 'shared', 'familias.json'), 'utf8'))
    const module = readFileSync(path.join(ROOT, 'mods', 'puente-gentle', 'tests', 'familias.ts'), 'utf8')
    assert.deepEqual(JSON.parse(module.slice(module.indexOf('export default ') + 'export default '.length)), cases, 'puente-gentle/tests/familias.ts is out of sync: run npm run sync-shared')
  })

  test('despacho keeps the same FAMILIES literal as shared/orca-config.ts', () => {
    const shared = readFileSync(path.join(ROOT, 'shared', 'orca-config.ts'), 'utf8')
    const literal = /\/\/ BEGIN FAMILIES\s*export const FAMILIES = ([\s\S]*?)(?: as const)?\s*\/\/ END FAMILIES/.exec(shared)?.[1]
    assert.ok(literal, 'shared/orca-config.ts lost its FAMILIES markers')
    assert.deepEqual(JSON.parse(literal), FAMILIES)
  })

  // The mod runs the same cases against shared/orca-config.ts (its copy is mods/puente-gentle/tests/familias.ts).
  test('familyOf and blockOf answer shared/familias.json', () => {
    const cases = JSON.parse(readFileSync(path.join(ROOT, 'shared', 'familias.json'), 'utf8'))
    for (const c of cases.familyOf) assert.equal(familyOf(c.config, c.agent, c.mode).family ?? null, c.family, JSON.stringify(c))
    for (const c of cases.blockOf) {
      assert.equal(blockOf({ guardia: { bloquear: c.rules } }, c.agent, new Date(c.now).getTime()) ?? null, c.result, JSON.stringify(c))
    }
  })

  test('every mod has a manifest, a hooks entry that exists, and a test', () => {
    for (const mod of readdirSync(path.join(ROOT, 'mods'))) {
      const dir = path.join(ROOT, 'mods', mod)
      const manifest = JSON.parse(readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))
      assert.equal(manifest.name, mod)
      const hooks = JSON.parse(readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8'))
      assert.equal(hooks.modules.length, 1)
      assert.ok(statSync(path.join(dir, 'hooks', hooks.modules[0])).isFile())
      assert.ok(readdirSync(path.join(dir, 'tests')).some(name => name.endsWith('.test.ts')), `${mod} has no test`)
    }
  })

  test('vendored ponytail skills keep the upstream license notice', () => {
    for (const name of ['ponytail', 'ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-help']) {
      const license = readFileSync(path.join(ROOT, 'assets', 'skills', name, 'LICENSE'), 'utf8')
      assert.match(license, /Copyright \(c\) 2026 DietrichGebert/)
    }
  })

  test('vendored pstack skills keep the upstream license notice', () => {
    for (const name of ['principle-make-operations-idempotent', 'principle-attack-the-premise', 'principle-explain-the-number']) {
      const license = readFileSync(path.join(ROOT, 'assets', 'skills', name, 'LICENSE'), 'utf8')
      assert.match(license, /Copyright \(c\) 2026 Lauren Tan/)
    }
  })
})
