import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { cleanup, cli, git, read, ROOT, tempDir, write } from './helpers.mjs'

const SENTENCE = 'Ponytail se aplica en el trabajo de implementación con el nivel configurado, pero nunca contra un requisito explícito.'
const POINTER = 'Sus reglas están en `~/orca/stack/PONYTAIL.md`, el fragmento del perk de ponytail.'
const CORE = ['ORCA-STACK.md', 'ROLE-BRIEFS.md', 'MAIN.md']
const BRIEFS = ['brief-planificacion.md', 'brief-rdd.md', 'brief-rebote.md', 'brief-revision.md', 'brief-ticket.md']
const flat = text => text.replace(/\s+/g, ' ')

// The temp dirs avoid the word "ponytail": the rendered docs carry the home path.
// `global` into a fresh home with the given personal config, then `init` in a fresh repo with the given project config.
const setup = ({ personal, project } = {}) => {
  const home = tempDir('perk394-home')
  const repo = path.join(tempDir('perk394-repo'), 'project')
  if (personal !== undefined) write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify(personal))
  const global = cli(home, ['global', '--skip-pi'])
  assert.equal(global.status, 0, global.out)
  write(path.join(repo, 'README.md'), '# project\n')
  if (project !== undefined) write(path.join(repo, '.orca-stack.json'), JSON.stringify(project))
  git(repo, 'init', '-q', '-b', 'main')
  const init = cli(home, ['init'], { cwd: repo })
  assert.equal(init.status, 0, init.out)

  return { home, repo, block: read(path.join(repo, 'AGENTS.md')).replace(/\r\n/g, '\n'), stack: path.join(home, 'orca', 'stack') }
}
const teardown = ({ home, repo }) => {
  cleanup(home)
  cleanup(path.dirname(repo))
}

describe('#394 Ponytail as a perk', () => {
  test('S1: with Ponytail off by default, the contract, the core docs and the briefs have no Ponytail rule, and PONYTAIL.md is installed and checked', () => {
    const env = setup()
    try {
      assert.doesNotMatch(env.block, /ponytail|perk:/i)
      assert.ok(env.block.includes('Gentle Shell (Pi) trabaja con la suya y puede usar ODD.\n- Respetá los requisitos'), 'the bullet ends right after ODD')
      for (const name of CORE) assert.doesNotMatch(read(path.join(env.stack, name)), /ponytail/i, name)
      for (const name of BRIEFS) assert.doesNotMatch(read(path.join(ROOT, 'assets', 'stack', name)), /ponytail/i, name)
      assert.ok(existsSync(path.join(env.stack, 'PONYTAIL.md')), 'PONYTAIL.md installed beside MARCHAS.md')
      const doctor = cli(env.home, ['doctor', '--offline', '--skip-pi'], { cwd: env.home })
      assert.match(doctor.out, /✔ PONYTAIL\.md/)
      cleanup(path.join(env.stack, 'PONYTAIL.md'))
      assert.match(cli(env.home, ['doctor', '--offline', '--skip-pi'], { cwd: env.home }).out, /✖ PONYTAIL\.md - falta /)
    } finally {
      teardown(env)
    }
  })

  test('S2: with Ponytail on, the contract keeps today’s sentence and points to PONYTAIL.md, which carries today’s Ponytail rules', () => {
    const env = setup({ project: { perks: { ponytail: true } } })
    try {
      assert.ok(env.block.includes(`Gentle Shell (Pi) trabaja con la suya y puede usar ODD. ${SENTENCE} ${POINTER}\n`), env.block)
      assert.doesNotMatch(env.block, /perk:/)
      const fragment = flat(read(path.join(env.stack, 'PONYTAIL.md')))
      assert.match(fragment, /\*\*Ponytail \(modular\)\*\*: implementation policy only: avoid unnecessary work and choose the smallest correct solution/)
      assert.match(fragment, /Its level is `lite`, `full` or `ultra` \(the wrappers set `full`\), and a shortcut with a known limit gets a `shortcut: <the limit>, <when to upgrade>` code comment\./)
      assert.match(fragment, /Ponytail implementation policy\./)
      assert.match(fragment, /Ponytail may reduce the implementation footprint inside an approved ticket; it may not remove research/)
      assert.match(fragment, /the Ponytail reviewer role keeps only its Lean findings and passes any non-Lean \*Must fix\* to main in one line\. `ponytail-audit` is opt-in and repo-wide\./)
      assert.match(fragment, /`ponytail-debt` lists the `shortcut:` comments and older `ponytail:` ones\./)
      assert.match(fragment, /Ponytail is not active for research output\./)
      assert.match(fragment, /apply Ponytail's smallest complete change, and mark a shortcut with a known limit `shortcut: <the limit>, <when to upgrade>`/)
      assert.match(fragment, /## Ponytail reviewer \*\*Mission:\*\* second-pass review for over-engineering only, after correctness\/spec review\./)
      assert.match(fragment, /When it finds a non-Lean \*Must fix\* \(a bug, data loss\), pass it to main in one line, never drop it\./)
    } finally {
      teardown(env)
    }
  })

  test('S3: global installs the Ponytail skills with the perk off and on', () => {
    for (const personal of [undefined, { perks: { ponytail: true } }]) {
      const env = setup({ personal })
      try {
        for (const root of ['.claude', '.agents']) {
          for (const skill of ['ponytail-review', 'ponytail-audit']) {
            assert.ok(existsSync(path.join(env.home, root, 'skills', skill, 'SKILL.md')), `${root} ${skill} ${JSON.stringify(personal)}`)
          }
        }
      } finally {
        teardown(env)
      }
    }
  })
})
