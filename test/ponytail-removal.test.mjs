import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { STACK_LEVELS, WRAPPERS } from '../src/constants.mjs'
import { PERKS, perkProblems, perksOf } from '../src/perks.mjs'
import { cmdWrapper, policyBlock, shWrapper, stackMarkers } from '../src/templates.mjs'
import { sha256 } from '../src/util.mjs'
import { cleanup, cli, git, read, ROOT, tempDir, write } from './helpers.mjs'

const RETIRED_SKILLS = ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-help', 'ponytail-review']

const seedInstalledPonytail = home => {
  const files = {}
  const stackFile = path.join(home, 'orca', 'stack', 'PONYTAIL.md')
  const stackContent = '# old PONYTAIL.md\n'
  write(stackFile, stackContent)
  files[stackFile] = { sha256: sha256(Buffer.from(stackContent, 'utf8')), backup: null, existedBefore: false }

  for (const root of ['.claude', '.agents']) {
    for (const skill of RETIRED_SKILLS) {
      for (const name of ['SKILL.md', 'LICENSE']) {
        const file = path.join(home, root, 'skills', skill, name)
        const content = `old ${skill} ${name}\n`
        write(file, content)
        files[file] = { sha256: sha256(Buffer.from(content, 'utf8')), backup: null, existedBefore: false }
      }
    }
  }
  write(path.join(home, '.orca-stack', 'state.json'), JSON.stringify({
    schema: 1,
    tool: 'orca-stack',
    version: '0.22.0',
    installedAt: '2026-11-25T00:00:00.000Z',
    files,
    dirsCreated: [],
    mods: [],
    skills: ['orca-stack-policy', ...RETIRED_SKILLS],
    settings: null,
    claudeMd: null,
    codexAgentsMd: null,
    config: null,
    pi: { packagesInstalled: [], npmGlobalInstalled: false, piInstalled: false },
    backups: [],
  }, null, 2))

  return files
}

