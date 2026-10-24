import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { dispatch, reboteCommand, renderBrief } from '../src/despacho.mjs'
import { policyBlock } from '../src/templates.mjs'
import { cleanup, tempDir, write } from './helpers.mjs'

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = (stdout = '') => ({ status: 0, stdout, stderr: '' })

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PROJECT = {
  setup: 'completo',
  modo: 'multiagente',
  ramaBase: 'main',
  agentes: { usa: ['claude', 'agy', 'codex', 'pi'], preguntarAntes: [] },
  verificacion: { suite: 'npm test -- --run', typecheck: 'npm run typecheck' },
}

let home
let root
let worktree

beforeEach(() => {
  home = tempDir('odd-home')
  root = path.join(tempDir('odd-root'), 'proj')
  worktree = path.join(tempDir('odd-wt'), 'proj-feat-x')
  write(path.join(root, 'x'), '')
  write(path.join(worktree, 'src', 'app.ts'), '')
})

afterEach(() => {
  for (const dir of [home, path.dirname(root), path.dirname(worktree)]) cleanup(dir)
})

const fakeIo = (over = {}, { config = PROJECT } = {}) => {
  write(path.join(root, '.orca-stack.json'), JSON.stringify(config))
  const calls = []
  const out = []
  const written = []
  const files = new Map()
  const io = {
    home,
    cwd: root,
    win: true,
    out: line => out.push(line),
    sleep: async () => {},
    exists: existsSync,
    readFile: file => files.get(file) ?? readFileSync(file, 'utf8'),
    listFiles: () => [],
    mkdirp: () => {},
    writeFile: (file, text) => {
      written.push([file, text])
      write(file, text)
    },
    gentleSkills: () => 'C:\\pi\\gentle-pi\\skills',
    sh: (cmd, args, opts = {}) => {
      calls.push([cmd, ...args])
      const found = over[`${cmd} ${args[0]} ${args[1] ?? ''}`.trim()] ?? over[`${cmd} ${args[0]}`]
      const custom = typeof found === 'function' ? found(args) : found
      if (custom) return custom
      if (cmd === 'git' && args[0] === 'ls-files') return { status: 1, stdout: '', stderr: '' }
      if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('--path-format=absolute')) {
        return okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
      }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') return okRes('abc123\n')
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return okRes('abc123\n')
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return okRes(`worktree ${root}\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD abc123\nbranch refs/heads/feat/x\n`)
      if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') return okRes('https://github.com/Gagaismo/orca-stack.git\n')
      if (cmd === 'git' && args[0] === 'status') return okRes('')
      if (cmd === 'git') return okRes('src/app.ts\n')
      if (cmd === 'gh' && args[0] === 'issue') return json({ state: 'OPEN', assignees: [], title: 't' })
      if (cmd === 'gh' && args[0] === 'pr') return json({
        state: 'OPEN',
        number: 7,
        headRefName: 'feat/x',
        headRefOid: 'abc123',
        body: 'Implementador: codex\nCloses #7',
        reviews: [{ body: 'Commit: abc123\n## BLOQUEA\n1. fix this', url: 'https://github.com/Gagaismo/orca-stack/pull/7#pullrequestreview-1' }],
        statusCheckRollup: [],
      })
      if (args.join(' ') === 'worktree ps --json') return json({ result: { worktrees: [] } })
      if (args.join(' ').startsWith('worktree create')) return json({ result: { worktree: { path: worktree, branch: 'refs/heads/proj-7' } } })
      return okRes()
    },
  }
  return { io, calls, out, written }
}

