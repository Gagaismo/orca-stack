import assert from 'node:assert/strict'
import { chmodSync, existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { ODD_MANDATE, gentleTargets, planLazyFile, restoreLazyBlocks, trimReviewSections, trimRoutingBlock } from '../src/gentle.mjs'
import { layout } from '../src/util.mjs'
import { ROUTING_GONE, ROUTING_KEPT, fakeGentle, fixtureV4, routingV4, runtimeFile, sddConfig, withPath } from './gentle-fixture.mjs'
import { backups, cleanup, cli, read, snapshot, tempDir, write } from './helpers.mjs'

const ROUTING_OPEN = '<!-- gentle-ai:agent-routing -->'
const ROUTING_CLOSE = '<!-- /gentle-ai:agent-routing -->'
const ORCH_OPEN = '<!-- gentle-ai:orchestrator -->'
const ORCH_CLOSE = '<!-- /gentle-ai:orchestrator -->'
const count = (text, needle) => text.split(needle).length - 1
const carriesMandate = text => ODD_MANDATE.some(phrase => text.includes(phrase))
// What gentle-ai v4 sync leaves in each runtime file.
const fresh = { claude: () => fixtureV4('\n'), codex: () => runtimeFile('codex'), gemini: () => runtimeFile('gemini') }

describe('trimRoutingBlock against the gentle-ai v4 routing shape', () => {
  test('rule 1: each runtime keeps step 1, the routes, the triggers and the nested block, in order, LF and CRLF', () => {
    for (const eol of ['\n', '\r\n']) {
      for (const runtime of ['claude', 'codex', 'gemini']) {
        const text = routingV4(runtime).join(eol) + eol
        const { text: trimmed, saved, skipped } = trimRoutingBlock(text, '/copy.md', runtime)
        assert.equal(skipped, undefined, `${runtime}: ${skipped}`)
        assert.ok(!carriesMandate(trimmed), runtime)
        for (const gone of ROUTING_GONE) {
          assert.ok(!trimmed.includes(gone), `${runtime}: ${gone}`)
        }
        const kept = runtime === 'gemini' ? ROUTING_KEPT : [...ROUTING_KEPT.slice(0, 3), '### Receipt-driven development is user-owned', ...ROUTING_KEPT.slice(3)]
        const positions = kept.map(line => trimmed.indexOf(line))
        assert.ok(positions.every(at => at !== -1), `${runtime}: ${kept[positions.indexOf(-1)]}`)
        assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${runtime}: kept out of order`)
        assert.ok(trimmed.includes('gentle-ai ODD (Organic Driven Development): only when the human explicitly asks for it.'))
        assert.ok(trimmed.includes('`/copy.md`') && trimmed.includes('odd/tasks/'))
        assert.ok(!(eol === '\r\n' && /[^\r]\n/.test(trimmed)), 'no bare LF in a CRLF file')
        assert.equal(trimmed.slice(0, trimmed.indexOf(ROUTING_OPEN) + ROUTING_OPEN.length) + saved + trimmed.slice(trimmed.indexOf(ROUTING_CLOSE)), text)
      }
    }
  })

  test('rule 5: a missing or repeated anchor refuses the whole file and names the anchor', () => {
    const target = gentleTargets(layout('/home'))[1]
    const missing = fresh.codex().replace('Resume an interrupted feature with `mem_context`, then the task file itself.\n\n', '')
    assert.match(planLazyFile(missing, target).skipped, /falta el ancla "Resume an interrupted feature"/)
    const repeated = fresh.codex().replace('After explicit change', '2. **Explore.** again\n\nAfter explicit change')
    assert.match(planLazyFile(repeated, target).skipped, /se repite el ancla "2\. \*\*Explore\.\*\*"/)
    const noTable = fresh.codex().replace('### Codex ODD worker assignments', '')
    assert.match(planLazyFile(noTable, target).skipped, /falta el ancla "### Codex ODD worker assignments"/)
  })

  test('rule 6: an unknown heading inside agent-routing refuses the whole file and names the heading', () => {
    const text = fresh.claude().replace('### Mandatory Delegation Triggers', '### Something New\n\nnew body\n\n### Mandatory Delegation Triggers')
    assert.match(planLazyFile(text, gentleTargets(layout('/home'))[0]).skipped, /encabezado que no reconozco: ### Something New/)
  })
})

describe('global, doctor and remove over the three runtime files', () => {
  let home
  let bin
  beforeEach(() => {
    home = tempDir('odd-home')
    bin = tempDir('odd-bin')
    fakeGentle(bin, 'off', 'global')
  })
  afterEach(() => {
    cleanup(home)
    cleanup(bin)
  })
  const files = () => ({
    claude: path.join(home, '.claude', 'CLAUDE.md'),
    codex: path.join(home, '.codex', 'AGENTS.md'),
    gemini: path.join(home, '.gemini', 'GEMINI.md'),
  })
  const writeAll = (texts = {}) => {
    for (const [runtime, file] of Object.entries(files())) {
      write(file, texts[runtime] ?? fresh[runtime]())
    }
  }
  const readAll = () => Object.fromEntries(Object.entries(files()).map(([runtime, file]) => [runtime, read(file)]))
  const global = () => cli(home, ['global', '--skip-pi', '--humano', 'Ana'], { env: withPath(bin) })
  const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { env: withPath(bin) })
  const gentleDir = () => path.join(home, '.orca-stack', 'gentle')

  test('rule 1: RDD off and lazy mode trim all three files, keep each marker once, and leave a full copy of every block', () => {
    writeAll()
    const result = global()
    assert.equal(result.status, 0, result.out)
    for (const [runtime, text] of Object.entries(readAll())) {
      assert.ok(!carriesMandate(text), `${runtime} still carries the ODD mandate`)
      for (const marker of [ROUTING_OPEN, ROUTING_CLOSE, ORCH_OPEN, ORCH_CLOSE, '<!-- gentle-ai:remote-authorization -->']) {
        assert.equal(count(text, marker), 1, `${runtime}: ${marker}`)
      }
      for (const line of ROUTING_KEPT) {
        assert.ok(text.includes(line), `${runtime}: ${line}`)
      }
      const target = gentleTargets(layout(home)).find(each => each.runtime === runtime)
      assert.equal(restoreLazyBlocks(text, target, read).text, fresh[runtime](), `${runtime}: the copies give the original back`)
    }
    assert.deepEqual(Object.keys(snapshot(gentleDir())).sort(), [
      'claude-agent-routing.md',
      'codex-agent-routing.md',
      'codex-orchestrator.md',
      'gemini-agent-routing.md',
      'gemini-orchestrator.md',
      'sdd-orchestrator.md',
    ])
    assert.doesNotMatch(doctor().out, /mandato ODD|bloque de gentle-ai/)
  })

  test('rule 2: a second run changes nothing and says the blocks are already lazy', () => {
    writeAll()
    assert.equal(global().status, 0)
    const before = { ...snapshot(path.join(home, '.claude')), ...snapshot(path.join(home, '.codex')), ...snapshot(path.join(home, '.gemini')), ...snapshot(gentleDir()) }
    const again = global()
    assert.equal(again.status, 0, again.out)
    assert.equal(count(again.out, 'gentle-ai:orchestrator ya está en modo lazy'), 3)
    assert.equal(count(again.out, 'gentle-ai:agent-routing ya está en modo lazy'), 3)
    assert.deepEqual({ ...snapshot(path.join(home, '.claude')), ...snapshot(path.join(home, '.codex')), ...snapshot(path.join(home, '.gemini')), ...snapshot(gentleDir()) }, before)
  })

  test('rule 3: with RDD on or unreadable claude and codex stay exactly as gentle-ai wrote them, and global and doctor say why', () => {
    for (const status of ['on', 'broken']) {
      writeAll()
      fakeGentle(bin, status, 'global')
      const result = global()
      assert.equal(result.status, 0, result.out)
      assert.equal(count(result.out, 'el mandato ODD sigue, porque el RDD lo necesita'), 2, result.out)
      const after = readAll()
      assert.equal(after.claude, fresh.claude())
      assert.equal(after.codex, fresh.codex())
      assert.match(doctor().out, /⚠ mandato ODD de gentle-ai en ~\/\.codex\/AGENTS\.md - sigue porque el RDD de gentle-ai está (prendido|en un estado que no pude leer)/)
    }
  })

  test('rule 3: turning RDD on after a lazy run restores both blocks of claude and codex from their copies', () => {
    writeAll()
    assert.equal(global().status, 0)
    fakeGentle(bin, 'on', 'global')
    assert.match(doctor().out, /⚠ bloque de gentle-ai en ~\/\.codex\/AGENTS\.md - está en modo lazy pero el RDD/)
    assert.equal(global().status, 0)
    const after = readAll()
    assert.equal(after.claude, fresh.claude())
    assert.equal(after.codex, fresh.codex())
  })

  test('rule 4: gemini is trimmed even with RDD on', () => {
    writeAll()
    fakeGentle(bin, 'on', 'global')
    assert.equal(global().status, 0)
    const gemini = read(files().gemini)
    assert.ok(!carriesMandate(gemini))
    assert.doesNotMatch(doctor().out, /mandato ODD de gentle-ai en ~\/\.gemini/)
  })

  test('rule 5: a missing anchor leaves that file untouched, names it and the anchor, and the other files are still trimmed', () => {
    const broken = fresh.codex().replace('Resume an interrupted feature with `mem_context`, then the task file itself.\n\n', '')
    writeAll({ codex: broken })
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Bloques de gentle-ai en ~\/\.codex\/AGENTS\.md\n {2}se omite y no toco nada: falta el ancla "Resume an interrupted feature"/)
    const after = readAll()
    assert.equal(after.codex, broken)
    assert.ok(!carriesMandate(after.claude) && !carriesMandate(after.gemini))
    assert.match(doctor().out, /⚠ mandato ODD de gentle-ai en ~\/\.codex\/AGENTS\.md - global no lo recorta: falta el ancla "Resume an interrupted feature"/)
  })

  test('rule 5: a protocol heading glued to step 1 leaves the file untouched and names the swallowed anchor', () => {
    const glued = fresh.codex().replace('### ODD protocol (MANDATORY, in this order, on every request)\n\n1. **Authorize.**', '### ODD protocol (MANDATORY, in this order, on every request)\n1. **Authorize.**')
    writeAll({ codex: glued })
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /se omite y no toco nada:.*"1\. \*\*Authorize\.\*\*".*falta una l\u00ednea en blanco/)
    assert.equal(read(files().codex), glued)
  })

  test('rule 5: Resume glued to the routes paragraph leaves the file untouched and names the swallowed anchor', () => {
    const glued = fresh.codex().replace('Resume an interrupted feature with `mem_context`, then the task file itself.\n\nAfter explicit change intent', 'Resume an interrupted feature with `mem_context`, then the task file itself.\nAfter explicit change intent')
    writeAll({ codex: glued })
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /se omite y no toco nada:.*"After explicit change intent is established".*falta una l\u00ednea en blanco/)
    assert.equal(read(files().codex), glued)
  })

  test('rule 6: an unknown heading leaves that file untouched and names the heading', () => {
    const odd = fresh.gemini().replace('### Mandatory Delegation Triggers', '### Something New\n\n### Mandatory Delegation Triggers')
    writeAll({ gemini: odd })
    const result = global()
    assert.match(result.out, /se omite y no toco nada: hay un encabezado que no reconozco: ### Something New/)
    assert.equal(read(files().gemini), odd)
  })

  test('rule 7: a file with one block processes it and says the other one is missing', () => {
    const routingOnly = `${routingV4('gemini').join('\n')}\n`
    const orchestratorOnly = fresh.codex().slice(fresh.codex().indexOf(ROUTING_CLOSE) + ROUTING_CLOSE.length)
    writeAll({ gemini: routingOnly, codex: orchestratorOnly })
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Bloques de gentle-ai en ~\/\.gemini\/GEMINI\.md\n {2}no hay bloque gentle-ai:orchestrator/)
    assert.match(result.out, /Bloques de gentle-ai en ~\/\.codex\/AGENTS\.md\n {2}no hay bloque gentle-ai:agent-routing/)
    assert.ok(!carriesMandate(read(files().gemini)) && !carriesMandate(read(files().codex)))
  })

  test('rule 8: when a copy cannot be written the file is not modified', () => {
    writeAll()
    write(path.join(gentleDir(), 'codex-agent-routing.md'), 'not ours')
    const result = global()
    assert.match(result.out, /no pude guardar la copia completa de gentle-ai:agent-routing/)
    assert.equal(read(files().codex), fresh.codex())
    assert.ok(!carriesMandate(read(files().gemini)))
  })

  test('rule 9: each file is backed up under ~/.orca-stack/backups/ before it is written', () => {
    writeAll()
    assert.equal(global().status, 0)
    const saved = backups(home)
    for (const name of ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.gemini/GEMINI.md']) {
      const backup = saved.find(file => file.endsWith(name))
      assert.ok(backup, name)
      const runtime = name.includes('claude') ? 'claude' : name.includes('codex') ? 'codex' : 'gemini'
      assert.equal(read(path.join(home, backup)), fresh[runtime]())
    }
  })

  test('rule 10: text outside the gentle-ai markers is never modified', () => {
    writeAll()
    assert.equal(global().status, 0)
    const outside = text => [text.slice(0, text.indexOf(ROUTING_OPEN)), text.slice(text.indexOf(ROUTING_CLOSE), text.indexOf(ORCH_OPEN)), text.slice(text.indexOf(ORCH_CLOSE))]
    for (const [runtime, text] of Object.entries(readAll())) {
      assert.deepEqual(outside(text), outside(fresh[runtime]()), runtime)
    }
    assert.ok(read(files().codex).includes('<!-- orca-stack:codex-ascii:begin -->'))
  })

  test('rule 11: global and doctor only ever ask gentle-ai for the review mode status', () => {
    const log = path.join(bin, 'calls.log')
    const win = process.platform === 'win32'
    const file = path.join(bin, win ? 'gentle-ai.cmd' : 'gentle-ai')
    write(file, win ? `@echo %*>>"${log}"\r\n@echo receipt-driven development: off (decided by global)\r\n` : `#!/bin/sh\necho "$*" >> "${log}"\necho "receipt-driven development: off (decided by global)"\n`)
    if (!win) {
      chmodSync(file, 0o755)
    }
    writeAll()
    assert.equal(global().status, 0)
    sddConfig(home, 'full')
    assert.equal(global().status, 0)
    doctor()
    const calls = read(log).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    assert.ok(calls.length > 0)
    assert.deepEqual([...new Set(calls)], ['review mode status'])
  })

  test('full mode puts all three files back exactly as gentle-ai wrote them', () => {
    writeAll()
    assert.equal(global().status, 0)
    sddConfig(home, 'full')
    const result = global()
    assert.equal(result.status, 0, result.out)
    const after = readAll()
    assert.equal(after.codex, fresh.codex())
    assert.equal(after.gemini, fresh.gemini())
    assert.equal(after.claude, trimReviewSections(fresh.claude()).text) // full mode still trims claude's review sections with RDD off
  })

  test('preserve: remove restores every lazy block of the three files before deleting the copies', () => {
    writeAll()
    assert.equal(global().status, 0)
    const result = cli(home, ['remove'], { env: withPath(bin) })
    assert.equal(result.status, 0, result.out)
    assert.deepEqual(readAll(), { claude: fresh.claude(), codex: fresh.codex(), gemini: fresh.gemini() })
    assert.equal(existsSync(path.join(gentleDir(), 'codex-agent-routing.md')), false)
  })
})
