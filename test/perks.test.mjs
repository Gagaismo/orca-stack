import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { perksOf } from '../src/perks.mjs'
import { cleanup, cli, git, read, ROOT, tempDir, write } from './helpers.mjs'

const asset = name => read(path.join(ROOT, 'assets', 'stack', name))
const GEAR_TEXT = /\bmarchas?\b|\bLazy\b|\bMedium\b|\bProactive\b|\bgears?\b|Gear knobs|\bK(?:[1-9]|1[01])\b/

// A repo with the given project config, `init` run against a home with the given personal config.
const initRepo = (home, { personal, project } = {}) => {
  const repo = path.join(tempDir('perks-repo'), 'project')
  write(path.join(repo, 'README.md'), '# project\n')
  if (project !== undefined) write(path.join(repo, '.orca-stack.json'), JSON.stringify(project))
  if (personal !== undefined) write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify(personal))
  git(repo, 'init', '-q', '-b', 'main')
  const result = cli(home, ['init'], { cwd: repo })
  assert.equal(result.status, 0, result.out)
  const block = read(path.join(repo, 'AGENTS.md'))

  return { repo, block }
}
const hasGears = block => /^### Marchas$/m.test(block) && block.includes('`Marcha: <lazy|medium|proactive>`') && block.includes('`Esperando marcha: <items>`')

