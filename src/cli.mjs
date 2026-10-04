import { doctorCommand } from './doctor.mjs'
import { globalCommand } from './global.mjs'
import { initCommand } from './init.mjs'
import { removeCommand } from './remove.mjs'
import { packageVersion } from './util.mjs'

const USAGE = `orca-stack ${packageVersion()}: instala el stack de agentes (política de Orca, skills, wrappers, Pi + Gentle Shell y mods de Claude Code).

Uso:
  orca-stack <comando> [opciones]
  npx github:Gagaismo/orca-stack#v${packageVersion()} <comando> [opciones]

Comandos:
  global    Instalación a nivel usuario (idempotente). Hace respaldo de todo lo que modifica.
  init      Cablea el proyecto actual (git): AGENTS.md, CLAUDE.md y los archivos .orca-stack*.json.
  doctor    Verifica la instalación con sondeos reales y sale con código 1 si hay fallas.
  remove    Deshace lo que instaló \`global\`, según ~/.orca-stack/state.json.

Opciones:
  --dry-run        (global, init, remove) Muestra cada acción sin escribir nada.
  --skip-pi        (global, doctor) No toca ni verifica Pi, gentle-pi ni pi-claude-bridge.
  --offline        (doctor) Sin sondeos de red: omite el login de Pi y \`gh auth status\`.
  --humano <nombre> (global) Nombre que usan los mods para hablarte (por defecto: git config user.name).
  --with-pi        (remove) También desinstala los paquetes de Pi y gentle-pi global que instaló \`global\`.
  -v, --version    Muestra la versión.
  -h, --help       Muestra esta ayuda (también \`orca-stack <comando> --help\`).

Variables de entorno:
  ORCA_STACK_HOME  Instala en otra carpeta personal en lugar de la tuya (útil para probar).
`

const COMMAND_HELP = {
  global: `orca-stack global [--dry-run] [--skip-pi] [--humano <nombre>]

Instala a nivel usuario:
  1. ~/orca/stack/ORCA-STACK.md y ROLE-BRIEFS.md
  2. Wrappers claude/codex/agy-orca-stack (.cmd en Windows, .sh en el resto) en ~/orca/stack/scripts
  3. Skills propias en ~/.claude/skills y ~/.agents/skills
  4. Mods en ~/.claude/mods y sus rutas en env.CLAUDE_CODE_PLUGIN_DIRS de ~/.claude/settings.json
  5. Bloque <!-- orca-stack:begin --> en ~/.claude/CLAUDE.md
  6. Pi: gentle-pi y pi-claude-bridge con \`pi install\` + gentle-pi global (omitido con --skip-pi)
  7. ~/.orca-stack/state.json (para \`remove\`) y ~/.orca-stack/config.json (capa personal)

Es idempotente: una segunda corrida no cambia nada ni genera respaldos nuevos.
`,
  init: `orca-stack init [--dry-run]

Dentro de un repo git: agrega un bloque <!-- orca-stack:begin --> a AGENTS.md y CLAUDE.md (los crea si faltan),
crea .orca-stack.json (reglas del proyecto, se commitea) y .orca-stack.local.json (local, ignorado) y
agrega .orca-stack.local.json a .gitignore. No pisa archivos de config que ya existan.
`,
  doctor: `orca-stack doctor [--offline] [--skip-pi]

Verifica de verdad, sin mirar solo si los archivos existen: corre el autodiagnóstico de cada wrapper, compara
las versiones de Pi y sus paquetes con las fijadas, sondea el login de Pi, comprueba que cada mod esté en
CLAUDE_CODE_PLUGIN_DIRS y lee (solo lectura) la configuración de Orca para ver si los agentes apuntan a los wrappers.
Sale con código 1 si hay alguna falla (✖). Los avisos (⚠) no cambian el código de salida.
`,
  remove: `orca-stack remove [--dry-run] [--with-pi]

Borra los archivos que instaló \`global\`, restaura los que había reemplazado, quita sus entradas de
CLAUDE_CODE_PLUGIN_DIRS y su bloque de ~/.claude/CLAUDE.md. Los respaldos *.bak-orca-stack-* se conservan.
`,
}

export const parseArgs = argv => {
  const flags = { dryRun: false, skipPi: false, offline: false, withPi: false, humano: undefined, help: false, version: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--skip-pi') flags.skipPi = true
    else if (arg === '--offline') flags.offline = true
    else if (arg === '--with-pi') flags.withPi = true
    else if (arg === '-h' || arg === '--help') flags.help = true
    else if (arg === '-v' || arg === '--version') flags.version = true
    else if (arg === '--humano') {
      flags.humano = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--humano=')) flags.humano = arg.slice('--humano='.length)
    else if (arg.startsWith('-')) throw new Error(`Opción desconocida: ${arg}`)
    else rest.push(arg)
  }
  if (flags.humano !== undefined && (flags.humano === '' || flags.humano.startsWith('--'))) {
    throw new Error('--humano necesita un nombre.')
  }

  return { command: rest[0], flags, rest }
}

export const main = async argv => {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    console.error(`${error.message}\n\nUsá --help para ver las opciones.`)

    return 2
  }
  const { command, flags } = parsed
  if (flags.version) {
    console.log(packageVersion())

    return 0
  }
  if (!command || command === 'help') {
    console.log(USAGE)

    return command || flags.help ? 0 : 2
  }
  if (flags.help) {
    console.log(COMMAND_HELP[command] ?? USAGE)

    return 0
  }
  try {
    switch (command) {
      case 'global':
        return await globalCommand(flags)
      case 'init':
        return await initCommand(flags)
      case 'doctor':
        return await doctorCommand(flags)
      case 'remove':
        return await removeCommand(flags)
      default:
        console.error(`Comando desconocido: ${command}\n\n${USAGE}`)

        return 2
    }
  } catch (error) {
    console.error(`✖ ${error.message}`)

    return 1
  }
}