describe('#429 Remove the Ponytail perk', () => {
  test('R2: Ponytail files, perk entry, env wiring and mods config are removed and global no longer installs them', () => {
    assert.equal(existsSync(path.join(ROOT, 'assets', 'stack', 'PONYTAIL.md')), false, 'PONYTAIL.md removed')
    assert.equal(existsSync(path.join(ROOT, 'assets', 'skills', 'ponytail-upstream.json')), false, 'ponytail-upstream.json removed')
    for (const skill of RETIRED_SKILLS) {
      assert.equal(existsSync(path.join(ROOT, 'assets', 'skills', skill)), false, `${skill} removed`)
    }
    assert.deepEqual(PERKS, ['marchas', 'caveman'])
    assert.equal('ponytail' in STACK_LEVELS, false)
    assert.equal('ORCA_STACK_PONYTAIL_LEVEL' in stackMarkers({ marchas: true, caveman: true }), false)
    for (const agent of Object.keys(WRAPPERS)) {
      assert.doesNotMatch(cmdWrapper(agent, { caveman: true }), /ORCA_STACK_PONYTAIL_LEVEL/)
      assert.doesNotMatch(shWrapper(agent, { caveman: true }), /ORCA_STACK_PONYTAIL_LEVEL/)
    }
    assert.doesNotMatch(read(path.join(ROOT, 'shared', 'orca-config.ts')), /ponytail/i)
    assert.doesNotMatch(read(path.join(ROOT, 'src', 'despacho.mjs')), /ORCA_STACK_PONYTAIL_LEVEL|SHORTCUT_EXCUSE/)
    assert.doesNotMatch(read(path.join(ROOT, 'assets', 'stack', 'brief-ticket.md')), /SHORTCUT_EXCUSE/)

    const home = tempDir('rm429-r2-home')
    const repo = path.join(tempDir('rm429-r2-repo'), 'project')
    try {
      const global = cli(home, ['global', '--skip-pi'])
      assert.equal(global.status, 0, global.out)
      assert.equal(existsSync(path.join(home, 'orca', 'stack', 'PONYTAIL.md')), false)
      for (const root of ['.claude', '.agents']) {
        for (const skill of RETIRED_SKILLS) {
          assert.equal(existsSync(path.join(home, root, 'skills', skill)), false, `${root}/${skill}`)
        }
      }
      write(path.join(repo, 'README.md'), '# project\n')
      write(path.join(repo, '.orca-stack.json'), JSON.stringify({ perks: { ponytail: true } }))
      git(repo, 'init', '-q', '-b', 'main')
      const init = cli(home, ['init'], { cwd: repo })
      assert.equal(init.status, 0, init.out)
      assert.doesNotMatch(read(path.join(repo, 'AGENTS.md')), /ponytail/i)
      assert.doesNotMatch(init.out, /ponytail/i)
      assert.doesNotMatch(global.out, /ponytail/i)
    } finally {
      cleanup(home)
      cleanup(path.dirname(repo))
    }
  })

  test('R3: global removes previously installed Ponytail copies, leaves user files with the same name alone and reports them, and is idempotent', () => {
    const home = tempDir('rm429-r3-home')
    try {
      const tracked = seedInstalledPonytail(home)
      const foreignSkill = path.join(home, '.claude', 'skills', 'ponytail', 'SKILL.md')
      delete tracked[foreignSkill]
      write(foreignSkill, 'my own ponytail skill\n')
      const foreignExtra = path.join(home, '.agents', 'skills', 'ponytail-review', 'notes.md')
      write(foreignExtra, 'my notes\n')
      const stateFile = path.join(home, '.orca-stack', 'state.json')
      const stateBefore = JSON.parse(read(stateFile))
      delete stateBefore.files[foreignSkill]
      write(stateFile, JSON.stringify(stateBefore, null, 2))

      const dry = cli(home, ['global', '--skip-pi', '--dry-run'])
      assert.equal(dry.status, 0, dry.out)
      assert.equal(existsSync(path.join(home, 'orca', 'stack', 'PONYTAIL.md')), true)
      assert.match(dry.out, /PONYTAIL\.md/)

      const first = cli(home, ['global', '--skip-pi'])
      assert.equal(first.status, 0, first.out)
      assert.equal(existsSync(path.join(home, 'orca', 'stack', 'PONYTAIL.md')), false, 'PONYTAIL.md removed')
      for (const skill of ['ponytail-audit', 'ponytail-debt', 'ponytail-help']) {
        for (const root of ['.claude', '.agents']) {
          assert.equal(existsSync(path.join(home, root, 'skills', skill)), false, `${root}/${skill} pruned`)
        }
      }
      assert.equal(existsSync(path.join(home, '.claude', 'skills', 'ponytail-review')), false, '.claude/skills/ponytail-review pruned')
      assert.equal(existsSync(path.join(home, '.agents', 'skills', 'ponytail')), false, '.agents/skills/ponytail pruned')

      assert.equal(read(foreignSkill), 'my own ponytail skill\n')
      assert.equal(read(foreignExtra), 'my notes\n')
      assert.match(first.out, /⚠ .*ponytail[\\/]SKILL\.md.*no lo instaló orca-stack/i)
      assert.match(first.out, /⚠ .*ponytail-review[\\/]notes\.md.*no lo instaló orca-stack/i)

      const stateAfter = JSON.parse(read(stateFile))
      assert.equal(stateAfter.files[path.join(home, 'orca', 'stack', 'PONYTAIL.md')], undefined)
      for (const skill of RETIRED_SKILLS) {
        assert.equal(stateAfter.skills.includes(skill), false)
      }

      const second = cli(home, ['global', '--skip-pi'])
      assert.equal(second.status, 0, second.out)
      assert.equal(read(foreignSkill), 'my own ponytail skill\n')
      assert.equal(read(foreignExtra), 'my notes\n')
    } finally {
      cleanup(home)
    }
  })

  test('R3 user-file-only: global leaves an untracked ~/orca/stack/PONYTAIL.md alone and reports it', () => {
    const home = tempDir('rm429-r3-user-home')
    try {
      const userDoc = path.join(home, 'orca', 'stack', 'PONYTAIL.md')
      write(userDoc, 'user custom file\n')
      const result = cli(home, ['global', '--skip-pi'])
      assert.equal(result.status, 0, result.out)
      assert.equal(read(userDoc), 'user custom file\n')
      assert.match(result.out, /⚠ .*PONYTAIL\.md.*no lo instaló orca-stack/i)
    } finally {
      cleanup(home)
    }
  })

  test('R4: doctor reports leftover perks.ponytail per layer (personal, project, local) naming the file, silent when absent, warning exit code unchanged', () => {
    const runDoctor = ({ personal, project, local } = {}) => {
      const home = tempDir('rm429-r4-home')
      const repo = path.join(tempDir('rm429-r4-repo'), 'project')
      try {
        if (personal !== undefined) write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify(personal))
        write(path.join(repo, 'README.md'), '# project\n')
        if (project !== undefined) write(path.join(repo, '.orca-stack.json'), JSON.stringify(project))
        if (local !== undefined) write(path.join(repo, '.orca-stack.local.json'), JSON.stringify(local))
        git(repo, 'init', '-q', '-b', 'main')

        return cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo })
      } finally {
        cleanup(home)
        cleanup(path.dirname(repo))
      }
    }

    const clean = runDoctor({ personal: { humano: 'Ana' }, project: { perks: { marchas: true } }, local: { perks: { caveman: false } } })
    assert.doesNotMatch(clean.out, /perks\.ponytail/)
    assert.doesNotMatch(clean.out, /PONYTAIL\.md/)

    for (const [label, layers, expectedFile] of [
      ['personal', { personal: { perks: { ponytail: true } } }, '~/.orca-stack/config.json'],
      ['project', { project: { perks: { ponytail: true } } }, '.orca-stack.json'],
      ['local', { local: { perks: { ponytail: false } } }, '.orca-stack.local.json'],
    ]) {
      const res = runDoctor(layers)
      assert.equal(res.status, clean.status, `${label}: warning does not change exit code`)
      const line = res.out.split(/\r?\n/).find(l => l.includes('perks.ponytail'))
      assert.ok(line, `${label}: missing perks.ponytail warning in:\n${res.out}`)
      assert.match(line, /^\s*⚠ /)
      assert.ok(line.includes(expectedFile), `${label}: line names ${expectedFile}: ${line}`)
      assert.match(line, /borrar/i, `${label}: line says it can be deleted: ${line}`)
    }

    const allThree = runDoctor({
      personal: { perks: { ponytail: true } },
      project: { perks: { ponytail: false } },
      local: { perks: { ponytail: true } },
    })
    assert.equal(allThree.status, clean.status)
    const lines = allThree.out.split(/\r?\n/).filter(l => l.includes('perks.ponytail'))
    assert.equal(lines.length, 3, allThree.out)
    assert.ok(lines.some(l => l.includes('~/.orca-stack/config.json')))
    assert.ok(lines.some(l => l.includes('.orca-stack.json')))
    assert.ok(lines.some(l => l.includes('.orca-stack.local.json')))
  })

  test('R5: init never edits an existing CODING_STANDARDS.md that asks for shortcut: comments', () => {
    const home = tempDir('rm429-r5-home')
    const repo = path.join(tempDir('rm429-r5-repo'), 'project')
    try {
      write(path.join(repo, 'README.md'), '# project\n')
      const customStandards = '# Standards\n\nUse `shortcut:` comments for known limits.\n'
      write(path.join(repo, 'CODING_STANDARDS.md'), customStandards)
      git(repo, 'init', '-q', '-b', 'main')
      const init = cli(home, ['init'], { cwd: repo })
      assert.equal(init.status, 0, init.out)
      assert.equal(read(path.join(repo, 'CODING_STANDARDS.md')), customStandards)
    } finally {
      cleanup(home)
      cleanup(path.dirname(repo))
    }
  })

  test('R7: README, manual, guia-setup, MAIN.md, ROLE-BRIEFS.md, ORCA-STACK.md, MARCHAS.md and CAVEMAN.md no longer mention Ponytail', () => {
    const docs = [
      ['README.md'],
      ['docs', 'guia-setup.md'],
      ['assets', 'stack', 'MAIN.md'],
      ['assets', 'stack', 'ROLE-BRIEFS.md'],
      ['assets', 'stack', 'ORCA-STACK.md'],
      ['assets', 'stack', 'MARCHAS.md'],
      ['assets', 'stack', 'CAVEMAN.md'],
    ]
    for (const parts of docs) {
      assert.doesNotMatch(readFileSync(path.join(ROOT, ...parts), 'utf8'), /ponytail/i, parts.join('/'))
    }
    const manualWithoutAdrLink = readFileSync(path.join(ROOT, 'docs', 'manual.md'), 'utf8')
      .replace(/0002-deprecate-ponytail-adopt-comment-rule\.md/g, '')
    assert.doesNotMatch(manualWithoutAdrLink, /ponytail/i, 'docs/manual.md')
  })

  test('PRESERVE: perksOf, perkProblems and policyBlock still handle marchas and caveman', () => {
    assert.deepEqual(perksOf({}), { marchas: false, caveman: false })
    assert.deepEqual(perksOf({ perks: { marchas: true, caveman: true, ponytail: true } }), { marchas: true, caveman: true })
    assert.equal(perkProblems({ perks: { marchas: 'yes' } }).length, 1)
    assert.equal(perkProblems({ perks: { ponytail: 'yes' } }).length, 0)
    const block = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md', perks: { marchas: true, caveman: true } })
    assert.match(block, /### Marchas/)
    assert.match(block, /CAVEMAN\.md/)
    assert.doesNotMatch(block, /ponytail|perk:/i)
  })
})
