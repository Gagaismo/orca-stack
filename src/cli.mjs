import { despacharCommand, revisarCommand } from './despacho.mjs'
import { doctorCommand } from './doctor.mjs'
import { globalCommand } from './global.mjs'
import { initCommand } from './init.mjs'
import { removeCommand } from './remove.mjs'
import { sesionesCommand } from './sesiones.mjs'
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
  despachar Despacha un ticket a un agente: worktree en Orca, brief y lanzamiento (desde el checkout principal).
  revisar   Despacha el review de un PR a un agente que no sea su autor.
  sesiones  Lista las sesiones recientes de Claude, Pi y agy (entrada de \`/retro\`).

Opciones:
  --dry-run        (global, init, remove, despachar, revisar) Muestra cada acción sin escribir nada.
  --force          (global) Reemplaza archivos existentes que no son de orca-stack (con respaldo en ~/.orca-stack/backups).
  --skip-pi        (global, doctor) No toca ni verifica Pi, gentle-pi ni pi-claude-bridge.
  --offline        (doctor) Sin sondeos de red: omite el login de Pi y \`gh auth status\`.
  --nota <texto>   (despachar, revisar) Texto que se agrega al brief.
  --confirmado     (despachar, revisar) El humano dijo que sí a un agente de agentes.preguntarAntes.
  --desde <AAAA-MM-DD>  (sesiones) Desde qué día (por defecto: los últimos 2 días).
  --limite <n>     (sesiones) Cuántas sesiones mostrar (por defecto: 10).
  --humano <nombre> (global) Nombre que usan los mods para hablarte (por defecto: git config user.name).
  --with-pi        (remove) También desinstala los paquetes de Pi y gentle-pi global que instaló \`global\`.
  -v, --version    Muestra la versión.
  -h, --help       Muestra esta ayuda (también \`orca-stack <comando> --help\`).

Variables de entorno:
  ORCA_STACK_HOME  Instala en otra carpeta personal en lugar de la tuya (útil para probar).
`

const COMMAND_HELP = {
  global: `orca-stack global [--dry-run] [--force] [--skip-pi] [--humano <nombre>]

Instala a nivel usuario:
  1. ~/orca/stack/ORCA-STACK.md y ROLE-BRIEFS.md
  2. Wrappers claude/codex/agy-orca-stack (.cmd en Windows, .sh en el resto) en ~/orca/stack/scripts
  3. Skills propias en ~/.claude/skills y ~/.agents/skills
  4. Mods en ~/.claude/mods y sus rutas en env.CLAUDE_CODE_PLUGIN_DIRS de ~/.claude/settings.json
  5. Nada de metodología en ~/.claude/CLAUDE.md (llega por el proyecto, con \`init\`); saca el bloque
     <!-- orca-stack:begin --> que haya dejado una versión anterior, con respaldo.
     Con el RDD de gentle-ai apagado, saca de ese archivo sus secciones de review (\`gentle-ai sync\` las restaura: volvé a correr \`global\`)
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
  sesiones: `orca-stack sesiones [--desde <AAAA-MM-DD>] [--limite <n>]

Lista, de solo lectura, las sesiones recientes de agentes en esta máquina: transcripciones de Claude Code
(~/.claude/projects y, si está, la carpeta de agentes.pi.claudeConfigDir), sesiones de Pi (~/.pi/agent/sessions) y
conversaciones de agy (~/.gemini/antigravity-cli; necesita Node 22.13 o más nuevo). De cada una muestra herramienta,
carpeta, inicio y fin, llamadas, tus mensajes, las llamadas con error y los resultados de más de 15k caracteres.
Sirve de entrada para \`/retro\`.
`,
  despachar: `orca-stack despachar <issue> <agente> [--nota "<texto>"] [--confirmado] [--dry-run]

Desde el checkout principal del repo (agentes: claude, agy, codex, codex-cc, pi). Se niega si el setup está pendiente, si el
agente no está en agentes.usa, si está en agentes.preguntarAntes sin --confirmado, si el issue está cerrado o asignado, o si ya hay
un worktree o un agente vivo para ese ticket. Asigna el issue, crea el worktree con \`orca worktree create\`, escribe el brief en
~/orca/briefs, comprueba que cada ruta que cita exista en el worktree, lanza el agente en una terminal de Orca y le manda el brief.
Con --dry-run muestra el plan y el brief y no escribe nada.
`,
  revisar: `orca-stack revisar <pr> <agente> [--nota "<texto>"] [--confirmado] [--dry-run]

Igual que despachar, para un review: worktree revision-<pr>-<agente> parado en la rama del PR. Se niega si el agente es el implementador del PR
(línea \`Implementador:\`) o si codex y codex-cc se revisan entre sí.
`,
  remove: `orca-stack remove [--dry-run] [--with-pi]

Borra los archivos que instaló \`global\`, restaura los que había reemplazado, quita sus entradas de
CLAUDE_CODE_PLUGIN_DIRS y, si quedó, su bloque de ~/.claude/CLAUDE.md. Los respaldos de ~/.orca-stack/backups se conservan.
`,
}

export const parseArgs = argv => {
  const flags = { nota: undefined, confirmado: false, dryRun: false, force: false, skipPi: false, offline: false, withPi: false, humano: undefined, desde: undefined, limite: undefined, help: false, version: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--confirmado') flags.confirmado = true
    else if (arg === '--nota') {
      flags.nota = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--nota=')) flags.nota = arg.slice('--nota='.length)
    else if (arg === '--force') flags.force = true
    else if (arg === '--skip-pi') flags.skipPi = true
    else if (arg === '--offline') flags.offline = true
    else if (arg === '--with-pi') flags.withPi = true
    else if (arg === '-h' || arg === '--help') flags.help = true
    else if (arg === '-v' || arg === '--version') flags.version = true
    else if (arg === '--humano') {
      flags.humano = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--humano=')) flags.humano = arg.slice('--humano='.length)
    else if (arg === '--desde' || arg === '--limite') {
      flags[arg.slice(2)] = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--desde=') || arg.startsWith('--limite=')) {
      flags[arg.slice(2, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1)
    }
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
  const { command, flags, rest } = parsed
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
      case 'sesiones':
        return await sesionesCommand(flags)
      case 'despachar':
        return await despacharCommand(flags, rest[1], rest[2])
      case 'revisar':
        return await revisarCommand(flags, rest[1], rest[2])
      default:
        console.error(`Comando desconocido: ${command}\n\n${USAGE}`)

        return 2
    }
  } catch (error) {
    console.error(`✖ ${error.message}`)

    return 1
  }
}