describe('Reglas 1-8', () => {
  test('Regla 1: rendered ticket brief contains the ODD section with feature name, no commit odd/, single-PR, 700 lines warning, push and open PR, and code-review before PR', async () => {
    const env = fakeIo()
    await dispatch('ticket', { n: '7', agent: 'agy', dryRun: true }, env.io)
    const out = env.out.join('\n')

    assert.ok(out.includes('## Method: gentle-ai ODD'), 'includes Method: gentle-ai ODD section')
    assert.ok(out.includes('issue-7'), 'includes feature name issue-7')
    assert.ok(out.includes("Never commit `odd/`.") || out.includes('never commit `odd/`'), 'includes never commit odd/')
    assert.ok(out.includes('Delivery strategy is always a single PR (`single-pr`), never ask.'), 'includes single-pr delivery strategy')
    assert.ok(out.includes('If the diff passes about 700 lines, say so in the issue and keep going.'), 'includes 700 lines warning')
    assert.ok(out.includes('push the branch and open the PR'), 'includes push and open PR line')
    assert.ok(out.includes('Before opening the PR, run the `code-review` skill on the diff'), 'includes code-review before PR')
  })

  test('Regla 2: brief still requires one test per rule and touched public entry, overriding ODD test-first applicability', async () => {
    const env = fakeIo()
    await dispatch('ticket', { n: '7', agent: 'agy', dryRun: true }, env.io)
    const out = env.out.join('\n')

    assert.ok(out.includes("The ticket's `## Reglas` are the feature's acceptance criteria."))
    assert.ok(out.includes('The existing RED and PRESERVE rules above override ODD test-first applicability: one test per rule and one per touched public entry.'))
  })

  test('Regla 3: brief never tells worker to stop and wait: Authorize and Resolve uncertainty are answered by brief and issue', async () => {
    const env = fakeIo()
    await dispatch('ticket', { n: '7', agent: 'agy', dryRun: true }, env.io)
    const out = env.out.join('\n')

    assert.ok(out.includes('ODD step 1 (Authorize): this brief is your explicit authorization to implement the ticket.'))
    assert.ok(out.includes('Step 3 (Resolve uncertainty): product questions go to the issue as a comment'))
    assert.ok(out.includes('never stop and wait'))
  })

  test('Regla 4: Engram unavailable or ambiguous_project marks mirror pending and continues without asking', async () => {
    const env = fakeIo()
    await dispatch('ticket', { n: '7', agent: 'agy', dryRun: true }, env.io)
    const out = env.out.join('\n')

    assert.ok(out.includes('If Engram is unavailable or reports `ambiguous_project`, mark the mirror pending and continue; never ask.'))
  })

  test('Regla 5: rendered bounce brief says to resume the ODD feature issue-<n>', async () => {
    const env = fakeIo()
    await reboteCommand({ dryRun: true }, '7', env.io)
    const out = env.out.join('\n')

    assert.ok(out.includes("Resume the ODD feature `issue-7` with ODD's resume protocol (the document is still in the worktree)."))

    // With a custom Closes #42 in the PR body
    const envCustomIssue = fakeIo({
      'gh pr': json({
        state: 'OPEN',
        number: 15,
        headRefName: 'feat/x',
        headRefOid: 'abc123',
        body: 'Implementador: codex\nCloses #42',
        reviews: [{ body: 'Commit: abc123\n## BLOQUEA\n1. fix this', url: 'https://github.com/Gagaismo/orca-stack/pull/15#pullrequestreview-1' }],
        statusCheckRollup: [],
      }),
    })
    await reboteCommand({ dryRun: true }, '15', envCustomIssue.io)
    const outCustom = envCustomIssue.out.join('\n')
    assert.ok(outCustom.includes("Resume the ODD feature `issue-42` with ODD's resume protocol (the document is still in the worktree)."))
  })

  test('Regla 6: contract and ORCA-STACK.md name ODD as implementation method and SDD nowhere; un-agente implements with ODD', () => {
    const contract = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'CONTRATO.md'), 'utf8')
    const policy = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'ORCA-STACK.md'), 'utf8')

    assert.doesNotMatch(contract, /\bsdd\b/i, 'CONTRATO.md must not mention SDD')
    assert.doesNotMatch(policy, /\bsdd\b/i, 'ORCA-STACK.md must not mention SDD')

    assert.ok(contract.includes('implementación con gentle-ai ODD (main corre ODD para su trabajo de orquestación, nunca implementa tickets)'))
    assert.ok(contract.includes('| claude (worker) | Sí, con ODD |'))
    assert.ok(contract.includes('| Implementar un ticket | gentle-ai ODD |'))
    assert.ok(contract.includes('Cuando `modo` es `"un-agente"` no hay workers: la misma sesión planifica e implementa con ODD'))
    assert.doesNotMatch(contract, /implement-spec/, 'implement-spec is no longer mentioned in contract')

    assert.ok(policy.includes('Implementation across the stack uses gentle-ai ODD.'))
    assert.ok(policy.includes('implementation follows gentle-ai ODD'))
  })

  test('Regla 7: orca-setup adds odd/ to .gitignore when missing and does not duplicate it when present', () => {
    const setupSkill = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'skills', 'orca-setup', 'SKILL.md'), 'utf8')
    assert.ok(setupSkill.includes('Agregá `odd/` a `.gitignore` cuando falte, sin duplicarlo si ya está presente.'))
  })

  test('Regla 8: --nota text still renders after the method section, unchanged', async () => {
    const env = fakeIo()
    await dispatch('ticket', { n: '7', agent: 'agy', nota: 'Note from main session', dryRun: true }, env.io)
    const out = env.out.join('\n')

    const authPos = out.indexOf('## Remote authorization')
    const methodPos = out.indexOf('## Method: gentle-ai ODD')
    const notePos = out.indexOf('## Extra notes from main')

    assert.ok(authPos !== -1, 'has remote authorization section')
    assert.ok(methodPos !== -1, 'has method section')
    assert.ok(notePos !== -1, 'has extra notes section')
    assert.ok(authPos < methodPos, 'remote authorization renders before method section')
    assert.ok(methodPos < notePos, 'method section renders before extra notes')
    assert.ok(out.includes('Note from main session'))
  })
})

