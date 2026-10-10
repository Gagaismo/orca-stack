import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { CODEX_ASCII_MARKERS, CODEX_ASCII_RULE, PROFILE_LINE, codexWindowsChecks, probeGetContent } from '../src/codex-windows.mjs'
import { buildBlock, removeBlock, upsertBlock } from '../src/marker.mjs'
import { cleanup, cli, read, snapshot, tempDir, write } from './helpers.mjs'

const codes = text => [...text].map(char => char.charCodeAt(0)).join(',')
const BLOCK = buildBlock(CODEX_ASCII_RULE, '\n', CODEX_ASCII_MARKERS)
// 'está' as cp1252 decodes it (written escaped: the repo scans tracked files for mojibake).
const MOJIBAKE = 'est\u00C3\u00A1'
const PROFILE = 'C:\\Users\\Ana\\OneDrive\\Documentos\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1'

// A stand-in for powershell.exe: answers the probe as PowerShell would after decoding the file to `text`.
const fakeExec = ({ text, profile = PROFILE, ...rest } = {}) => {
  const calls = []
  const exec = (cmd, args, options) => {
    const file = /Get-Content -Raw '([^']+)'/.exec(args.at(-1))[1]
    calls.push({ cmd, args, options, bytes: readFileSync(file) })

    return { status: 0, stdout: `ORCA_TEXT=${codes(text)}\r\nORCA_PROFILE=${codes(profile)}\r\n`, stderr: '', error: null, timedOut: false, ...rest }
  }

  return { exec, calls }
}

let home
beforeEach(() => {
  home = tempDir('codex-win')
})
afterEach(() => cleanup(home))

const agentsMd = () => path.join(home, '.codex', 'AGENTS.md')
const checks = (exec, over = {}) =>
  codexWindowsChecks({ windows: true, codex: true, agentsMd: agentsMd(), probe: () => probeGetContent({ exec }), ...over })
const probeCheck = results => results.find(result => result.label.includes('Get-Content'))
const blockCheck = results => results.find(result => result.label.includes('regla ASCII'))

describe('doctor: codex Get-Content probe on Windows', () => {
  test('rule 1: no profile line, the probe reads mojibake and doctor warns with the profile line and $PROFILE path', () => {
    const { exec, calls } = fakeExec({ text: MOJIBAKE })
    const result = probeCheck(checks(exec))

    assert.equal(result.level, 'warn')
    assert.ok(result.detail.includes(PROFILE_LINE), result.detail)
    assert.ok(result.detail.includes(PROFILE), result.detail)
    assert.equal(PROFILE_LINE, "$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'")
    // Same call as codex: powershell.exe -Command, no -NoProfile; the file is UTF-8 without BOM.
    assert.equal(calls[0].cmd, 'powershell.exe')
    assert.equal(calls[0].args[0], '-Command')
    assert.ok(!calls[0].args.includes('-NoProfile'))
    assert.deepEqual([...calls[0].bytes], [...Buffer.from('está', 'utf8')])
  })

  test('rule 2: with the profile line the probe reads está intact and doctor reports ok', () => {
    const { exec } = fakeExec({ text: 'está' })
    assert.equal(probeCheck(checks(exec)).level, 'ok')
  })

  test('rule 6: powershell.exe missing or slower than 10 s warns "could not verify" and never fails or hangs', () => {
    const missing = fakeExec({ text: '', status: null, stdout: '', error: Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }) })
    const slow = fakeExec({ text: '', status: null, stdout: '', error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }), timedOut: true })

    const absent = probeCheck(checks(missing.exec))
    assert.equal(absent.level, 'warn')
    assert.match(absent.detail, /no se pudo verificar: .*ENOENT/)
    const late = probeCheck(checks(slow.exec))
    assert.equal(late.level, 'warn')
    assert.match(late.detail, /no se pudo verificar: .*10 s/)
    assert.ok(slow.calls[0].options.timeout <= 10_000)
  })

  test('rule 7: when the profile does not load (Restricted policy) the mojibake warning names the execution policy', () => {
    const { exec } = fakeExec({ text: MOJIBAKE })
    const result = probeCheck(checks(exec))

    assert.equal(result.level, 'warn')
    assert.match(result.detail, /política de ejecución/)
    assert.match(result.detail, /Get-ExecutionPolicy/)
  })

  test('rule 8 and codex not in agentes.usa: nothing runs and nothing is reported', () => {
    let probed = 0
    const probe = () => {
      probed += 1

      return { status: 'ok' }
    }
    assert.deepEqual(codexWindowsChecks({ windows: false, codex: true, agentsMd: agentsMd(), probe }), [])
    assert.deepEqual(codexWindowsChecks({ windows: true, codex: false, agentsMd: agentsMd(), probe }), [])
    assert.equal(probed, 0)
  })
})

