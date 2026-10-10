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

// The policy lines of the project blocks. policyPath/briefsPath are shown as given.
const policyLines = ({ policyPath, briefsPath }) => [
  `Política canónica: \`${policyPath}\` (se puede cambiar con \`$ORCA_STACK_POLICY_PATH\`). Briefs por rol: \`${briefsPath}\`.`,
  'Si faltan, corré `npx github:Gagaismo/orca-stack global`.',
  '',
  '- El runtime de Orca y el Dispatch activo manejan el ciclo de vida, la delegación, los workers, el cierre y la limpieza. Un worker ejecuta su brief: no arranca otro flujo de trabajo ni espera al humano.',
  '- Planificación con las skills de Matt Pocock (grilling, to-spec, to-tickets, disparadas por el humano), e implementación con gentle-ai ODD en todo el stack. Gentle Shell (Pi) trabaja con la suya y puede usar ODD. Ponytail se aplica en el trabajo de implementación con el nivel configurado, pero nunca contra un requisito explícito.',
  '- Respetá los requisitos explícitos de la spec, el ticket y los ADRs, y también la validación, la seguridad, la accesibilidad, el manejo de errores, la protección contra pérdida de datos y los tests que se piden: son lo que el humano espera recibir.',
  '- Caveman sigue el ajuste Auto/Off del stack y comprime solo prosa pesada en tokens. Conservá el código, los comandos, las rutas, los errores exactos, las decisiones, los riesgos, las dudas, los tests y la evidencia de aceptación.',
  '- Engram es solo memoria: no es autoridad ni planificador. Para las reglas de cada rol, leé la política canónica.',
  '- Las reglas de los mods de Claude Code para este proyecto están en `.orca-stack.json` (se commitea) y `.orca-stack.local.json` (local, ignorado por git); las personales, en `~/.orca-stack/config.json`.',
]

// The project blocks: the short CLAUDE.md one, or the AGENTS.md one that carries the work contract.
export const policyBlock = ({ policyPath, briefsPath, short = false, importAgents = false }) => {
  if (short) {
    return [
      '## Orca stack integration',
      '',
      ...(importAgents ? ['@AGENTS.md', ''] : []),
      `The stack policy is \`${policyPath}\`; the orca-stack block in \`AGENTS.md\` summarises it.`,
    ].join('\n')
  }
  const lines = policyLines({ policyPath, briefsPath })

  return [readAsset('stack', 'CONTRATO.md').replace(/\s+$/, ''), '', '### Política del stack', '', ...lines].join('\n')
}
