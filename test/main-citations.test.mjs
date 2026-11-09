import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { read } from './helpers.mjs'

// Issue 334: three citations still pointed main to contract text that moved to ~/orca/stack/MAIN.md (issue 325).
const ROOT = process.cwd()
const file = (...parts) => read(path.join(ROOT, ...parts))
const main = file('assets', 'stack', 'MAIN.md')
const section = heading => main.split(`\n${heading}\n`)[1]?.split('\n### ')[0] ?? ''

describe('issue 334: citations point to MAIN.md', () => {
  test('Rule 2: ORCA-STACK.md, guardia-despacho and marchas cite MAIN.md where the text now lives', () => {
    const policy = file('assets', 'stack', 'ORCA-STACK.md')
    assert.ok(!policy.includes("Ticket authoring rules are defined in the project's `AGENTS.md` contract"))
    assert.ok(policy.includes('Ticket authoring rules are defined in `~/orca/stack/MAIN.md` ("Ciclo de `main`", step 2).'))
    assert.match(section('### Ciclo de `main`'), /\n2\. Cada ticket lleva criterios de aceptación y `## Reglas`/)

    const inspect = file('mods', 'guardia-despacho', 'hooks', 'inspect.ts')
    assert.ok(!inspect.includes('CONTRATO.md, "Permisos"'))
    assert.ok(inspect.includes('Remover un worktree necesita el OK del humano (~/orca/stack/MAIN.md, "Permisos").'))
    assert.ok(section('### Permisos').includes('`orca worktree rm` borra también la rama local'))

    const marchas = file('mods', 'marchas', 'hooks', 'register.tsx')
    assert.ok(!marchas.includes('secci\\u00f3n "Arena y swarm" del contrato'))
    assert.ok(marchas.includes('se\\u00f1ales de la secci\\u00f3n "Arena y swarm" de ~/orca/stack/MAIN.md.'))
    assert.ok(section('### Arena y swarm').includes('**Señales.**'))
  })
})