describe('#393 perk switch, gears first', () => {
  test('R1: perks merge across layers, default off, and doctor reports a non-boolean value', () => {
    assert.deepEqual(perksOf({}), { marchas: false, ponytail: false, caveman: false })
    assert.deepEqual(perksOf({ perks: { marchas: 'yes', ponytail: true } }), { marchas: false, ponytail: true, caveman: false })
    const home = tempDir('perks-home')
    const repos = []
    try {
      const on = initRepo(home, { personal: { perks: { marchas: true } } })
      repos.push(on.repo)
      assert.ok(hasGears(on.block), 'personal on and no project perks: gears on')
      const off = initRepo(home, { personal: { perks: { marchas: true } }, project: { perks: { marchas: false } } })
      repos.push(off.repo)
      assert.ok(!hasGears(off.block), 'project false wins over personal true')

      write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify({ perks: { marchas: 'yes' } }))
      const doctor = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: home })
      assert.match(doctor.out, /perks\.marchas - no es booleano \("yes"\): el perk cuenta como apagado/)
      const yes = initRepo(home)
      repos.push(yes.repo)
      assert.ok(!hasGears(yes.block), 'a non-boolean perk counts as off')
    } finally {
      cleanup(home)
      for (const repo of repos) cleanup(path.dirname(repo))
    }
  })

  test('R2: global installs MAIN.md, ORCA-STACK.md and ROLE-BRIEFS.md without gear rules, and MARCHAS.md beside them', () => {
    const home = tempDir('perks-global')
    try {
      const result = cli(home, ['global', '--skip-pi'])
      assert.equal(result.status, 0, result.out)
      const stack = path.join(home, 'orca', 'stack')
      for (const name of ['MAIN.md', 'ORCA-STACK.md', 'ROLE-BRIEFS.md']) {
        const text = read(path.join(stack, name))
        assert.doesNotMatch(text, GEAR_TEXT, name)
      }
      const fragment = read(path.join(stack, 'MARCHAS.md'))
      assert.match(fragment, /^### Marchas$/m)
      assert.match(fragment, /^## Gear knobs$/m)
      assert.match(fragment, /Solo en marcha Proactive se arma `vigilar` con `--consultas`/)
      assert.match(fragment, /El swarm de solo lectura que no requiere OK nunca se hace en Lazy/)
      assert.match(fragment, /Proactive agrega la señal «no saber qué enfoque conviene»/)
      assert.match(fragment, /Solo elegir la marcha Proactive cuenta como pedir que `main` supervise y colabore/)
    } finally {
      cleanup(home)
    }
  })

  test('R3: the contract has the gears heading, markers and pointer only when the perk is on, per repo', () => {
    const home = tempDir('perks-contract')
    const repos = []
    try {
      const without = initRepo(home)
      repos.push(without.repo)
      assert.doesNotMatch(without.block, /Marchas|Marcha:|Esperando marcha:|MARCHAS\.md|perk:/)
      assert.match(without.block, /`Rebote conflicto: <sha>`, `Consulta: <agente>`/)

      const withGears = initRepo(home, { project: { perks: { marchas: true } } })
      repos.push(withGears.repo)
      assert.ok(hasGears(withGears.block))
      assert.match(withGears.block, /`Rebote conflicto: <sha>`, `Marcha: <lazy\|medium\|proactive>`, `Esperando marcha: <items>`, `Consulta: <agente>`/)
      assert.match(withGears.block, /### Marchas\n\nEsta sección es solo de `main` y está en `~\/orca\/stack\/MARCHAS\.md`/)
      assert.doesNotMatch(withGears.block, /perk:/)

      // Gears on in the personal layer of this machine only: the next repo shows them, a repo whose own layer turns
      // them off stays without them.
      write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify({ perks: { marchas: true } }))
      const personal = initRepo(home)
      repos.push(personal.repo)
      assert.ok(hasGears(personal.block))
      const other = initRepo(home, { project: { perks: { marchas: false } } })
      repos.push(other.repo)
      assert.ok(!hasGears(other.block))
    } finally {
      cleanup(home)
      for (const repo of repos) cleanup(path.dirname(repo))
    }
  })

  test('R4: with gears on, the fragment carries today’s gear rules and the restrictions MAIN.md no longer has', () => {
    const fragment = asset('MARCHAS.md')
    assert.match(fragment, /Sin mensaje `Marcha:`, la marcha es Medium/)
    assert.match(fragment, /`Sugiero subir a Proactive para #42 \(toca riesgo\): \/marcha proactive`/)
    assert.match(fragment, /`Esperando marcha: #41, #43`/)
    assert.match(fragment, /registrá en la nota de handoff la marcha que deja y proponele al humano volver a Medium si la sesión estaba en Lazy o Proactive/)
    assert.match(fragment, /Al bajar de marcha desde Proactive, `main` responde las preguntas que ya tenga y deja de vigilar; al subir a Proactive, empieza a vigilar los items en curso y no relanza nada/)
    assert.match(fragment, /La marcha actual de main va entre las instrucciones del proyecto/)
    assert.deepEqual([...fragment.matchAll(/^- \*\*(K\d+) /gm)].map(([, knob]) => knob), ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9', 'K10', 'K11'])
  })

  test('R7: swarm and arena keep every OK rule and lose only the gear conditions', () => {
    const main = asset('MAIN.md')
    const arena = main.split('### Arena y swarm')[1].split('\n### ')[0]
    assert.match(arena, /Un swarm de solo lectura sobre código, issues y PRs, con pocos subagentes y sin correr una suite, hacer llamadas remotas ni crear worktrees, no requiere OK\./)
    assert.match(arena, /Cualquier otro swarm requiere OK como una arena/)
    assert.match(arena, /Toda fan-out que pase por Workflow requiere el OK del humano/)
    assert.match(arena, /Escribe esa nota solo con el OK explícito del humano/)
    assert.match(arena, /Los swarms de solo lectura no agregan otro límite/)
    assert.doesNotMatch(arena, /Lazy|Proactive/)
  })

  test('R8: without gears main always arms vigilar with --consultas and collaborates, and the CLI help agrees', () => {
    const main = asset('MAIN.md')
    const step5 = main.split('\n').find(line => line.startsWith('5. '))
    assert.match(step5, /Armalo siempre con `--consultas`/)
    const despacho = main.split('### Despacho')[1]
    assert.match(despacho, /Sin pedirlo, `main` igual colabora con los workers sin un Run de Orca/)
    assert.match(despacho, /le toca el timbre con `orca-stack avisar <issue\|pr> <url-del-comentario>`/)
    const home = tempDir('perks-help')
    try {
      const help = cli(home, ['vigilar', '--help'])
      assert.match(help.out, /--consultas corre en cada vuelta/)
      assert.doesNotMatch(help.out, /Proactive/)
      assert.doesNotMatch(cli(home, ['avisar', '--help']).out, /Proactive/)
    } finally {
      cleanup(home)
    }
  })

  test('R9: README and the manual explain perks, the default and how to switch one on', () => {
    for (const file of ['README.md', path.join('docs', 'manual.md')]) {
      const text = read(path.join(ROOT, file))
      assert.match(text, /"perks": \{ "marchas": true \}/, file)
      assert.match(text, /apagad[oa]s? por defecto/i, file)
      assert.match(text, /MARCHAS\.md/, file)
    }
  })
})
