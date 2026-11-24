import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { ROOT, read } from './helpers.mjs'

// #435: the personal Orca settings checklist.
const DOC = 'docs/orca-personal.md'
const doc = () => read(path.join(ROOT, DOC))
const checklist = () => doc().split('## Checklist')[1].split('\n## ')[0]
const items = () => checklist().split('\n- [ ] ').slice(1)
const field = (item, name) => item.split('\n').find(line => line.trim().startsWith(`- ${name}:`))

describe('#435 personal Orca settings checklist', () => {
  test('R1: the checklist has the three items, each with where it lives in Orca and its recommended value', () => {
    const [awake, confirm, cleanup] = items()
    assert.equal(items().length, 4)
    assert.match(awake, /^\*\*Mantener la compu despierta mientras trabajan los agentes\.\*\*/)
    assert.match(field(awake, 'Dónde'), /Settings → Agents → Keep computer awake/)
    assert.match(field(awake, 'Valor'), /`Agent`/)
    assert.match(confirm, /^\*\*Confirmar antes de borrar un worktree\.\*\*/)
    assert.match(field(confirm, 'Dónde'), /Force Delete.*Always force delete/)
    assert.match(field(confirm, 'Valor'), /nunca elegir Always force delete/)
    assert.match(cleanup, /^\*\*Workspace Cleanup solo para los worktrees de bots y automatizaciones\.\*\*/)
    assert.match(field(cleanup, 'Dónde'), /Settings → Workspace Cleanup.*Workspace cleanup → Cleanup rules/)
    assert.match(field(cleanup, 'Valor'), /reglas propias solo en los proyectos de bots y automatizaciones/)
  })

  test('R2: every item says why in one line, and the cleanup one says limpiar keeps worktrees with uncommitted changes', () => {
    for (const item of items()) {
      const why = field(item, 'Por qué')
      assert.ok(why, `item without a why: ${item.split('\n')[0]}`)
    }
    const [awake, confirm, cleanup] = items()
    assert.match(field(awake, 'Por qué'), /no hay un servidor remoto siempre prendido/)
    assert.match(field(confirm, 'Por qué'), /cambios sin commitear se perdería/)
    assert.match(field(cleanup, 'Por qué'), /`limpiar` conserva los worktrees con cambios sin commitear.*una regla de limpieza más amplia podría borrarlos/)
  })

  test('R3: negative: no checklist item asks to change a setting the stack configures, and the doc names those as the stack\'s', () => {
    assert.doesNotMatch(checklist(), /orca\.yaml|worktreeinclude|metadata|tarjeta/i)
    const stack = doc().split('## Lo que configura el stack')[1]
    assert.ok(stack, 'the doc has no section for the stack-owned settings')
    assert.match(stack, /No son ajustes personales: son del stack, viven en el repo o en la tarjeta del worktree, y se cambian con un commit, no en Settings de Orca\./)
    for (const name of ['`orca.yaml`', '`.worktreeinclude`', 'La metadata de la tarjeta de cada worktree']) {
      assert.ok(stack.includes(name), `stack section does not name ${name}`)
    }
  })

  test('R4: not a doctor check: doctor reads none of these settings and the doc says so', () => {
    assert.match(doc(), /`doctor` no los lee ni los exige/)
    for (const file of readdirSync(path.join(ROOT, 'src'))) {
      assert.doesNotMatch(read(path.join(ROOT, 'src', file)), /Keep computer awake|Caffeinate|Always force delete|Workspace Cleanup/i, `src/${file} reads a personal Orca setting`)
    }
  })

  test('#433 R1 and R2: the stack Quick Commands are a checklist item, not a file init writes, with exactly the four non-destructive commands', () => {
    const quick = items().find(item => item.startsWith('**Quick Commands del stack en cada proyecto.**'))
    assert.ok(quick, 'the checklist has no Quick Commands item')
    assert.match(field(quick, 'Dónde'), /Settings → Quick Commands, con scope Project/)
    assert.match(field(quick, 'Dónde'), /no en un archivo del repo, así que `init` no los escribe/)
    const commands = [...field(quick, 'Valor').matchAll(/`(orca-stack [^`]+)`/g)].map(match => match[1])
    assert.deepEqual(commands, ['orca-stack estado', 'orca-stack vigilar', 'orca-stack limpiar', 'orca-stack doctor'])
    assert.match(field(quick, 'Valor'), /^ *- Valor: exactamente cuatro:/)
    for (const command of commands) assert.doesNotMatch(command, /merge|--force|remove|rm\b|reset|delete/)
    assert.ok(field(quick, 'Por qué'))
    for (const file of readdirSync(path.join(ROOT, 'src'))) {
      assert.doesNotMatch(read(path.join(ROOT, 'src', file)), /quickCommands|Quick Commands/i, `src/${file} writes Quick Commands`)
    }
  })

  test('R5: the README links the checklist from its Orca step, and the doc is in Spanish', () => {
    const steps = read(path.join(ROOT, 'README.md')).split('## Pasos manuales')[1].split('\n## ')[0]
    const orcaStep = steps.split('\n').find(line => line.startsWith('1. **Orca > Settings'))
    assert.ok(orcaStep.includes(`[checklist de ajustes personales de Orca](${DOC})`), 'README Orca step does not link the checklist')
    assert.match(doc(), /^# Ajustes personales de Orca\n/)
    assert.match(doc(), /Configuralos una vez por máquina\./)
  })
})
