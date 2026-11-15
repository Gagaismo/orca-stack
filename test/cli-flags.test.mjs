import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { parseArgs } from '../src/cli.mjs'
import { ROOT, cleanup, cli, tempDir } from './helpers.mjs'

describe('orca-stack CLI flags of main-autonomo (S1, S5, S12, S13)', () => {
  test('--json, --terminal <handle> and --rutas <a,b> are parsed, in both spellings', () => {
    assert.equal(parseArgs(['estado', '70', '--json']).flags.json, true)
    assert.deepEqual(parseArgs(['estado', '70', '--json']).rest, ['estado', '70'])
    assert.equal(parseArgs(['reanudar', '53', 'https://x', '--terminal', 'term_abc']).flags.terminal, 'term_abc')
    assert.equal(parseArgs(['reanudar', '53', 'https://x', '--terminal=term_abc']).flags.terminal, 'term_abc')
    assert.deepEqual(parseArgs(['reanudar', '53', 'https://x', '--terminal', 'term_abc']).rest, ['reanudar', '53', 'https://x'])
    assert.equal(parseArgs(['revisar', '70', 'pi', '--rutas', 'src/a.mjs,src/b.mjs']).flags.rutas, 'src/a.mjs,src/b.mjs')
    assert.equal(parseArgs(['revisar', '70', 'pi', '--rutas=src/a.mjs']).flags.rutas, 'src/a.mjs')
  })

  test('--terminal and --rutas without a value are refused with exit 2', () => {
    assert.throws(() => parseArgs(['reanudar', '53', 'https://x', '--terminal']), /--terminal necesita el handle de una terminal de Orca/)
    assert.throws(() => parseArgs(['reanudar', '53', 'https://x', '--terminal', '--dry-run']), /--terminal necesita el handle de una terminal de Orca/)
    assert.throws(() => parseArgs(['revisar', '70', 'pi', '--rutas', '']), /--rutas necesita una o más rutas separadas por coma/)
    const home = tempDir('cli-flags')
    try {
      const result = cli(home, ['revisar', '70', 'pi', '--rutas'], { cwd: ROOT })
      assert.equal(result.status, 2)
      assert.match(result.out, /--rutas necesita una o más rutas separadas por coma/)
    } finally {
      cleanup(home)
    }
  })

  test('PRESERVE: options that existed before keep parsing the same', () => {
    const { flags, rest } = parseArgs(['rebote', '70', '--rdd', 'risk', '--nota', 'x', '--dry-run'])
    assert.equal(flags.rdd, 'risk')
    assert.equal(flags.nota, 'x')
    assert.equal(flags.dryRun, true)
    assert.equal(flags.json, undefined)
    assert.equal(flags.terminal, undefined)
    assert.equal(flags.rutas, undefined)
    assert.deepEqual(rest, ['rebote', '70'])
    assert.throws(() => parseArgs(['vigilar', '7', '--jsn']), /Opción desconocida: --jsn/)
  })

  test('PRESERVE: the new options stay unknown to the commands that do not take them', () => {
    assert.throws(() => parseArgs(['vigilar', '7', '--json']), /^Error: Opción desconocida: --json$/)
    assert.throws(() => parseArgs(['consultas', '7', '--json']), /^Error: Opción desconocida: --json$/)
    assert.throws(() => parseArgs(['despachar', '5', 'codex', '--terminal', 't1']), /^Error: Opción desconocida: --terminal$/)
    assert.throws(() => parseArgs(['rebote', '70', '--rutas', 'a,b']), /^Error: Opción desconocida: --rutas$/)
  })

  test('help lists estado and limpiar, and names --json, --terminal and --rutas on their commands', () => {
    const home = tempDir('cli-help')
    try {
      const usage = cli(home, ['--help'])
      assert.equal(usage.status, 0)
      assert.match(usage.stdout, /^ {2}estado {4}/m)
      assert.match(usage.stdout, /^ {2}limpiar {3}/m)
      assert.match(usage.stdout, /--json +\(estado\)/)
      assert.match(usage.stdout, /--terminal <handle> +\(reanudar\)/)
      assert.match(usage.stdout, /--rutas <a,b> +\(revisar\)/)
      assert.match(usage.stdout, /--dry-run +\([^)]*limpiar/)

      const estado = cli(home, ['estado', '--help'])
      assert.match(estado.stdout, /^orca-stack estado \[<pr>\.\.\.\] \[--json\]/)
      assert.match(estado.stdout, /\{"pr":<n>,"head":"<sha de 40>","ok":<bool>,"falta":\[…\],"merge":<texto o null>\}/)
      const limpiar = cli(home, ['limpiar', '--help'])
      assert.match(limpiar.stdout, /^orca-stack limpiar \[--dry-run\]/)
      assert.match(limpiar.stdout, /nunca borra ramas remotas/)
      assert.match(cli(home, ['reanudar', '--help']).stdout, /--terminal <handle>/)
      assert.match(cli(home, ['revisar', '--help']).stdout, /--rutas <a,b>/)
    } finally {
      cleanup(home)
    }
  })
})
