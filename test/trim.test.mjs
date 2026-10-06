import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { REVIEW_SECTIONS, trimReviewSections } from '../src/gentle.mjs'
import { KEPT, fakeGentle, fixture, withPath } from './gentle-fixture.mjs'
import { backups, cleanup, cli, read, snapshot, tempDir, write } from './helpers.mjs'

const headings = text => text.split(/\r?\n/).filter(line => /^#{1,6} /.test(line))

describe('trimReviewSections', () => {
  test('removes exactly the five review sections and keeps every other heading and marker', () => {
    const { text, removed } = trimReviewSections(fixture('\n'))
    assert.deepEqual(headings(text), [...KEPT.slice(0, 2), '### Lossless Blocking Prompts (MANDATORY)', ...KEPT.slice(2)])
    for (const gone of REVIEW_SECTIONS) {
      assert.ok(!text.includes(gone), gone)
    }
    for (const kept of KEPT) {
      assert.ok(text.includes(kept), kept)
    }
    for (const body of ['lossless body', 'consent body', 'language body', 'triggers body', 'cost body', 'research body', 'models body', 'workflow body', 'engram body']) {
      assert.ok(text.includes(body), body)
    }
    for (const body of ['defect body', 'gate body', 'checking body', 'entry body', 'table', 'concurrent body', 'inside a fence', 'authority-first']) {
      assert.ok(!text.includes(body), body)
    }
    for (const marker of ['<!-- gentle-ai:sdd-orchestrator -->', '<!-- /gentle-ai:sdd-orchestrator -->', '<!-- gentle-ai:sdd-model-assignments -->', '<!-- /gentle-ai:sdd-model-assignments -->']) {
      assert.ok(text.includes(marker), marker)
    }
    assert.equal(removed, Buffer.byteLength(fixture('\n')) - Buffer.byteLength(text))
    assert.ok(removed > 0)
  })

  test('is idempotent', () => {
    const once = trimReviewSections(fixture('\n')).text
    assert.deepEqual(trimReviewSections(once), { text: once, removed: 0 })
  })

  test('keeps CRLF files CRLF', () => {
    const { text } = trimReviewSections(fixture('\r\n'))
    assert.ok(!/[^\r]\n/.test(text), 'no bare LF')
    assert.ok(!text.includes('gate body'))
  })

  test('leaves a text without the block, or with an endless Review Execution Contract, untouched', () => {
    const plain = '## Engram Persistent Memory\n#### Native Checking Contract\nbody\n'
    assert.deepEqual(trimReviewSections(plain), { text: plain, removed: 0 })
    const broken = fixture('\n').replace('#### Cost and Context Balance', '#### Something else')
    const result = trimReviewSections(broken)
    assert.equal(result.text, broken)
    assert.equal(result.removed, 0)
    assert.match(result.skipped, /no tiene un encabezado donde termine/)
  })

  test('is all-or-nothing: an unknown heading inside the text to remove, or an open fence, changes nothing', () => {
    const cases = {
      'an inserted heading before Cost and Context Balance': [fixture('\n').replace('#### Cost and Context Balance', '#### X\nx body\n#### Cost and Context Balance'), /encabezado que no reconozco: #### X/],
      'an unknown heading inside a shorter section': [fixture('\n').replace('gate body', '##### Deeper\ngate body'), /##### Deeper/],
      'an unbalanced fence': [fixture('\n').replace('// not a heading, inside a fence\n```', '// not a heading, inside a fence'), /sin cerrar/],
      'a fence opened in the removed text and closed later in kept text': [fixture('\n').replace('gate body', '```\n#### Hidden\ngate body').replace('cost body', 'cost body\n```'), /#### Hidden/],
    }
    for (const [name, [text, why]] of Object.entries(cases)) {
      const result = trimReviewSections(text)
      assert.equal(result.text, text, name)
      assert.equal(result.removed, 0, name)
      assert.match(result.skipped, why, name)
    }
    assert.equal(trimReviewSections(fixture('\n')).skipped, undefined)
  })

  test('an indented fence (inside a list item) hides its `# comment` lines too', () => {
    const text = fixture('\n').replace('// not a heading, inside a fence', '# a shell comment\n// not a heading, inside a fence').replace(/^```$/gm, '  ```')
    const result = trimReviewSections(text)
    assert.equal(result.skipped, undefined)
    assert.ok(!result.text.includes('# a shell comment'))
  })

  test('a balanced fence inside the removed text may hold `# comment` lines', () => {
    const text = fixture('\n').replace('// not a heading, inside a fence', '# a shell comment\n// not a heading, inside a fence')
    const result = trimReviewSections(text)
    assert.equal(result.skipped, undefined)
    assert.ok(result.removed > 0)
    assert.ok(!result.text.includes('# a shell comment'))
  })
})

describe('global trims the gentle-ai review sections', () => {
  let home
  let bin
  beforeEach(() => {
    home = tempDir('trim-home')
    bin = tempDir('trim-bin')
  })
  afterEach(() => {
    cleanup(home)
    cleanup(bin)
  })
  const claudeMd = () => path.join(home, '.claude', 'CLAUDE.md')

  test('RDD off: trims with a backup, reports the KB, and a second run changes nothing', () => {
    fakeGentle(bin, 'off')
    write(claudeMd(), fixture('\n'))
    const first = cli(home, ['global', '--skip-pi', '--humano', 'Ana'], { env: withPath(bin) })
    assert.equal(first.status, 0, first.out)
    assert.match(first.out, /KB menos en cada sesión/)
    assert.match(first.out, /gentle-ai sync/)
    assert.ok(!read(claudeMd()).includes('Native Checking Contract'))
    assert.match(read(claudeMd()), /orca-stack:begin/)
    const saved = backups(home).filter(name => name.endsWith('CLAUDE.md'))
    assert.equal(saved.length, 1)
    assert.equal(read(path.join(home, saved[0])), fixture('\n'))
    const after = snapshot(home)
    const second = cli(home, ['global', '--skip-pi', '--humano', 'Ana'], { env: withPath(bin) })
    assert.equal(second.status, 0, second.out)
    assert.match(second.out, /ya están recortadas/)
    assert.deepEqual(snapshot(home), after)
  })

  test('--dry-run reports the trim and writes nothing', () => {
    fakeGentle(bin, 'off')
    write(claudeMd(), fixture('\n'))
    const before = snapshot(home)
    const result = cli(home, ['global', '--dry-run', '--skip-pi'], { env: withPath(bin) })
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /\[simulación\] actualizo .*sin las secciones de review/)
    assert.deepEqual(snapshot(home), before)
  })

  test('a block that changed shape is left alone and global says why', () => {
    fakeGentle(bin, 'off')
    const changed = fixture('\n').replace('#### Cost and Context Balance', '#### X\nx body\n#### Cost and Context Balance')
    write(claudeMd(), changed)
    const result = cli(home, ['global', '--skip-pi', '--humano', 'Ana'], { env: withPath(bin) })
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /se omite y no toco nada: el texto de gentle-ai cambió de forma \(.*#### X/)
    assert.ok(read(claudeMd()).includes('#### X'))
    assert.ok(read(claudeMd()).includes('Native Checking Contract'))
  })

  test('RDD on: skips and says why', () => {
    fakeGentle(bin, 'on')
    write(claudeMd(), fixture('\n'))
    const result = cli(home, ['global', '--skip-pi'], { env: withPath(bin) })
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /RDD\) está prendido/)
    assert.ok(read(claudeMd()).includes('Native Checking Contract'))
    assert.equal(existsSync(path.join(home, '.orca-stack')), true)
  })
})
