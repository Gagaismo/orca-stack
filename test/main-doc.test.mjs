import assert from 'node:assert/strict'
import { existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { renderBrief } from '../src/despacho.mjs'
import { POLICY } from '../src/init.mjs'
import { policyBlock } from '../src/templates.mjs'
import { cleanup, cli, read, tempDir } from './helpers.mjs'

// Issue 325: main-only rules live in assets/stack/MAIN.md; the contract keeps a pointer and stubs.
const ROOT = process.cwd()
const asset = name => read(path.join(ROOT, 'assets', 'stack', name))
const contract = asset('CONTRATO.md')
const main = asset('MAIN.md')
const section = (text, heading) => (text.split(`\n${heading}\n`)[1]?.split('\n### ')[0] ?? '').trim()
const paragraphs = text => text.split(/\r?\n\s*\r?\n/).map(unit => unit.trim()).filter(Boolean)

const CONTRACT_LIMIT = 24576
const contractFits = text => Buffer.byteLength(text, 'utf8') <= CONTRACT_LIMIT
const MAIN_PATH = `${path.posix.dirname(POLICY)}/MAIN.md`
const POINTER = `Si sos \`main\` (o la sesión única en modo \`un-agente\`), leé \`${MAIN_PATH}\` entero antes de actuar: ahí están el Ciclo de \`main\`, las Marchas, el Despacho, los Permisos de \`main\` y Arena y swarm.`

describe('issue 325: main-only rules move to MAIN.md', () => {
  test('R1: MAIN.md keeps the moved headings in contract order and steps 1 through 10 of Ciclo de main', () => {
    const headings = main.split(/\r?\n/).filter(line => line.startsWith('### '))
    assert.deepEqual(headings, ['### Marchas', '### Modo `un-agente`', '### Permisos', '### Ciclo de `main`', '### Arena y swarm', '### Despacho'])
    const cycle = section(main, '### Ciclo de `main`')
    assert.deepEqual([...cycle.matchAll(/^(\d+)\. /gm)].map(([, n]) => Number(n)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.ok(cycle.startsWith('Antes de actuar sobre un número medido'))
  })

  test('R1 negative: no moved paragraph is left behind in the contract', () => {
    const kept = new Set(paragraphs(contract))
    const header = paragraphs(main).slice(0, 2)
    const both = paragraphs(main).filter(unit => !header.includes(unit) && !unit.startsWith('### ') && kept.has(unit))
    assert.deepEqual(both, [])
  })

  test('R2: what workers and reviewers act on stays in the contract', () => {
    const permisos = section(contract, '### Permisos')
    assert.ok(permisos.startsWith('Sin preguntar: crear ramas, commitear, pushear, abrir PRs, comentar y etiquetar issues, despachar, elegir revisor'))
    assert.ok(permisos.includes('Se pregunta: lo irreversible (reescribir historia, force push, borrar ramas o issues, tocar algo ya publicado)'))
    assert.ok(permisos.includes('Excepción de `Arena y swarm`: el owner puede borrar, sin preguntar, las ramas y los worktrees candidatos'))
    assert.ok(permisos.includes('Después de una llamada rechazada o interrumpida, revisá sus efectos'))
    assert.ok(contract.includes('`Consulta: <agente>`'))
    const arena = section(contract, '### Arena y swarm')
    for (const lead of ['**Ruta y ownership.**', '**Arena.**', '**Swarm.**', '**Antes de la fan-out.**']) assert.ok(arena.includes(lead), lead)
    assert.ok(contract.includes('Si `.orca-stack.json` no existe o no tiene `"setup": "completo"`'))
    for (const heading of ['### Verificación', '### PRs', '### Review', '### Skills de Matt', '### Agentes']) assert.ok(contract.includes(`\n${heading}\n`), heading)
    assert.ok(asset('ORCA-STACK.md').includes('A Claude worker may run an arena or swarm only when its dispatch or bounce note'))
    // The worker side of the moved Despacho and step 5 text reaches every agent through its brief.
    for (const agent of ['claude', 'codex', 'agy', 'pi']) {
      const brief = renderBrief('ticket', { AGENT: agent, ISSUE: '42', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })
      assert.ok(brief.includes(`starts with \`Consulta: ${agent}\``), agent)
      assert.ok(brief.includes('A message from main may arrive while you work.'), agent)
      assert.ok(brief.includes('handle any `Respuesta de main:` / `Respuesta del humano:`'), agent)
      // Step 2 of main's cycle: the worker checks off the ticket's `## Tareas`, and may edit the issue body to do it.
      assert.ok(brief.includes('Check off each `T<n>` of the issue\'s `## Tareas` in the issue body as soon as it is done (`gh issue edit 42 --body-file <file>`, changing only that checkbox).'), agent)
      assert.ok(brief.includes('- Operations: read issue #42 and its comments and the repo; comment on the issue; check off its `## Tareas` with `gh issue edit 42 --body-file <file>`; push only the ticket branch to `origin`; open the PR against main.'), agent)
    }
  })

  test('R2 negative: MAIN.md does not take the Permisos lines that workers act on', () => {
    const permisos = section(main, '### Permisos')
    assert.ok(permisos.startsWith('Un worktree terminado se marca terminado'))
    assert.doesNotMatch(permisos, /Sin preguntar:|Se pregunta:|Excepción de `Arena y swarm`/)
  })

  test('R3: the pointer line closes Qué rol tenés and uses the base dir of the ORCA-STACK.md path line', () => {
    const role = section(contract, '### Qué rol tenés')
    assert.equal(paragraphs(role).at(-1), POINTER)
    assert.equal(MAIN_PATH, '~/orca/stack/MAIN.md')
    const block = policyBlock({ policyPath: POLICY, briefsPath: '~/orca/stack/ROLE-BRIEFS.md' })
    assert.ok(block.includes(`Política canónica: \`${path.posix.dirname(POLICY)}/ORCA-STACK.md\``))
    assert.ok(block.includes(POINTER))
  })

  test('R4: Ciclo de main, Arena y swarm and Marchas stay as stubs that point to MAIN.md, and the fixed markers stay whole', () => {
    for (const heading of ['### Ciclo de `main`', '### Marchas', '### Modo `un-agente`']) {
      assert.deepEqual(paragraphs(section(contract, heading)), [`Esta sección es solo de \`main\` y está en \`${MAIN_PATH}\`.`], heading)
    }
    assert.ok(paragraphs(section(contract, '### Arena y swarm'))[0].includes(`está en \`${MAIN_PATH}\``))
    const markers = contract.split(/\r?\n/).find(line => line.includes('son marcas fijas del protocolo'))
    assert.ok(markers.startsWith('Los encabezados `## Evidencia`, `## Desvíos del ticket`'))
    assert.ok(markers.endsWith('porque la sesión de `main` las busca literalmente.'))
    assert.doesNotMatch(contract, /\n### Despacho\n/)
  })

  test('R7: CONTRATO.md is at most 24576 bytes', () => {
    assert.ok(contractFits(contract), `CONTRATO.md is ${Buffer.byteLength(contract, 'utf8')} bytes`)
  })

  test('R7 negative: a 24577-byte contract fails the guard and a 24576-byte one passes', () => {
    assert.equal(contractFits('x'.repeat(24577)), false)
    assert.equal(contractFits('x'.repeat(24576)), true)
    assert.equal(contractFits('é'.repeat(12289)), false, 'the guard counts UTF-8 bytes, not characters')
  })
})

describe('issue 325 R6: global installs MAIN.md and doctor checks it', () => {
  let home
  beforeEach(() => {
    home = tempDir('main-doc')
  })
  afterEach(() => cleanup(home))

  test('global writes MAIN.md next to ORCA-STACK.md and ROLE-BRIEFS.md, byte for byte', () => {
    const result = cli(home, ['global', '--skip-pi'])
    assert.equal(result.status, 0, result.out)
    const stack = path.join(home, 'orca', 'stack')
    for (const name of ['ORCA-STACK.md', 'ROLE-BRIEFS.md']) assert.ok(existsSync(path.join(stack, name)), name)
    assert.equal(read(path.join(stack, 'MAIN.md')), main)
    assert.match(result.out, /MAIN\.md/)
  })

  test('global --help lists MAIN.md with the policy docs it installs', () => {
    const result = cli(home, ['global', '--help'])
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /1\. ~\/orca\/stack\/ORCA-STACK\.md, ROLE-BRIEFS\.md y MAIN\.md \(las reglas de main\)/)
  })

  test('doctor reports MAIN.md ok after global, and fails naming it when it is missing', () => {
    assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
    const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: home }).out
    assert.match(doctor(), /✔ MAIN\.md/)
    unlinkSync(path.join(home, 'orca', 'stack', 'MAIN.md'))
    assert.match(doctor(), /✖ MAIN\.md - falta /)
  })
})
