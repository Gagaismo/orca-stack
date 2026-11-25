import { avisarCommand } from './avisar.mjs'
import { PINNED, PI_MIN_VERSION } from './constants.mjs'
import { briefRevisionCommand, despacharCommand, reboteCommand, revisarCommand } from './despacho.mjs'
import { doctorCommand } from './doctor.mjs'
import { estadoCommand } from './estado.mjs'
import { globalCommand } from './global.mjs'
import { initCommand } from './init.mjs'
import { limpiarCommand } from './limpiar.mjs'
import { lintCommand } from './lint.mjs'
import { novedadesCommand } from './novedades.mjs'
import { removeCommand } from './remove.mjs'
import { reanudarCommand } from './reanudar.mjs'
import { sesionesCommand } from './sesiones.mjs'
import { vigilarCommand } from './vigilar.mjs'
import { packageVersion } from './util.mjs'
import { planificarCommand } from './planificar.mjs'

const USAGE = `orca-stack ${packageVersion()}: instala el stack de agentes (política de Orca, skills, wrappers, Pi + Gentle Shell y mods de Claude Code).

Uso:
  orca-stack <comando> [opciones]
  npx github:Gagaismo/orca-stack#v${packageVersion()} <comando> [opciones]

Comandos:
  global    Instalación a nivel usuario (idempotente). Hace respaldo de todo lo que modifica.
  init      Cablea el proyecto actual (git): AGENTS.md, CLAUDE.md, los archivos .orca-stack*.json y el lint (CI, hook, Baseline y CODING_STANDARDS.md).
  doctor    Verifica la instalación con sondeos reales y sale con código 1 si hay fallas.
  remove    Deshace lo que instaló \`global\`, según ~/.orca-stack/state.json.
  despachar Despacha un ticket a un agente: worktree en Orca, brief y lanzamiento (desde el checkout principal).
  rebote   Relanza al autor de un PR bloqueado o con CI roja, o en conflicto con la base, en su worktree existente.
  revisar   Despacha el review de un PR a un agente que no sea su autor.
  brief-revision  Prepara un worktree y brief de review para un subagente en modo un-agente.
  sesiones  Lista las sesiones recientes de Claude, Pi y agy (entrada de \`/retro\`).
  avisar    Le toca el timbre a un worker con el turno en curso: una línea con la URL de la respuesta de main.
  reanudar  Reanuda un worker detenido con una respuesta de main o relanza su trabajo en el mismo worktree.
  vigilar   Vigila los PRs de una tanda para el Monitor: solo emite eventos, retoma donde quedó e ignora los merges de main.
  planificar Abre la sesión de planificación de un issue paraguas: worktree de Orca en docs/<slug> y pi con el brief de planificación.
  estado    Muestra, de solo lectura, qué le falta a cada PR para el paso 7 de MAIN.md sobre su head (con --json, la atestación).
  limpiar   Cierra las terminales y saca los worktrees cuyo PR se mergeó o se cerró (omite los sucios y los que tienen un agente trabajando).
  novedades Precheck de una automatización de Orca que sondea GitHub: sale con 1 (Orca saltea la corrida) si no hay nada nuevo.
  lint      Revisa el repo (long-file: archivos de más de 2000 líneas; wide-directory: directorios de más de 15 entradas; y en JS/TS, Go, Python y Shell: comentarios, module-cycle y diseño: tangle, field-leak y shallow-module) contra su Baseline y sale con 1 si hay violaciones nuevas o entradas vencidas.

Opciones:
  --dry-run        (global, init, remove, despachar, revisar, rebote, brief-revision, avisar, reanudar, vigilar, planificar, limpiar) Muestra cada acci\u00F3n sin escribir nada.
  --force          (global) Reemplaza archivos existentes que no son de orca-stack (con respaldo en ~/.orca-stack/backups).
  --skip-pi        (global, doctor) No toca ni verifica Pi, gentle-pi ni pi-claude-bridge.
  --offline        (doctor) Sin sondeos de red: omite el login de Pi y \`gh auth status\`.
  --nota <texto>   (despachar, revisar, rebote) Texto que se agrega al brief.
  --confirmado     (despachar, revisar, rebote, reanudar) El humano dijo que s\u00ED a un agente de agentes.preguntarAntes.
  --continuar      (rebote) Retoma al autor de un rebote que se cortó antes de pushear (por ejemplo, sin cuota): mismo worktree, misma sesión de pi, sin marcador nuevo.
  --rdd <lentes>   (rebote) Le pide a pi un review RDD de su propio PR con esas lentes (risk, resilience, readability, reliability), sin hallazgos ni marcador Rebote.
  --perfil-pi <nombre> (despachar, revisar, rebote, reanudar, planificar) Perfil de modelos de gentle-pi para el worktree de un despacho a pi (ver --help del comando).
  --modelo <modelo>  (brief-revision) Modelo del subagente revisor.
  --desde <AAAA-MM-DD>  (sesiones) Desde qué día (por defecto: los últimos 2 días).
  --limite <n>     (sesiones) Cuántas sesiones mostrar (por defecto: 10).
  --humano <nombre> (global) Nombre que usan los mods para hablarte (por defecto: git config user.name).
  --with-pi        (remove) También desinstala los paquetes de Pi y gentle-pi global que instaló \`global\`.
  --limpiar-sdd    (global) Respaldar y mover solo los restos SDD conocidos a ~/.orca-stack/backups.
  --cada <segundos> (vigilar) Cada cuánto consulta GitHub (por defecto: 60).
  --una-vez        (vigilar) Consulta una sola vez y sale.
  --merge-de-main <pr> (vigilar) Registra que main está por mergear <pr> y sale, sin imprimir nada.
  --paraguas <n>   (vigilar) Vigila los sub-issues del issue paraguas <n>: un evento por cada tanda nueva de tickets publicada.
  --json           (estado) Imprime un objeto JSON por PR (un arreglo si son varios) y sale con 0 solo si están listos.
  --terminal <handle> (reanudar) Reanuda el agente de esa terminal de Orca cuando el worktree tiene varios en done.
  --rutas <a,b>    (revisar) El review lee solo esas rutas y lo declara en ## Cobertura.
  --activar-hook   (init) Apunta core.hooksPath a .githooks sin preguntar, salvo que ya apunte a otro lado.
  --sembrar        (lint) Agrega a la Baseline cada violación actual que no tenga entrada (se usa una vez, al prender el lint).
  -v, --version    Muestra la versión.
  -h, --help       Muestra esta ayuda (también \`orca-stack <comando> --help\`).

Variables de entorno:
  ORCA_STACK_HOME  Instala en otra carpeta personal en lugar de la tuya (útil para probar).
`

