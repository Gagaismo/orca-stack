import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { STACK_LEVELS, WRAPPERS } from './constants.mjs'
import { PACKAGE_ROOT } from './util.mjs'

export const render = (text, vars) =>
  text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (key in vars ? vars[key] : whole))

export const assetPath = (...parts) => path.join(PACKAGE_ROOT, 'assets', ...parts)

// Every file under dir, as paths relative to it (forward slashes), sorted.
export const listFiles = (dir, skip = () => false) => {
  const found = []
  const walk = (current, rel) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name)
      const relPath = rel ? `${rel}/${name}` : name
      if (skip(relPath, name)) {
        continue
      }
      if (statSync(full).isDirectory()) {
        walk(full, relPath)
      } else {
        found.push(relPath)
      }
    }
  }
  walk(dir, '')

  return found
}

export const listDirs = dir =>
  readdirSync(dir)
    .filter(name => statSync(path.join(dir, name)).isDirectory())
    .sort()

export const readAsset = (...parts) => readFileSync(assetPath(...parts), 'utf8')

// What a mod copy leaves out: tests, dev tsconfig and files the Claude Code engine generates at load.
export const skipForMod = (rel, name) =>
  name === 'node_modules' || name === 'tests' || name === 'tsconfig.json' || rel === '.claude-plugin/types'

export const wrapperFile = (agent, win) => `${agent}-orca-stack${win ? '.cmd' : '.sh'}`

export const cmdWrapper = agent => {
  const probes = WRAPPERS[agent].windows
    .map(
      exe =>
        `for /f "delims=" %%P in ('where ${exe} 2^>nul') do if not defined ORCA_STACK_AGENT set "ORCA_STACK_AGENT=%%P"`,
    )
    .join('\r\n')
  const names = WRAPPERS[agent].windows.join(' ni ')

  return [
    '@echo off',
    `rem Generado por orca-stack (${agent}). Se regenera con "orca-stack global"; no lo edites a mano.`,
    'setlocal',
    'set "NoDefaultCurrentDirectoryInExePath=1"',
    `set "ORCA_STACK_MODE=${STACK_LEVELS.mode}"`,
    `set "ORCA_STACK_CAVEMAN_LEVEL=${STACK_LEVELS.caveman}"`,
    `set "ORCA_STACK_PONYTAIL_LEVEL=${STACK_LEVELS.ponytail}"`,
    'for %%I in ("%~dp0..\\ORCA-STACK.md") do set "ORCA_STACK_POLICY_PATH=%%~fI"',
    '',
    'if /I "%~1"=="--orca-stack-self-test" (',
    '  echo ORCA_STACK_MODE=%ORCA_STACK_MODE%',
    '  echo ORCA_STACK_CAVEMAN_LEVEL=%ORCA_STACK_CAVEMAN_LEVEL%',
    '  echo ORCA_STACK_PONYTAIL_LEVEL=%ORCA_STACK_PONYTAIL_LEVEL%',
    '  echo ORCA_STACK_POLICY_PATH=%ORCA_STACK_POLICY_PATH%',
    '  exit /b 0',
    ')',
    '',
    'set "ORCA_STACK_AGENT="',
    probes,
    'if not defined ORCA_STACK_AGENT (',
    `  echo ${names} no esta disponible en PATH. 1>&2`,
    '  exit /b 1',
    ')',
    '',
    '"%ORCA_STACK_AGENT%" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n')
}

export const shWrapper = agent => {
  const names = WRAPPERS[agent].posix.join(' ')

  return [
    '#!/bin/sh',
    `# Generado por orca-stack (${agent}). Se regenera con "orca-stack global"; no lo edites a mano.`,
    `ORCA_STACK_MODE=${STACK_LEVELS.mode}`,
    `ORCA_STACK_CAVEMAN_LEVEL=${STACK_LEVELS.caveman}`,
    `ORCA_STACK_PONYTAIL_LEVEL=${STACK_LEVELS.ponytail}`,
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'ORCA_STACK_POLICY_PATH=$(CDPATH= cd -- "$here/.." && pwd)/ORCA-STACK.md',
    'export ORCA_STACK_MODE ORCA_STACK_CAVEMAN_LEVEL ORCA_STACK_PONYTAIL_LEVEL ORCA_STACK_POLICY_PATH',
    '',
    'if [ "$1" = "--orca-stack-self-test" ]; then',
    '  echo "ORCA_STACK_MODE=$ORCA_STACK_MODE"',
    '  echo "ORCA_STACK_CAVEMAN_LEVEL=$ORCA_STACK_CAVEMAN_LEVEL"',
    '  echo "ORCA_STACK_PONYTAIL_LEVEL=$ORCA_STACK_PONYTAIL_LEVEL"',
    '  echo "ORCA_STACK_POLICY_PATH=$ORCA_STACK_POLICY_PATH"',
    '  exit 0',
    'fi',
    '',
    'ORCA_STACK_AGENT=',
    `for candidate in ${names}; do`,
    '  found=$(command -v "$candidate" 2>/dev/null) || continue',
    '  if [ -n "$found" ] && [ "$found" != "$0" ]; then',
    '    ORCA_STACK_AGENT=$found',
    '    break',
    '  fi',
    'done',
    'if [ -z "$ORCA_STACK_AGENT" ]; then',
    `  echo "${names} no está disponible en PATH." >&2`,
    '  exit 1',
    'fi',
    '',
    'exec "$ORCA_STACK_AGENT" "$@"',
    '',
  ].join('\n')
}

export const wrapperContent = (agent, win) => (win ? cmdWrapper(agent) : shWrapper(agent))

// The block placed in CLAUDE.md / AGENTS.md. policyPath/briefsPath are shown as given.
export const policyBlock = ({ policyPath, briefsPath, short = false, agentsPointer = false, importAgents = false }) => {
  if (short) {
    return [
      '## Orca stack integration',
      '',
      ...(importAgents ? ['@AGENTS.md', ''] : []),
      `The stack policy is \`${policyPath}\`; the orca-stack block in \`AGENTS.md\` summarises it.`,
    ].join('\n')
  }

  return [
    '## Orca stack integration',
    '',
    `Canonical policy: \`${policyPath}\` (override with \`$ORCA_STACK_POLICY_PATH\`). Role briefs: \`${briefsPath}\`.`,
    'If the file is missing, run `npx github:Gagaismo/orca-stack global`.',
    '',
    '- Orca runtime/active Dispatch owns lifecycle, delegation, worker ownership, settlement, and cleanup; workers execute their brief and never start a competing workflow or wait for the human.',
    '- Matt Pocock skills remain the only engineering methodology; use Ponytail automatically for implementation work at the configured level, but never against explicit requirements.',
    '- Preserve explicit spec/ticket/ADR requirements, validation, security, accessibility, error handling, data-loss protection, and required tests.',
    '- Caveman follows the stack Auto/Off setting and compresses token-heavy prose only. Preserve code, commands, paths, exact errors, decisions, risks, uncertainty, tests, and acceptance evidence.',
    '- Engram is memory only, not a planner or scheduler. Read the canonical policy for role-specific rules.',
    ...(agentsPointer
      ? [
          '- Claude Code mod rules for this project live in `.orca-stack.json` (committed) and `.orca-stack.local.json` (local, gitignored); personal ones in `~/.orca-stack/config.json`.',
        ]
      : []),
  ].join('\n')
}