describe('doctor: codex ASCII block', () => {
  test('warns with "run global" when ~/.codex/AGENTS.md has no block, and reports ok once it has one', () => {
    const { exec } = fakeExec({ text: 'está' })
    const absent = blockCheck(checks(exec))
    assert.equal(absent.level, 'warn')
    assert.match(absent.detail, /corré `orca-stack global`/)

    write(agentsMd(), '## Rules\n\n- mine\n')
    assert.equal(blockCheck(checks(exec)).level, 'warn')

    write(agentsMd(), `## Rules\n\n${BLOCK}\n`)
    assert.equal(blockCheck(checks(exec)).level, 'ok')
  })

  test('doctor prints neither check off Windows or when codex is not in agentes.usa', () => {
    write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify({ agentes: { usa: ['codex'] } }))
    const linux = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: home, env: { ORCA_STACK_PLATFORM: 'linux' } })
    assert.doesNotMatch(linux.out, /Codex en Windows|Get-Content|regla ASCII/)

    write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify({ agentes: { usa: ['claude', 'codex-cc'] } }))
    const noCodex = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: home, env: { ORCA_STACK_PLATFORM: 'win32' } })
    assert.doesNotMatch(noCodex.out, /Codex en Windows|Get-Content|regla ASCII/)
  })
})

describe('marker helpers with other markers', () => {
  test('upsertBlock and removeBlock with the codex markers leave orca-stack and legacy blocks alone', () => {
    const others = `${buildBlock('policy')}\n\n<!-- orca-stack:auto -->\nold\n<!-- /orca-stack:auto -->\n`
    const withCodex = upsertBlock(others, CODEX_ASCII_RULE, CODEX_ASCII_MARKERS)
    assert.equal(withCodex, `${others}\n${BLOCK}\n`)
    assert.deepEqual(removeBlock(withCodex, CODEX_ASCII_MARKERS), { text: others, found: true })
  })
})

describe('global and remove: codex ASCII block', () => {
  // A PATH with only node: global's own command lands in the temp home, never in a real PATH directory.
  const bin = () => path.join(home, 'path-bin')
  beforeEach(() => write(path.join(bin(), '.probe'), ''))
  const run = (args, platform = 'win32') => {
    const result = cli(home, args, { env: { ORCA_STACK_PLATFORM: platform, PATH: [bin(), path.dirname(process.execPath)].join(path.delimiter) } })
    assert.equal(result.status, 0, result.out)

    return result
  }

  test('rule 3: appends the block after text of its own, keeps that text byte for byte, and a second run changes nothing', () => {
    const own = '## Rules\r\n\r\n- Mine, with accents: acción.\r\n'
    write(agentsMd(), own)
    run(['global', '--skip-pi'])
    const first = read(agentsMd())
    assert.ok(first.startsWith(own), first)
    assert.equal(first, upsertBlock(own, CODEX_ASCII_RULE, CODEX_ASCII_MARKERS))
    assert.ok(first.includes(CODEX_ASCII_MARKERS.begin) && first.includes(CODEX_ASCII_MARKERS.end))

    const again = run(['global', '--skip-pi'])
    assert.equal(read(agentsMd()), first)
    assert.match(again.out, /ya tiene la regla/)
  })

  test('updates an older block in place without touching text outside the markers', () => {
    const before = '## Rules\n\n- mine\n\n'
    const after = '\n\n## More\n\n- also mine\n'
    write(agentsMd(), `${before}${buildBlock('old rule', '\n', CODEX_ASCII_MARKERS)}${after}`)
    run(['global', '--skip-pi'])
    assert.equal(read(agentsMd()), `${before}${BLOCK}${after}`)
  })

  test('rule 4: no ~/.codex/AGENTS.md, global creates it with only the block', () => {
    write(path.join(home, '.codex', 'config.toml'), '')
    run(['global', '--skip-pi'])
    assert.equal(read(agentsMd()), `${BLOCK}\n`)
  })

  test('rule 5: no ~/.codex, global writes nothing there', () => {
    const result = run(['global', '--skip-pi'])
    assert.equal(existsSync(path.join(home, '.codex')), false)
    assert.match(result.out, /codex no está instalado/)
  })

  test('rule 8: off Windows, global does not write the block', () => {
    write(agentsMd(), '## Rules\n')
    const result = run(['global', '--skip-pi'], 'linux')
    assert.equal(read(agentsMd()), '## Rules\n')
    assert.doesNotMatch(result.out, /Regla ASCII de codex/)
  })

  test('global --dry-run writes nothing', () => {
    write(agentsMd(), '## Rules\n')
    const pristine = snapshot(home)
    const result = run(['global', '--skip-pi', '--dry-run'])
    assert.match(result.out, /regla ASCII de codex/)
    assert.deepEqual(snapshot(home), pristine)
  })

  test('remove deletes the block and leaves the rest of the file; a file global created goes away', () => {
    const own = '## Rules\n\n- mine\n'
    write(agentsMd(), own)
    run(['global', '--skip-pi'])
    run(['remove'])
    assert.equal(read(agentsMd()), own)

    cleanup(agentsMd())
    run(['global', '--skip-pi'])
    assert.equal(read(agentsMd()), `${BLOCK}\n`)
    run(['remove'])
    assert.equal(existsSync(agentsMd()), false)
    assert.equal(existsSync(path.join(home, '.codex')), true)
  })
})
