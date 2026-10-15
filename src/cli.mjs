import { avisarCommand } from './avisar.mjs'
import { consultasCommand } from './consultas.mjs'
import { briefRevisionCommand, despacharCommand, reboteCommand, revisarCommand } from './despacho.mjs'
import { doctorCommand } from './doctor.mjs'
import { globalCommand } from './global.mjs'
import { initCommand } from './init.mjs'
import { removeCommand } from './remove.mjs'
import { sesionesCommand } from './sesiones.mjs'
import { vigilarCommand } from './vigilar.mjs'
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
  rebote   Relanza al autor de un PR bloqueado o con CI roja en su worktree existente.
  revisar   Despacha el review de un PR a un agente que no sea su autor.
  brief-revision  Prepara un worktree y brief de review para un subagente en modo un-agente.
  sesiones  Lista las sesiones recientes de Claude, Pi y agy (entrada de \`/retro\`).
  consultas Filtra y avisa comentarios Consulta: nuevos en issues y PRs en curso.
  avisar    Le toca el timbre a un worker con el turno en curso: una línea con la URL de la respuesta de main.
  vigilar   Vigila los PRs de una tanda para el Monitor: solo emite eventos, retoma donde quedó e ignora los merges de main.

Opciones:
  --dry-run        (global, init, remove, despachar, revisar, rebote, brief-revision, consultas, avisar, vigilar) Muestra cada acci\u00F3n sin escribir nada.
  --force          (global) Reemplaza archivos existentes que no son de orca-stack (con respaldo en ~/.orca-stack/backups).
  --skip-pi        (global, doctor) No toca ni verifica Pi, gentle-pi ni pi-claude-bridge.
  --offline        (doctor) Sin sondeos de red: omite el login de Pi y \`gh auth status\`.
  --nota <texto>   (despachar, revisar, rebote) Texto que se agrega al brief.
  --confirmado     (despachar, revisar, rebote) El humano dijo que s\u00ED a un agente de agentes.preguntarAntes.
  --perfil-pi <nombre> (despachar, revisar, rebote) Perfil de modelos de gentle-pi para el worktree de un despacho a pi (ver --help del comando).
  --modelo <modelo>  (brief-revision) Modelo del subagente revisor.
  --desde <AAAA-MM-DD>  (sesiones) Desde qué día (por defecto: los últimos 2 días).
  --limite <n>     (sesiones) Cuántas sesiones mostrar (por defecto: 10).
  --humano <nombre> (global) Nombre que usan los mods para hablarte (por defecto: git config user.name).
  --with-pi        (remove) También desinstala los paquetes de Pi y gentle-pi global que instaló \`global\`.
  --limpiar-sdd    (global) Respaldar y mover solo los restos SDD conocidos a ~/.orca-stack/backups.
  --cada <segundos> (vigilar) Cada cuánto consulta GitHub (por defecto: 60).
  --una-vez        (vigilar) Consulta una sola vez y sale.
  --consultas      (vigilar) En cada vuelta corre también el chequeo de \`consultas\` para los mismos items.
  --merge-de-main <pr> (vigilar) Registra que main está por mergear <pr> y sale, sin imprimir nada.
  -v, --version    Muestra la versión.
  -h, --help       Muestra esta ayuda (también \`orca-stack <comando> --help\`).

Variables de entorno:
  ORCA_STACK_HOME  Instala en otra carpeta personal en lugar de la tuya (útil para probar).
`

const COMMAND_HELP = {
  global: `orca-stack global [--dry-run] [--force] [--skip-pi] [--limpiar-sdd] [--humano <nombre>]

Instala a nivel usuario:
  1. ~/orca/stack/ORCA-STACK.md y ROLE-BRIEFS.md
  2. Wrappers claude/codex/agy-orca-stack (.cmd en Windows, .sh en el resto) en ~/orca/stack/scripts
  3. Skills propias en ~/.claude/skills y ~/.agents/skills
  4. Mods en ~/.claude/mods y sus rutas en env.CLAUDE_CODE_PLUGIN_DIRS de ~/.claude/settings.json
  5. Nada de metodología en ~/.claude/CLAUDE.md (llega por el proyecto, con \`init\`); saca el bloque
     <!-- orca-stack:begin --> que haya dejado una versión anterior, con respaldo.
     Con el RDD de gentle-ai apagado, saca de ese archivo sus secciones de review (\`gentle-ai sync\` las restaura: volvé a correr \`global\`)
  6. Pi: gentle-pi y pi-claude-bridge con \`pi install\` + gentle-pi global (omitido con --skip-pi). Con un Pi anterior
     a 1.2.0 no instala gentle-pi y falla: gentle-pi 4.2.0 no arranca con él
  7. ~/.orca-stack/state.json (para \`remove\`) y ~/.orca-stack/config.json (capa personal)

Es idempotente: una segunda corrida no cambia nada ni genera respaldos nuevos.
--limpiar-sdd respalda y mueve solo restos SDD conocidos a ~/.orca-stack/backups; sin la opci\u00f3n no mueve ninguno.
`,
  init: `orca-stack init [--dry-run]

Dentro de un repo git: agrega un bloque <!-- orca-stack:begin --> a AGENTS.md y CLAUDE.md (los crea si faltan),
crea .orca-stack.json (reglas del proyecto, se commitea) y .orca-stack.local.json (local, ignorado) y
agrega .orca-stack.local.json a .gitignore. No pisa archivos de config que ya existan.
`,
  doctor: `orca-stack doctor [--offline] [--skip-pi]

Verifica de verdad, sin mirar solo si los archivos existen: corre el autodiagnóstico de cada wrapper, compara
las versiones de Pi y sus paquetes con las fijadas (un Pi anterior a 1.2.0 es una falla), sondea el login de Pi,
avisa si engram es anterior a 3.4.0, comprueba que cada mod esté en CLAUDE_CODE_PLUGIN_DIRS y lee (solo lectura) la configuración de Orca para ver si los agentes apuntan a los wrappers.
Sale con código 1 si hay alguna falla (✖). Los avisos (⚠) no cambian el código de salida.
`,
  sesiones: `orca-stack sesiones [--desde <AAAA-MM-DD>] [--limite <n>]

Lista, de solo lectura, las sesiones recientes de agentes en esta máquina: transcripciones de Claude Code
(~/.claude/projects y, si está, la carpeta de agentes.pi.claudeConfigDir), sesiones de Pi (~/.pi/agent/sessions) y
conversaciones de agy (~/.gemini/antigravity-cli; necesita Node 22.13 o más nuevo). De cada una muestra herramienta,
carpeta, inicio y fin, llamadas, tus mensajes, las llamadas con error y los resultados de más de 15k caracteres.
Sirve de entrada para \`/retro\`.
`,
  despachar: `orca-stack despachar <issue> <agente> [--nota "<texto>"] [--confirmado] [--perfil-pi <nombre>] [--dry-run]

Desde el checkout principal del repo (agentes: claude, agy, codex, codex-cc, pi). Se niega si el setup está pendiente, si el
agente no está en agentes.usa, si está en agentes.preguntarAntes sin --confirmado, si el issue está cerrado o asignado, o si ya hay
un worktree o un agente vivo para ese ticket. Asigna el issue, crea el worktree con \`orca worktree create\`, escribe el brief en
~/orca/briefs, comprueba que cada ruta que cita exista en el worktree, lanza el agente en una terminal de Orca y le manda el brief.
Con --dry-run muestra el plan y el brief y no escribe nada.

Con pi, --perfil-pi <nombre> (o agentes.pi.perfil en la config; el flag gana) fija para ese worktree uno de los perfiles de
~/.pi/gentle-ai/profiles.json: escribe .pi/gentle-ai/profile.json en el worktree (fuera de git, vía info/exclude) y lanza pi con el
modelo del orquestador del perfil. Se niega si el perfil no existe o si el clon ya fija otro (<git-common-dir>/gentle-ai/profile-pin.json).
Sin flag y sin agentes.pi.perfil, o con "preguntar", rige el perfil activo global.
`,
  revisar: `orca-stack revisar <pr> <agente> [--nota "<texto>"] [--confirmado] [--perfil-pi <nombre>] [--dry-run]

Igual que despachar, para un review: worktree revision-<pr>-<agente> parado en la rama del PR. Se niega si el agente es el implementador del PR
(línea \`Implementador:\`) o si codex y codex-cc se revisan entre sí.
`,
  rebote: `orca-stack rebote <pr> [--nota "<texto>"] [--confirmado] [--perfil-pi <nombre>] [--dry-run]

Relanza al autor indicado por \`Implementador:\` en el worktree existente de la rama del PR. Exige un review bloqueante
vigente o checks fallidos sobre el head, worktree limpio y detenido en ese commit; los hallazgos de interpretaci\u00F3n solo bloquean el rebote por review.
Para CI roja agrega los checks fallidos al brief y publica \`Rebote CI: <sha>\`; publica \`Rebote: <sha>\` solo con bloqueos de review.
`,
  'brief-revision': `orca-stack brief-revision <pr> --modelo <modelo> [--dry-run]

Solo desde el checkout principal, con setup completo y en modo "un-agente". Crea un worktree detached en el head del PR y escribe en UTF-8 el brief de review compartido con \`revisar\`. El subagente escribe el cuerpo del review en un archivo; main lo publica.
Con --dry-run muestra las acciones y las rutas, sin crear worktree ni brief.
`,
  consultas: `orca-stack consultas <n...> [--dry-run]

Para los issues y PRs en curso indicados, busca comentarios nuevos que comiencen con "Consulta:" hechos por la cuenta de GitHub del stack (leída con \`gh api user\`).
Emite una sola línea "consulta nueva en #<n>" por cada comentario nuevo y recuerda lo reportado en .git/orca-stack/consultas-reportadas.json para ser idempotente.
`,
  avisar: `orca-stack avisar <issue|pr> <url-del-comentario> [--dry-run]

El timbre de Proactive: cuando main responde la pregunta de un worker, le escribe en su terminal una sola línea fija
("Message from main: <url>") con la URL del comentario y nada de su texto, para que la lea sin esperar a su PR.
Encuentra la terminal por el worktree de este repo enlazado a <n> (con un PR, el de su rama), buscado solo entre los de
\`git worktree list\` porque los selectores de Orca abarcan todos los repos, y, si un rebote dejó dos, elige la del agente vivo. Manda solo mientras el turno del worker está en curso: se niega si ya terminó, si la
terminal muestra un shell o un diálogo, o si hay más de un agente vivo. Por ahora solo avisa a claude: se niega con pi, que
corre sin TUI y relee los comentarios antes de su PR, y con codex y agy hasta que pasen su prueba de Enter a mitad de turno.
Se niega si el comentario no es de la cuenta del stack (\`gh api user\`), no está en <issue|pr> o no empieza con
\`Respuesta de main:\` o \`Respuesta del humano:\`. Envía con \`--wait-submit\` y nunca reintenta: sin recibo de entrega
informa la falla y no reenvía.
Con --dry-run muestra la línea y la terminal elegida, sin enviar nada.
`,
  vigilar: `orca-stack vigilar <n...> [--cada <segundos>] [--una-vez] [--dry-run] [--consultas]
orca-stack vigilar --merge-de-main <pr>

Vigila los PRs de los issues <n...> de una tanda, hecho para correr bajo el Monitor: stdout lleva solo eventos, uno
por línea, y todo diagnóstico va a stderr. Cada --cada segundos (por defecto 60) lee \`gh pr list --state all\` y emite:
  pr-abierto #<n> PR #<pr> <sha>     un PR del issue, visto por primera vez
  ci-verde #<n> PR #<pr> <sha>       todos los checks del head terminaron en verde
  ci-roja #<n> PR #<pr> <sha>: ...   un check terminado falló, venció o se canceló (los lista)
  pr-mergeado #<n> PR #<pr> <sha>    el PR se mergeó y main no registró ese merge
  pr-cerrado #<n> PR #<pr>           el PR se cerró sin mergear
  vigilar-ciego: <error>             tres vueltas seguidas sin poder leer GitHub (una vez por corte)
  tanda-cerrada #<n> #<m>...         terminaron todos los items; sale con 0
Un PR es del issue por su referencia de cierre, por la rama del worktree de este repo enlazado al issue o por una línea
\`Closes #<n>\` en su cuerpo; nunca por adivinar el nombre de la rama. Un issue cerrado sin PR cuenta como terminado.
Guarda lo emitido en <git-common-dir>/orca-stack/vigilar.json: rearmado con los mismos argumentos, retoma sin repetir.
--una-vez consulta una vez y sale; --dry-run consulta una vez y no escribe nada; --consultas corre en cada vuelta el
chequeo de \`orca-stack consultas\` para los mismos items (un solo Monitor en Proactive).

--merge-de-main <pr> registra el head del PR en <git-common-dir>/orca-stack/vigilar-merges.json y sale sin imprimir
nada en stdout. main lo corre justo antes de cada intento de \`gh pr merge <pr>\`, también después de
\`gh pr update-branch\`: un merge de ese head visto dentro de los 30 minutos no emite pr-mergeado.
`,
  remove: `orca-stack remove [--dry-run] [--with-pi]

Borra los archivos que instaló \`global\`, restaura los que había reemplazado, quita sus entradas de
CLAUDE_CODE_PLUGIN_DIRS y, si quedó, su bloque de ~/.claude/CLAUDE.md. Los respaldos de ~/.orca-stack/backups se conservan.
`,
}

export const parseArgs = argv => {
  const flags = { nota: undefined, perfilPi: undefined, modelo: undefined, confirmado: false, dryRun: false, force: false, skipPi: false, offline: false, withPi: false, humano: undefined, desde: undefined, limite: undefined, help: false, version: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--confirmado') flags.confirmado = true
    else if (arg === '--nota') {
      flags.nota = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--nota=')) flags.nota = arg.slice('--nota='.length)
    else if (arg === '--perfil-pi') {
      flags.perfilPi = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--perfil-pi=')) flags.perfilPi = arg.slice('--perfil-pi='.length)
    else if (arg === '--modelo') {
      flags.modelo = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--modelo=')) flags.modelo = arg.slice('--modelo='.length)
    else if (arg === '--force') flags.force = true
    else if (arg === '--skip-pi') flags.skipPi = true
    else if (arg === '--offline') flags.offline = true
    else if (arg === '--with-pi') flags.withPi = true
    else if (arg === '--una-vez') flags.unaVez = true
    else if (arg === '--consultas') flags.consultas = true
    else if (arg === '--cada' || arg === '--merge-de-main') {
      flags[arg === '--cada' ? 'cada' : 'mergeDeMain'] = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--cada=')) flags.cada = arg.slice('--cada='.length)
    else if (arg.startsWith('--merge-de-main=')) flags.mergeDeMain = arg.slice('--merge-de-main='.length)
    else if (arg === '--limpiar-sdd') flags.limpiarSdd = true
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
  if (flags.perfilPi !== undefined && (flags.perfilPi === '' || flags.perfilPi.startsWith('--'))) {
    throw new Error('--perfil-pi necesita el nombre de un perfil de gentle-pi.')
  }
  if (flags.modelo !== undefined && (flags.modelo.trim() === '' || flags.modelo.startsWith('--'))) {
    throw new Error('--modelo necesita el nombre del modelo del subagente.')
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
      case 'rebote':
        return await reboteCommand(flags, rest[1])
      case 'brief-revision':
        return await briefRevisionCommand({ ...flags, n: rest[1] })
      case 'consultas':
        return await consultasCommand(flags, rest.slice(1))
      case 'avisar':
        return await avisarCommand(flags, rest[1], rest[2])
      case 'vigilar':
        return await vigilarCommand(flags, rest.slice(1))
      default:
        console.error(`Comando desconocido: ${command}\n\n${USAGE}`)

        return 2
    }
  } catch (error) {
    console.error(`✖ ${error.message}`)

    return 1
  }
}