const COMMAND_HELP = {
  global: `orca-stack global [--dry-run] [--force] [--skip-pi] [--limpiar-sdd] [--humano <nombre>]

Instala a nivel usuario:
  1. ~/orca/stack/ORCA-STACK.md, ROLE-BRIEFS.md y MAIN.md (las reglas de main), y MARCHAS.md y CAVEMAN.md (los fragmentos de los perks)
  2. Wrappers claude/codex/agy-orca-stack (.cmd en Windows, .sh en el resto) en ~/orca/stack/scripts
  3. Skills propias en ~/.claude/skills y ~/.agents/skills
  4. Mods en ~/.claude/mods y sus rutas en env.CLAUDE_CODE_PLUGIN_DIRS de ~/.claude/settings.json
  5. Nada de metodología en ~/.claude/CLAUDE.md (llega por el proyecto, con \`init\`); saca el bloque
     <!-- orca-stack:begin --> que haya dejado una versión anterior, con respaldo.
     Con el RDD de gentle-ai apagado, saca de ese archivo sus secciones de review (\`gentle-ai sync\` las restaura: volvé a correr \`global\`)
     Si ~/AGENTS.md tiene un bloque orca-stack, lo cambia por un puntero corto a la política (con respaldo)
  6. Pi: gentle-pi, pi-claude-bridge y gentle-engram con \`pi install\` + gentle-pi global (omitido con --skip-pi). Con un
     Pi anterior a ${PI_MIN_VERSION} no instala gentle-pi y falla: gentle-pi ${PINNED.gentlePi} no arranca con él
  7. ~/.orca-stack/state.json (para \`remove\`) y ~/.orca-stack/config.json (capa personal)

Es idempotente: una segunda corrida no cambia nada ni genera respaldos nuevos.
--limpiar-sdd respalda y mueve solo restos SDD conocidos a ~/.orca-stack/backups; sin la opci\u00f3n no mueve ninguno.
`,
  init: `orca-stack init [--dry-run] [--activar-hook]

Dentro de un repo git: agrega un bloque <!-- orca-stack:begin --> a AGENTS.md y CLAUDE.md (los crea si faltan),
crea .orca-stack.json (reglas del proyecto, se commitea) y .orca-stack.local.json (local, ignorado) y
agrega .orca-stack.local.json a .gitignore. No pisa archivos de config que ya existan.

Instala el lint (\`orca-stack lint\`) con cinco piezas, cada una solo si falta:
  1. la clave lint en .orca-stack.json: {"enabled": true, "comentarios": {"alcance": "repo"}}; si ya hay una clave lint,
     aunque sea {"enabled": false}, no se toca. Agregarla no cambia el resto del archivo (con respaldo). Para esto
     solo cuenta la de .orca-stack.json, no la de .orca-stack.local.json (al correr el lint, la capa local sigue ganando).
     Si .orca-stack.json no es JSON válido, no lo toca: nombra el archivo y el error, y sale con 1.
  2. .github/workflows/orca-stack-lint.yml, con un job orca-stack-lint que corre el lint con npx; no se crea si el
     archivo existe o si otro workflow de .github/workflows ya tiene un job orca-stack-lint o un paso que corre
     orca-stack lint (o bin/orca-stack.mjs lint). Nunca edita tus workflows.
  3. .githooks/pre-push, el aviso temprano que corre el lint antes de cada push.
  4. CODING_STANDARDS.md con la tabla de la regla de los comentarios; si ya existe no se toca, y si no tiene la tabla, avisa.
  5. .orca-stack-baseline.json, sembrada con las violaciones actuales de los archivos trackeados más los que escribió
     init, así que el job queda en verde después de commitear lo que escribió init. Con lint.enabled false no se crea.
     Si ast-grep no está disponible (falta o la plataforma no tiene binario fijado), la saltea con el motivo y el arreglo:
     orca-stack lint --sembrar donde haya ast-grep y otra corrida de init, o lint.enabled false. Sale con 0, y
     sin Baseline no crea el workflow (el job fallaría): lo crea la corrida que encuentre la Baseline.
Dice, por pieza, si la escribió o la salteó y por qué. Si una escritura falla, sigue con las demás, nombra la que
no escribió y sale con 1; otra corrida completa lo que falta sin duplicar nada. Una segunda corrida no cambia nada.

core.hooksPath: si no está puesto, init pregunta (en una terminal interactiva) antes de correr
\`git config core.hooksPath .githooks\`. Si decís que no, o la corrida no es interactiva y no pasaste --activar-hook,
no lo cambia e imprime ese comando para activarlo a mano. Con --activar-hook lo pone sin preguntar. Si ya apunta a
.githooks no hace nada; si apunta a otro lado nunca lo pisa, ni con --activar-hook: llamá a .githooks/pre-push desde tus hooks.
Si .git/hooks ya tiene hooks propios (cualquier archivo que no sea *.sample, por ejemplo de husky v4 o pre-commit),
tampoco lo cambia ni pregunta, ni con --activar-hook, porque dejarían de correr: llamá a .githooks/pre-push desde tu
.git/hooks/pre-push.
Con --dry-run muestra qué escribiría y no escribe nada.
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

Desde el checkout principal del repo (agentes: claude, agy, codex, pi). Se niega si el setup está pendiente, si el
agente no está en agentes.usa, si está en agentes.preguntarAntes sin --confirmado, si el issue está cerrado o asignado, o si ya hay
un worktree o un agente vivo para ese ticket. Asigna el issue, crea el worktree con \`orca worktree create\`, escribe el brief en
~/orca/briefs, comprueba que cada ruta que cita exista en el worktree, lanza el agente en una terminal de Orca y lo arranca con
\`orca orchestration worker-start\` en el Run ligado a main (\`run-current\`, o \`run-create\` si no hay uno), con el brief como spec:
el brief le llega una sola vez, también a pi. Si falla un comando de orca orchestration, imprime el error de Orca, lista lo que
quedó y le saca el assignee al issue.
Con --dry-run muestra el plan y el brief y no escribe nada.
Imprime \`Rama: <rama>\` con la rama que devolvió Orca; en --dry-run aclara que Orca define la rama al crear el worktree.
Después de confirmar el inicio, despachar, revisar y rebote leen tres veces la pantalla, salvo pi, con pausas de 5 segundos;
fallan ante un mensaje de cuota o si el último renglón no vacío volvió al prompt de PowerShell. No detectan prompts de bash ni cmd.exe.
El banner de codex que dice cuánto queda (⚠ 5h limit: 50% left · resets at 00:57) no cuenta como cuota, salvo con 0% left.
Con agentes.<agente>.rddConsentimiento "politica" (por defecto) escribe en el git dir del worktree orca-stack/rdd-consentimiento.json
con {"version":1,"granted":[]}: el consentimiento de RDD sobre el candidato propio es declined. Con "humano" no lo escribe.
Con pi leen la sesión nueva de Pi con las mismas pausas y fallan si su primera respuesta es "Failed to authenticate",
con esa línea y el CLAUDE_CONFIG_DIR usado.
Si la sesión nueva de Pi no aparece y el brief quedó escrito en la entrada de pi sin enviar, mandan un solo Enter a la
terminal y la esperan de nuevo; si sigue sin aparecer, fallan con el mismo mensaje y el term_<id>, sin un segundo Enter.
Si pi queda en \`waiting for input\` con la entrada vacía y sin sesión nueva, lo lanzan una vez más: revisar y planificar cierran esa
terminal; despachar, rebote y reanudar, que lo arrancaron supervisado, detienen su dispatch con \`orca orchestration worker-stop\` y lo
relanzan en una terminal nueva sobre la misma tarea (\`worker-start --task <id> --retry-of <dispatch>\`). Si el cierre, el worker-stop o
ese worker-start fallan, fallan nombrando la terminal y el error, sin otro lanzamiento. Si la segunda también queda vacía, fallan con el
mismo mensaje y el term_<id> de la segunda, que queda abierta.

Con pi, --perfil-pi <nombre> (o agentes.pi.perfil en la config; el flag gana) fija para ese worktree uno de los perfiles de
~/.pi/gentle-ai/profiles.json: escribe .pi/gentle-ai/profile.json en el worktree (fuera de git, vía info/exclude) y lanza pi con el
modelo del orquestador del perfil (por ejemplo --perfil-pi opus-sonnet). Se niega si el perfil no existe, si el clon ya fija otro
(<git-common-dir>/gentle-ai/profile-pin.json) o si algún modelo del perfil no es claude-bridge/, anthropic/ ni openai/.
Sin flag y sin agentes.pi.perfil, o con "preguntar", se niega antes de tocar nada (también en --dry-run): nunca cae solo al perfil
activo global. agentes.pi.perfil: "global" usa ese perfil activo a propósito. Imprime "perfil de Pi: <nombre> (fuente: flag | config |
pin | global)" y el brief guarda la misma línea.
`,
  revisar: `orca-stack revisar <pr> <agente> [--nota "<texto>"] [--confirmado] [--perfil-pi <nombre>] [--rutas <a,b>] [--dry-run]

Igual que despachar, para un review: worktree revision-<pr>-<agente> parado en la rama del PR. Se niega si el agente es el implementador del PR
(línea \`Implementador:\`) o si el agente usa un modelo de la misma familia (según \`agentes.modelos\`; pi y claude pueden revisarse entre sí).
Si el worktree ya existe, una segunda ronda lo reutiliza solo si está limpio, sin un agente trabajando, y su HEAD anterior alcanza el nuevo head del PR; rechaza el mismo head (salvo con --rutas), los commits locales y los perfiles de Pi distintos.
Las terminales en done y las shells vacías de ese worktree las cierra sola antes de reutilizarlo, y dice cuáles cerró.
Con --rutas <a,b> (rutas separadas por coma) el review lee solo esas rutas y lista en ## Cobertura lo que leyó (Leído:) y lo que no (Sin leer:);
ese review cuenta para el paso 7 solo si ninguna ruta de Sin leer: es de riesgo.
`,
  rebote: `orca-stack rebote <pr> [--nota "<texto>"] [--confirmado] [--perfil-pi <nombre>] [--continuar] [--rdd <lentes>] [--dry-run]

Relanza al autor indicado por \`Implementador:\` en el worktree existente de la rama del PR, como worker supervisado del Run ligado a
main (como despachar: reusa el Run o lo crea): abre la terminal del agente sin el brief y se lo entrega
\`orca orchestration worker-start --spec-file <brief> --task-title "#<issue> <agente> rebote #<pr>"\`, así el autor le pregunta a main
con \`orca orchestration ask\`. El issue sale del primer \`Closes #<n>\` del PR, si no del sufijo numérico de la rama, si no del número
del PR. Si worker-start falla, sale con el error de Orca y no publica marcador. Lo mismo vale para --rdd y --continuar. Exige un review bloqueante
vigente o checks fallidos sobre el head, worktree limpio y detenido en ese commit; los hallazgos de interpretaci\u00F3n (los que llevan \`interpretaci\u00F3n\` al final de su etiqueta, no en su texto) solo bloquean el rebote por review,
salvo que despu\u00E9s del review haya un comentario \`Respuesta del humano:\` en el PR o en un issue que cierra (\`Closes #<n>\`): entonces van al autor con el enlace a esa respuesta.
El rebote por review se cuenta por el \`Commit:\` de cada review: un \`Rebote: <sha>\` de un head anterior no frena ning\u00FAn rebote, y un head que avanz\u00F3 rebota si tiene un review bloqueante propio.
Un worktree limpio que solo est\u00E1 atr\u00E1s del head (por ejemplo, tras \`gh pr update-branch\`) se adelanta con \`git merge --ff-only <sha>\`.
Para CI roja agrega los checks fallidos al brief y publica \`Rebote CI: <sha>\`; publica \`Rebote: <sha>\` solo con bloqueos de review.
Los rebotes de CI 1 y 2 no piden nada más; el 3 y el 4 exigen un comentario que empiece con \`Diagnóstico: main\`, con \`Commit: <headRefOid>\` y una \`Siguiente hipótesis:\` que no esté vacía ni sea \`ninguna\`
y publicado después del último \`Rebote CI:\`; la hipótesis va al brief. No hay quinto rebote de CI. Si falta algo, se niega en una línea, sin marcador ni relanzar.
Con bloqueos de review imprime y publica, en el mismo comentario, \`Ronda: <n>\` debajo de \`Rebote: <sha>\`: n es la cantidad de SHAs distintos de los \`Rebote:\` anteriores, sin contar el head actual, m\u00E1s uno (\`Rebote CI:\` y \`Rebote conflicto:\` no suman rondas).
Desde la ronda 2 imprime, sin publicarla ni frenar el rebote, una l\u00EDnea que recuerda la se\u00F1al de swarm de diagn\u00F3stico del contrato.
El brief de un rebote por review le pide al autor nombrar la clase de defecto de cada hallazgo, corregir todas sus instancias en el diff y decir en su comentario cu\u00E1les otras revis\u00F3.
Un PR en conflicto con la base (mergeable CONFLICTING) rebota aunque no tenga bloqueos y su CI esté verde, falte o siga pendiente:
el brief suma \`## Merge conflict\` (git merge origin/<base>, nunca rebase) y publica \`Rebote conflicto: <sha>\`, con contador propio; repetirlo en el mismo head se niega.
Con pi, si el autor queda en \`waiting for input\` con la entrada vacía y sin sesión nueva, detiene ese dispatch con worker-stop y lo
lanza una vez más en la misma tarea (--retry-of); si la segunda también queda vacía, falla con "No observé una sesión nueva de Pi después del lanzamiento" y la terminal, sin publicar marcador.
Publica el marcador después de lanzar al autor; si \`gh pr comment\` falla, lo reintenta hasta 3 intentos con unos segundos entre uno y otro.
Si los 3 intentos fallan, sale con código 1 e imprime que el autor ya está relanzado, las líneas del marcador, su archivo y el comando
\`gh pr comment <pr> --body-file <archivo>\`, que main tiene que correr antes de cualquier otro rebote o merge de ese PR.
Con mergeable UNKNOWN se niega hasta que GitHub termine de calcular; un PR solo atrás (BEHIND) se niega y apunta a \`gh pr update-branch <n>\`.
Con pi usa el perfil que fija el worktree (.pi/gentle-ai/profile.json; --perfil-pi no lo cambia). Sin pin, --perfil-pi o agentes.pi.perfil
lo eligen y se escribe el pin; sin ninguno se niega como despachar, antes de mover el worktree.
Con --continuar retoma al autor que se cortó antes de pushear (por ejemplo, sin cuota): exige que el último marcador \`Rebote*\` sea del head, sin agente vivo y con el brief del rebote; acepta el worktree sucio, no publica marcador ni suma a los límites, y solo pi retoma la misma sesión (\`--session-id\`): claude, codex y agy arrancan una sesión nueva con el mismo brief. Si sigue sin cuota, falla con la hora de reset y no reintenta. No acepta --nota.
Con --rdd <lentes> (de 1 a 4 distintas entre risk, resilience, readability, reliability, separadas por coma) le pide a pi un review RDD de su propio PR:
solo con \`Implementador: pi\` y agentes.pi.review: "rdd" en la config. No exige review bloqueante ni mira CI o conflictos; el brief (brief-rdd.md)
le pide publicar \`Revisor: pi (RDD: <lentes>)\` y \`Commit: <sha>\`. No publica marcador \`Rebote*\`: publica en el PR \`RDD: <sha> (<lentes>)\`, el pedido sin el que puente-gentle no cuenta el review.
Se niega si ya hay sobre el head un review RDD de pi con ese pedido, y no vale con --continuar (su brief y su sesión van aparte: -rdd).
Cierra sola las terminales en done y las shells vacías del worktree, y dice cuáles cerró; se niega solo con un agente trabajando.
Con agentes.<agente>.rddConsentimiento "politica" (por defecto) escribe el consentimiento RDD del worktree: granted para el head con --rdd,
declined sin él. Con "humano" no lo escribe.
`,
  'brief-revision': `orca-stack brief-revision <pr> --modelo <modelo> [--dry-run]

Solo desde el checkout principal, con setup completo y en modo "un-agente". Crea un worktree detached en el head del PR y escribe en UTF-8 el brief de review compartido con \`revisar\`. El subagente escribe el cuerpo del review en un archivo; main lo publica.
Con --dry-run muestra las acciones y las rutas, sin crear worktree ni brief.
`,
  avisar: `orca-stack avisar <issue|pr> <url-del-comentario> [--dry-run]

El timbre: cuando main responde la pregunta de un worker, le escribe en su terminal una sola línea fija
("Message from main: <url>") con la URL del comentario y nada de su texto, para que la lea sin esperar a su PR.
Encuentra la terminal por el worktree de este repo enlazado a <n> (con un PR, el de su rama), buscado solo entre los de
\`git worktree list\` porque los selectores de Orca abarcan todos los repos, y, si un rebote dejó dos, elige la del agente vivo. Manda solo mientras el turno del worker está en curso: se niega si ya terminó, si la
terminal muestra un shell o un diálogo, o si hay más de un agente vivo. Avisa a claude, pi, codex y agy.
Se niega si el comentario no es de la cuenta del stack (\`gh api user\`), no está en <issue|pr> o no empieza con
\`Respuesta de main:\` o \`Respuesta del humano:\`. Envía con \`--wait-submit\` y nunca reintenta: sin recibo de entrega
informa la falla y no reenvía.
Con --dry-run muestra la línea y la terminal elegida, sin enviar nada.
`,
  reanudar: `orca-stack reanudar <issue> <url-del-comentario> [--confirmado] [--perfil-pi <nombre>] [--terminal <handle>] [--dry-run]

Reanuda un worker detenido: si su TUI sigue abierta en estado done, envía una línea con la URL de la respuesta; si ya salió,
lo relanza en su worktree existente, siempre como worker supervisado del Run de main, en uno de tres casos:
- Con una tarea \`#<issue> <agente>\` en ready, arranca un dispatch nuevo sobre ella con
  \`orca orchestration worker-start --run <run> --task <task_id> --terminal <handle>\`: Orca le entrega el brief una vez y la URL va sola
  en una línea aparte. No crea otra tarea.
- Sin Run o sin esa tarea, crea la tarea supervisada \`#<issue> <agente>\` como despachar (reusa el Run ligado a main o lo crea):
  \`orca orchestration worker-start --spec-file <brief> --task-title "#<issue> <agente>"\`, con la URL al principio del brief.
- Con esa tarea todavía en dispatched, crea una tarea supervisada nueva \`#<issue> <agente> reanudado\` y lo relanza ligado a ella.
Si worker-start falla, sale con el error de Orca, con código distinto de cero, y deja el worktree como estaba.
Con pi, una entrada vacía se relanza una vez sobre la misma tarea, como en despachar. Exige que la respuesta sea un comentario real
de la cuenta del stack o del humano (del issue o de su PR abierto), y se niega si el worker sigue trabajando, si ya hay un PR abierto
y la respuesta es del issue, o si el worktree está sucio. Un worker que quedó pendiente tras un \`cuenta cambiada:\` se relanza
(nunca una línea a la sesión pausada, que conserva su cuenta) aunque el worktree esté sucio.
Usa --confirmado solo después de que el humano haya confirmado relanzar un agente de agentes.preguntarAntes.
Un worker de pi se relanza con el modelo y el thinking del orquestador del perfil que fija su worktree (.pi/gentle-ai/profile.json).
Sin pin y sin agentes.pi.perfil se niega como despachar. Si el pin nombra un perfil que ya no existe, repetí con --perfil-pi <nombre>:
el flag elige el perfil y reescribe el pin.
Con --terminal <handle> reanuda el agente de esa terminal de Orca cuando el worktree tiene varios agentes en done.
Con --dry-run muestra qué enviaría o lanzaría sin escribir el brief ni tocar la terminal.
`,
  estado: `orca-stack estado [<pr>...] [--json]

De solo lectura: para cada PR (sin argumentos, cada PR abierto sobre ramaBase; uno mergeado o cerrado, solo si lo nombrás)
lee una vez \`gh pr view <n> --json number,headRefOid,body,comments,reviews,files,statusCheckRollup,baseRefName,mergeable,state\`
y dice qué le falta para el paso 7 de MAIN.md sobre su head actual:
  (a) un review sin bloqueos de alguien que no sea el Implementador:, o Verificado por main: / Decidido por main:, o, con
      agentes.pi.review "rdd" y un PR de pi, un review RDD de pi pedido con RDD: o un Sin review: (con ## Evidencia);
  (b) que esos comentarios lleven Commit: igual al head (el sha puede ir entre backticks);
  (c) que cada check termine en SUCCESS, SKIPPED o NEUTRAL y ninguno siga pendiente;
  (d) en una ruta de riesgo, el segundo review que exige puente-gentle.
Un review con ## Cobertura cuenta solo si ninguna ruta de Sin leer: es de riesgo; uno que se declara parcial sin
## Cobertura no cuenta. Una consulta que main publicó (Revisor: pi (consulta <tema>, publicada por main)) con Commit:
igual al head y ## BLOQUEA distinto de nada queda en falta hasta un Verificado por main: o Decidido por main: posterior
sobre ese head. Con migraciones {"glob","numero"} en la config, cada migración que agrega el PR tiene que tener un
número mayor que la más alta de origin/<base> (hace git fetch origin <base>); si no, imprime el comentario de review que
main publica para rebotarlo.
Sin --json imprime una línea por PR:
  #<pr> <issue> <implementador> head=<sha7> ci=<green|red|pending> review=<quién@sha|missing|stale> riesgo=<yes|no> falta=<...>
Con --json imprime {"pr":<n>,"head":"<sha de 40>","ok":<bool>,"falta":[…],"merge":<texto o null>} con un PR pedido, o un
arreglo con varios; "merge" copia la clave merge de la config sin juzgarla. Sale con 0 solo si todos están ok.
`,
  limpiar: `orca-stack limpiar [--dry-run]

Para cada worktree de este repo (salvo el checkout principal) cuyo PR se mergeó o se cerró, buscado por su rama o por
su nombre revision-<pr>-<agente>: cierra sus terminales (orca terminal close --worktree path:<ruta> --all) y lo saca
(orca worktree rm --worktree path:<ruta>, sin --force ni --delete-branch). Omite e informa los worktrees con cambios sin
commitear o con un agente trabajando; nunca borra ramas remotas. Es idempotente: una segunda corrida no saca nada.
Con --dry-run muestra qué sacaría sin tocar nada.
`,
  vigilar: `orca-stack vigilar <n...> [--cada <segundos>] [--una-vez] [--dry-run]
orca-stack vigilar --merge-de-main <pr>
orca-stack vigilar --paraguas <n> [--cada <segundos>] [--una-vez] [--dry-run]

Vigila los PRs de los issues <n...> de una tanda, hecho para correr bajo el Monitor: stdout lleva solo eventos, uno
por línea, y todo diagnóstico va a stderr. Cada --cada segundos (por defecto 60) lee \`gh pr list --state all\` y emite:
  pr-abierto #<n> PR #<pr> <sha>     un PR del issue, visto por primera vez
  ci-verde #<n> PR #<pr> <sha>       todos los checks del head terminaron en verde
  ci-roja #<n> PR #<pr> <sha>: ...   un check terminado falló, venció o se canceló (los lista); uno por corrida,
                                     también si un gh run rerun --failed vuelve a fallar en el mismo head
  diagnostico #<n> <agente>          diagn\u00f3stico de un worker en el issue o PR
  review-publicado #<pr> <agente> <sha> bloquea=<n>  review publicado en el PR
  head-nuevo #<pr> <sha>             camb\u00F3 el head del PR
  pr-en-conflicto #<n> PR #<pr> <sha>
                                     el PR quedó en conflicto con la base; uno por head (rebote, con el worker detenido)
  pr-mergeado #<n> PR #<pr> <sha>    el PR se mergeó y main no registró ese merge
  pr-cerrado #<n> PR #<pr>           el PR se cerró sin mergear
  worker-detenido #<n> <agente>: <motivo>
                                     worker sin PR detenido (cuota, volvió al shell, terminó sin abrir un PR) + última línea
  cuenta cambiada: <agente> <de> → <a>
                                     tras una cuota, seleccionó otra cuenta de Orca del mismo agente (ids; reanudar relanza)
  cuenta no cambiada: <agente> — <error>
                                     orca account list o select falló; el agente sigue sin cuota
  worker-trabado #<n> <agente>: <motivo>
                                     pantalla sin cambios (30m en working, o 4m en otro estado sin PR) + última línea
  vigilar-ciego: <error>             tres vueltas seguidas sin poder leer GitHub (una vez por corte)
  worker-terminado #<n> <agente> ok|partial
                                     un worker del Run de main mandó worker_done (ok si succeeded, partial si failed)
                                     o escaló (partial)
  worker-sin-reporte #<n> <agente>   Orca avisó que el worker paró sin reportar (stopReason finished), no hubo
                                     worker_done y la tarea ya no está dispatched; mientras sigue dispatched, nada
  consulta #<n> <agente> <message_id>
                                     un worker del Run de main preguntó con \`orca orchestration ask\`; main responde con
                                     \`orca orchestration reply --id <message_id>\` (o un gate para el humano)
  tanda-cerrada #<n> #<m>...         terminaron todos los items; sale con 0
En cada vuelta lee también el buzón del Run de Orca ligado a main (\`orca orchestration run-current\`), con
\`orca orchestration check --all\`, que no marca nada como leído, y nombra cada worker por el título "#<n> <agente>" de
su tarea, también con el sufijo " rebote #<pr>" o " reanudado" de un relanzamiento (las tareas con otro título
se ignoran). Sin Run ligado vigila solo GitHub; si Orca falla, lo dice una vez
por corte en stderr y sigue con GitHub.
Un PR es del issue por su referencia de cierre, por la rama del worktree de este repo enlazado al issue o por una línea
\`Closes #<n>\` en su cuerpo; nunca por adivinar el nombre de la rama. Un issue cerrado sin PR cuenta como terminado.
Guarda lo emitido en <git-common-dir>/orca-stack/vigilar.json: rearmado con los mismos argumentos, retoma sin repetir.
Si el proceso que lo lanzó desaparece (el Monitor venció o se paró), sale en menos de 5 segundos con su gh u orca.
--una-vez consulta una vez y sale; --dry-run consulta una vez y no escribe nada.

--merge-de-main <pr> registra el head del PR en <git-common-dir>/orca-stack/vigilar-merges.json y sale sin imprimir
nada en stdout. main lo corre justo antes de cada intento de \`gh pr merge <pr>\`, también después de
\`gh pr update-branch\`: un merge de ese head hecho dentro de los 30 minutos siguientes al registro no emite
pr-mergeado, aunque el watcher lo vea más tarde. Con un PR ya mergeado o cerrado sale con 1 y no registra nada.

--paraguas <n> vigila una sesión de planificación (\`orca-stack planificar <n>\`): cada --cada segundos lee los sub-issues
del issue paraguas con \`gh api repos/{owner}/{repo}/issues/<n>/sub_issues\` y emite
  planificacion-publicada #<n> #<a>,#<b>,…   una tanda nueva de sub-issues, cuando dejó de crecer entre dos vueltas
                                             seguidas (to-tickets los crea de a uno)
Nada por comentarios, ediciones ni issues que no son sub-issues del paraguas. Guarda lo avisado en vigilar.json (clave
paraguas:<n>): rearmado, no repite; los sub-issues que el paraguas ya tenía al correr planificar no cuentan como nuevos.
Sale con 0 cuando el paraguas se cierra. No acepta otros items.
`,
  planificar: `orca-stack planificar <issue-paraguas> [--perfil-pi <nombre>] [--dry-run]

Desde el checkout principal, con el setup completo. Lee el paraguas con \`gh issue view <n> --json number,title,state,body\`
y se niega, antes de tocar nada, si está cerrado o si su título está vacío (o no deja un slug). Hace git fetch origin, crea
con \`orca worktree create\` un worktree de Orca <repo>-planificacion-<n> (con su tarjeta, enlazado al paraguas) en la rama
docs/<slug> (el slug sale del título) desde origin/<ramaBase>, escribe el brief en ~/orca/briefs/<repo>-planificacion-<n>.md y
lanza pi ahí en modo interactivo: la sesión la maneja el humano (grill-with-docs, to-spec, to-tickets), commitea solo docs en
esa rama y la pushea, y publica los tickets como sub-issues del paraguas. Confirma que la sesión de pi arrancó.
Marca como ya avisados los sub-issues que el paraguas tenía, para \`orca-stack vigilar --paraguas <n>\`.
El perfil de Pi se elige como en despachar (--perfil-pi o agentes.pi.perfil). Se niega si ya hay un worktree en esa rama.
Con --dry-run muestra el plan y el brief y no crea nada.
`,
  lint: `orca-stack lint [--sembrar]

Dentro de un repo git, revisa cada archivo trackeado (nunca los sin trackear ni los ignorados por .gitignore) con dos reglas:
long-file: un archivo de más de 2000 líneas es una violación (cuentan las líneas en blanco, los comentarios y los tests;
exactamente 2000 pasa).
wide-directory: un directorio con más de 15 entradas es una violación (exactamente 15 pasa). Cuentan sus archivos trackeados
y sus subdirectorios con algún archivo trackeado; node_modules/ nunca cuenta. La raíz del repo es ./.
Cada violación nueva sale en una línea con la regla, el archivo o directorio, la cantidad y qué hacer:
  long-file test/foo.mjs: 2345 líneas (máximo 2000) — dividí el archivo
  wide-directory src/: 37 entradas (máximo 15) — agrupá los archivos relacionados en subdirectorios

En los archivos JS/TS (.js, .mjs, .cjs, .jsx, .ts, .tsx, .mts, .cts), Go (.go), Python (.py) y Shell (.sh, .bash) aplica la regla de los comentarios de CODING_STANDARDS.md:
  comment-excuse     TODO, FIXME, HACK o XXX (en mayúsculas), o hack, workaround, temporary (salvo "temporary file",
                     "temporary directory" y parecidos), for now, shortcut: o upgrade when
  comment-tautology  un comentario corto de una línea que repite la sentencia que sigue ("// increment i" sobre i++;
                     en Go también un doc comment que solo repite el nombre de la función, como "// Foo does foo." sobre func Foo)
  comment-stale      un comentario que nombra una llamada fooBar() que no está definida ni importada en el archivo; un
                     identificador entre backticks nunca se marca
Un comentario que cita un issue (#123), un ADR (ADR 0002) o docs/adr/0002-… es un Decision Record y pasa.
Nunca se marcan los shebangs, los encabezados de licencia, las directivas (eslint-…, @ts-…, prettier-ignore, c8 ignore…,
//go:build, //go:generate, //nolint, # shellcheck …, # type: ignore, # noqa, # -*- coding: … -*-), el comentario de paquete
golint ("// Package foo …" sobre package foo), los docstrings de Python, el JSDoc con tags de tipo (@type, @param…) ni un //
dentro de un string. La ubicación es la función, el método o la clase/tipo que lo contiene (o la declaración que sigue), o <módulo>:
  comment-excuse src/x.mjs:foo() (Excuse) — borralo y abrí un issue para arreglar la implementación
Go, Python, Shell y JS/TS corren solo cuando el repo tiene archivos de ese lenguaje; Markdown y los demás lenguajes no dan hallazgos de comentarios.

module-cycle, en JS/TS, Go (por paquete dentro del módulo de go.mod; sin go.mod no falla), Python (imports relativos y del
propio repo) y Shell (solo source / . de archivos relativos): los módulos que se importan en círculo (a importa b y b importa
a, o a → b → c → a) son una violación; una cadena a → b → c no. En JS/TS cuentan import … from, import './x', export … from y
require('./x') con un string; no cuentan import type ni export type … from de TS, ningún import() dinámico, los
paquetes (node:fs, nombres de npm) ni un especificador que no resuelve a un archivo revisado. Un especificador relativo
resuelve al archivo exacto, o con .mjs, .js, .cjs, .ts, .tsx, .mts, .cts o .jsx, o a /index con esas extensiones.
Cada ciclo sale como un recorrido cerrado que pasa por todos sus módulos y empieza y termina en el menor:
  module-cycle src/a.mjs → src/b.mjs → src/a.mjs — dale una dirección a los módulos

Tres chequeos de diseño más, en JS/TS, Go (paquete = módulo, struct/tipo/función exportada = cosa) y Python (archivo o paquete
con __init__.py = módulo, clase o función pública del nivel del módulo = cosa), portados de deslop-please (MIT; las definiciones,
en el manual). En Shell no corren y no producen nada.
Una cosa es una clase/struct, una función exportada del nivel del módulo o un objeto literal del nivel del módulo; una función
que no se exporta es un ayudante (lo que nombra cuenta como de quien la usa). Una referencia que no se resuelve (acceso
dinámico, import() calculado, paquete, archivo que no existe) se saltea y nunca hace fallar la corrida.
tangle          cosas que se conocen en círculo, escritas en más de un módulo, o más de 7 en un círculo:
  tangle src/kernel.mjs:Tasks, src/timers.mjs:Timers: 2 cosas en 2 módulos (máximo 7 cosas en un solo módulo) — …
field-leak      código de afuera de una clase (o, en Go, de otro paquete) que escribe, modifica o le llama un método a un campo suyo
                (queue.items.push(x)), cuando la clase se guarda un campo que usa un método suyo (en Go, un campo exportado
                que usan sus métodos); leer queue.size o llamar queue.push(x) no es fuga:
  field-leak src/queue.mjs:Queue.items: se trabaja fuera de Queue en 1 lugar de 1 módulo (src/app.mjs; máximo 0), …
shallow-module  un módulo (un archivo, un directorio con index.* o __init__.py, o un paquete Go) que muestra más de 7 funciones
                que usa código de afuera y al menos tantas como esconde:
  shallow-module src/store.mjs: muestra 9 de 15 funciones (…) y esconde 6 (máximo 7 mostradas, o más escondidas …) — …
La entrada de tangle es como la de module-cycle, con "members" de la forma archivo:nombre (en Go, paquete:Nombre); la de
field-leak es Clase.campo (en Go, paquete + Struct.Campo) y la de shallow-module, el módulo o paquete.

Los comentarios y los imports se leen con ast-grep 0.51.3, fijado por versión y sha256 (lo instala npm ci en la instalación de
orca-stack; ORCA_STACK_AST_GREP apunta a otro binario, que también se verifica). Si hay algún archivo JS/TS, Go, Python o Shell
y ast-grep falta, tiene otra versión o no coincide su checksum, el lint falla con 1 nombrando la versión y nunca pasa en silencio.

lint.comentarios.alcance, en la configuración (.orca-stack.json, .orca-stack.local.json o ~/.orca-stack/config.json):
  "repo" (por defecto)  revisa los comentarios de todo el repo contra la Baseline
  "diff"                solo marca los comentarios que tocan una línea que el cambio agrega respecto del merge-base
                        de HEAD con ramaBase (o origin/<ramaBase>), con los cambios sin commitear incluidos; las
                        entradas de comentarios de la Baseline no se evalúan, y long-file y wide-directory siguen igual
Un valor distinto, o un ramaBase que falta, no se encuentra o no tiene merge-base con HEAD, falla con 1.

lint.lenguajes: marca cada lenguaje (js, go, python, shell) como "blocking" o "warning". Un lenguaje en "warning" imprime
líneas "warning: …" y sale con 0 aunque haya violaciones nuevas. Por defecto, js, go y shell son "blocking" y python es
"warning" si los workflows de .github/workflows/ no corren sus suites de Python (pytest, unittest, tox, nox) y "blocking" si sí.

lint.excluir: lista de globs de rutas excluidas (por ejemplo ["vendor/**", "third_party/"]). Los archivos que coinciden nunca
se revisan por ninguna regla ni entran a la Baseline; un glob que no coincide con nada no es un error.

lint.enabled: false apaga el lint: imprime una línea que dice que está apagado y en qué archivo, sale con 0 y no escribe
nada (tampoco con --sembrar). Sin la clave, o con true, revisa como siempre; otro valor falla con 1.

La Baseline es .orca-stack-baseline.json, en la raíz del repo y commiteada: la lista de violaciones que ya existían,
{"version":1,"entries":[{"rule","file","location","fingerprint"}]}, sin números de línea. Una violación coincide con
una entrada de su regla por archivo o, si el archivo se movió sin cambios, por fingerprint (el de long-file sale del
contenido entero); cada entrada cubre una sola violación, así que una copia en otro archivo es nueva. La de wide-directory es
la ruta del directorio: renombrarlo da una violación nueva y una entrada vencida. Una entrada de
comentario guarda el símbolo como location y el fingerprint del texto del comentario: coincide por archivo, símbolo y
fingerprint, y si la función se movió a otro archivo o se renombró, por fingerprint. La entrada de module-cycle es el
conjunto de sus módulos: {"rule":"module-cycle","file":<el primero>,"location":"cycle","fingerprint",
"members":[rutas ordenadas]}. Un ciclo coincide con toda entrada que tenga a todos sus módulos, así que un ciclo que se
achica sigue pasando y uno con un módulo que no está en ninguna entrada es nuevo. La entrada vence solo cuando ningún
ciclo actual contiene dos o más de sus módulos (o uno que se importa a sí mismo), aunque pase por módulos de afuera:
cortar un import mientras otro camino los sigue uniendo en un ciclo la mantiene. En el alcance "diff",
module-cycle, tangle, field-leak y shallow-module se revisan igual que long-file y wide-directory.
lint no acepta --dry-run.
Una entrada cuya violación ya no está en ningún archivo del repo está vencida: el lint falla y pide sacarla a mano.
Sin Baseline, todas las violaciones son nuevas; una Baseline mal formada falla nombrando el archivo y nunca se reescribe.
Sale con 0 y una línea "lint OK" si toda violación tiene su entrada y ninguna está vencida; si no, con 1 y el reporte.
Una corrida sin --sembrar nunca escribe la Baseline.

--sembrar agrega a la Baseline cada violación actual que no tenga entrada y después revisa como siempre. Se usa una vez,
al prender el lint. Una segunda corrida no cambia nada y nunca saca entradas.

La CI corre el lint y es el chequeo que cuenta. El hook .githooks/pre-push lo corre antes de cada push como aviso
temprano: se activa por clon con \`git config core.hooksPath .githooks\` y \`git push --no-verify\` lo saltea sin cambiar la CI.
`,
  novedades: `orca-stack novedades [<nombre>]

El precheck de una automatización de Orca que sondea GitHub cada pocos minutos:
  orca automations create ... --precheck "orca-stack novedades"
Dentro del clon, hace una sola llamada a gh (gh api graphql: el issue y el PR actualizados más recientes, y el head
y el estado de CI de cada PR abierto) y la compara con la de su última corrida, guardada en
<git-common-dir>/orca-stack/novedades.json. Sale con 1 si no cambió nada (Orca registra la corrida como skipped_precheck,
sin correr el agente) y con 0 si hay novedades o es la primera corrida. Si no puede saberlo (gh sin red o sin login, fuera
de un repo git, gh colgado más de 20 s, un argumento o una opción de más), sale con 0 y lo dice en stderr: el agente corre
y lo informa, en vez de saltearse para siempre.
<nombre> separa la última corrida de cada automatización que sondea el mismo clon (por defecto, "default").
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
    else if (arg === '--continuar') flags.continuar = true
    else if (arg === '--rdd') {
      flags.rdd = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--rdd=')) flags.rdd = arg.slice('--rdd='.length)
    else if (arg === '--modelo') {
      flags.modelo = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--modelo=')) flags.modelo = arg.slice('--modelo='.length)
    else if (arg === '--force') flags.force = true
    else if (arg === '--skip-pi') flags.skipPi = true
    else if (arg === '--offline') flags.offline = true
    else if (arg === '--with-pi') flags.withPi = true
    else if (arg === '--una-vez') flags.unaVez = true
    else if (arg === '--json') flags.json = true
    else if (arg === '--sembrar') flags.sembrar = true
    else if (arg === '--activar-hook') flags.activarHook = true
    else if (arg === '--terminal' || arg === '--rutas') {
      flags[arg.slice(2)] = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--terminal=') || arg.startsWith('--rutas=')) {
      flags[arg.slice(2, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1)
    }
    else if (arg === '--paraguas') {
      flags.paraguas = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--paraguas=')) flags.paraguas = arg.slice('--paraguas='.length)
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
  // Options that belong to one command only: any other command keeps refusing them, as before they existed.
  for (const [flag, owner, name = flag] of [['json', 'estado'], ['terminal', 'reanudar'], ['rutas', 'revisar'], ['paraguas', 'vigilar'], ['sembrar', 'lint'], ['activarHook', 'init', 'activar-hook']]) {
    if (flags[flag] !== undefined && rest[0] !== undefined && rest[0] !== owner) throw new Error(`Opción desconocida: --${name}`)
  }
  if (flags.terminal !== undefined && (flags.terminal.trim() === '' || flags.terminal.startsWith('--'))) {
    throw new Error('--terminal necesita el handle de una terminal de Orca (orca terminal list).')
  }
  if (flags.paraguas !== undefined && (flags.paraguas.trim() === '' || flags.paraguas.startsWith('--'))) {
    throw new Error('--paraguas necesita el número del issue paraguas.')
  }
  if (flags.rutas !== undefined && (flags.rutas.split(',').every(one => one.trim() === '') || flags.rutas.startsWith('--'))) {
    throw new Error('--rutas necesita una o más rutas separadas por coma.')
  }

  return { command: rest[0], flags, rest }
}

// io reaches the commands that take one (rebote), so a test drives the same exit-code mapping as bin/orca-stack.mjs.
export const main = async (argv, io) => {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    console.error(`${error.message}\n\nUsá --help para ver las opciones.`)

    // A precheck that exits non-zero makes Orca skip the run: a typo in novedades must let the agent run and report it.
    return argv[0] === 'novedades' ? 0 : 2
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
        return await revisarCommand(flags, rest[1], rest[2], io)
      case 'rebote':
        return await reboteCommand(flags, rest[1], io)
      case 'brief-revision':
        return await briefRevisionCommand({ ...flags, n: rest[1] })
      case 'avisar':
        return await avisarCommand(flags, rest[1], rest[2])
      case 'reanudar':
        return await reanudarCommand(flags, rest[1], rest[2])
      case 'vigilar':
        return await vigilarCommand(flags, rest.slice(1))
      case 'planificar':
        return await planificarCommand(flags, rest[1], io)
      case 'estado':
        return await estadoCommand(flags, rest.slice(1), io)
      case 'limpiar':
        return await limpiarCommand(flags, io)
      case 'lint':
        return await lintCommand(flags)
      case 'novedades':
        return await novedadesCommand(flags, rest.slice(1))
      default:
        console.error(`Comando desconocido: ${command}\n\n${USAGE}`)

        return 2
    }
  } catch (error) {
    console.error(`✖ ${error.message}`)

    return 1
  }
}