describe('Acceptance criteria', () => {
  test('orca-stack despachar <n> <agent> --dry-run prints brief with ODD section and no mention of implement skill or SDD', async () => {
    const env = fakeIo()
    await dispatch('ticket', { n: '7', agent: 'agy', dryRun: true }, env.io)
    const out = env.out.join('\n')

    assert.ok(out.includes('## Method: gentle-ai ODD'))
    assert.doesNotMatch(out, /\bsdd\b/i, 'rendered brief must not mention SDD')
    assert.doesNotMatch(out, /`implement`/, 'rendered brief must not mention the implement skill')
  })

  test('no file under assets/ mentions SDD', () => {
    const assetsDir = path.join(PACKAGE_ROOT, 'assets')
    const findFiles = dir => {
      const entries = readdirSync(dir, { withFileTypes: true })
      const files = []
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) files.push(...findFiles(full))
        else if (entry.isFile()) files.push(full)
      }
      return files
    }

    const files = findFiles(assetsDir)
    const filesWithSdd = files.filter(file => /\bsdd\b/i.test(readFileSync(file, 'utf8')))
    assert.deepEqual(filesWithSdd, [], 'assets/ files must not mention SDD')
  })
})

describe('PRESERVE: public entries touched in src/despacho.mjs and src/templates.mjs', () => {
  test('renderBrief retains existing substitutions and remote authorization', () => {
    const brief = renderBrief('ticket', {
      REPO: 'orca-stack',
      ISSUE: '100',
      AGENT: 'agy',
      BRANCH: 'Gagaismo/orca-stack-100',
      BASE: 'main',
      VERIFICATION: 'npm test',
    })
    assert.ok(brief.includes('# Ticket brief: issue #100 (orca-stack)'))
    assert.ok(brief.includes('Repo: orca-stack. Your branch is Gagaismo/orca-stack-100'))
    assert.ok(brief.includes('Pull requests target main.'))
    assert.ok(brief.includes('gh pr create --base main --head Gagaismo/orca-stack-100'))
    assert.ok(brief.includes('Implementador: agy'))
    assert.ok(brief.includes('Closes #100'))
    assert.ok(brief.includes('## Remote authorization'))
    assert.ok(brief.includes('## Method: gentle-ai ODD'))
  })

  test('rebote retains findings and failed checks rendering', async () => {
    const env = fakeIo()
    await reboteCommand({ dryRun: true }, '7', env.io)
    const out = env.out.join('\n')
    assert.ok(out.includes('## Review findings'))
    assert.ok(out.includes('fix this'))
  })

  test('policyBlock retains policyLines and CONTRATO integration', () => {
    const block = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md' })
    assert.ok(block.includes('### Política del stack'))
    assert.ok(block.includes('Política canónica: `~/orca/stack/ORCA-STACK.md`'))
    assert.ok(block.includes('implementación con gentle-ai ODD en todo el stack'))
    assert.doesNotMatch(block, /\bsdd\b/i)
  })
})
