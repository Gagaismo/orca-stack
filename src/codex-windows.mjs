import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { hasBlock } from './marker.mjs'
import { isFile, run, tilde, which } from './util.mjs'

// codex-cli on Windows reads files with `<shell> -Command "Get-Content -Raw <file>"` (no -NoProfile), and
// Windows PowerShell 5.1 decodes UTF-8 without BOM as cp1252: the model sees mojibake and writes it back (#58).
// Two fixes: a rule in codex's AGENTS.md (written by `global`) and a line in the PowerShell profile (added by hand).
// PowerShell 7 (pwsh) reads UTF-8 by default, and codex prefers it when it finds it.

// codex's shell on Windows: pwsh on PATH, then its default install path, then powershell.exe
// (openai/codex rust-v0.162.1: codex-rs/shell-command/src/shell_detect.rs:267 and :351).
const PWSH_DEFAULT = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
export const codexPowerShell = ({ env = process.env, exists = existsSync } = {}) =>
  which('pwsh', env) ?? (exists(PWSH_DEFAULT) ? PWSH_DEFAULT : 'powershell.exe')

// The global instructions file codex reads: AGENTS.override.md when it has text, else AGENTS.md; never both
// (openai/codex rust-v0.162.1: codex-rs/codex-home/src/instructions/mod.rs:43).
export const codexAgentsMd = dir => {
  const override = path.join(dir, 'AGENTS.override.md')

  return isFile(override) && readFileSync(override, 'utf8').trim() !== '' ? override : path.join(dir, 'AGENTS.md')
}

export const CODEX_ASCII_MARKERS = {
  begin: '<!-- orca-stack:codex-ascii:begin -->',
  end: '<!-- orca-stack:codex-ascii:end -->',
}

export const CODEX_ASCII_RULE = `## Source code stays ASCII (Windows)

- Source code stays pure ASCII: write every non-ASCII character in a string literal as a \`\\u\` escape (for example \`'acci\\u00f3n'\` for "acción"). Markdown and other prose files keep real accents.
- Reason: on Windows, PowerShell 5.1 can garble accented text you read and copy into code (Gagaismo/orca-stack#58).`

export const PROFILE_LINE = "$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'"

const SAMPLE = 'está'
const PROBE_TIMEOUT = 10_000

// PowerShell prints code points, not text: the answer depends only on how Get-Content decoded the file,
// never on the encoding of the stdout pipe. Same for $PROFILE, whose path can hold any character.
const codes = expr => `([int[]][char[]](${expr}) -join ',')`
const fromCodes = list => String.fromCharCode(...list.split(',').filter(Boolean).map(Number))

// Inspects the codex ASCII block markers. Returns { status: 'ok' | 'none' | 'malformed', from, end, inner }.
export const codexBlock = text => {
  const count = marker => text.split(marker).length - 1
  const opens = count(CODEX_ASCII_MARKERS.begin)
  const closes = count(CODEX_ASCII_MARKERS.end)
  if (opens === 0 && closes === 0) {
    return { status: 'none' }
  }
  const begin = text.indexOf(CODEX_ASCII_MARKERS.begin)
  const end = text.indexOf(CODEX_ASCII_MARKERS.end)
  if (opens !== 1 || closes !== 1 || end < begin) {
    return { status: 'malformed' }
  }
  const from = begin + CODEX_ASCII_MARKERS.begin.length

  return { status: 'ok', from, end, inner: text.slice(from, end) }
}

// Reads a UTF-8 file without BOM the way codex does. Returns { status: 'ok' | 'mojibake' | 'error', text, profile, reason }.
export const probeGetContent = ({ exec = run, tmpdir = os.tmpdir(), shell = codexPowerShell() } = {}) => {
  const name = path.basename(shell)
  const dir = mkdtempSync(path.join(tmpdir, 'orca-stack-probe-'))
  const file = path.join(dir, 'probe.txt')
  writeFileSync(file, SAMPLE, 'utf8')
  try {
    const script = [
      `'ORCA_TEXT=' + ${codes(`Get-Content -LiteralPath '${file.replaceAll("'", "''")}' -Raw`)}`,
      `'ORCA_PROFILE=' + ${codes('$PROFILE')}`,
    ].join('; ')
    const result = exec(shell, ['-Command', script], { timeout: PROBE_TIMEOUT, env: process.env })
    if (result.timedOut) {
      return { status: 'error', reason: `${name} tardó más de ${PROBE_TIMEOUT / 1000} s` }
    }
    if (result.error) {
      return { status: 'error', reason: `no pude ejecutar ${name} (${result.error.code ?? result.error.message})` }
    }
    const text = /ORCA_TEXT=([\d,]*)/.exec(result.stdout)?.[1]
    if (result.status !== 0 || text === undefined) {
      return { status: 'error', reason: `${name} salió con ${result.status}: ${result.stderr.trim().split('\n')[0] ?? ''}` }
    }
    const read = fromCodes(text).trim()
    const profile = fromCodes(/ORCA_PROFILE=([\d,]*)/.exec(result.stdout)?.[1] ?? '')

    return { status: read === SAMPLE ? 'ok' : 'mojibake', text: read, profile, shell: name }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// doctor's checks for codex on Windows. Nothing runs, and nothing is reported, off Windows or without codex.
export const codexWindowsChecks = ({ windows, codex, agentsMd, probe = probeGetContent }) => {
  if (!windows || !codex) {
    return []
  }
  const found = []
  const result = probe()
  if (result.status === 'ok') {
    found.push({ level: 'ok', label: 'codex: Get-Content lee UTF-8', detail: `${result.shell} leyó "${SAMPLE}" intacto` })
  } else if (result.status === 'mojibake') {
    found.push({
      level: 'warn',
      label: 'codex: Get-Content lee UTF-8',
      detail:
        `${result.shell} leyó "${result.text}" en vez de "${SAMPLE}": codex va a escribir mojibake. ` +
        `Agregá esta línea a ${result.profile || '$PROFILE'}: ${PROFILE_LINE} ` +
        '(si ya está, puede que la política de ejecución no deje cargar el perfil: mirá `Get-ExecutionPolicy -List`)',
    })
  } else {
    found.push({ level: 'warn', label: 'codex: Get-Content lee UTF-8', detail: `no se pudo verificar: ${result.reason}` })
  }

  const label = `codex: regla ASCII en ${tilde(agentsMd)}`
  let text = null
  try {
    text = readFileSync(agentsMd, 'utf8')
  } catch {
    // missing: reported below
  }
  try {
    found.push(
      text !== null && hasBlock(text, CODEX_ASCII_MARKERS)
        ? { level: 'ok', label }
        : { level: 'warn', label, detail: 'falta: corré `orca-stack global`' },
    )
  } catch (error) {
    found.push({ level: 'warn', label, detail: error.message })
  }

  return found
}
