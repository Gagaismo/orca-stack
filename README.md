# orca-stack

Instala de una vez el stack de agentes que uso para trabajar con [Orca](https://github.com/stablyai/orca): la política del stack, las skills propias, los wrappers de proveedores, Pi con Gentle Shell y los mods de Claude Code. Todo en un comando, con respaldo de lo que toca y con vuelta atrás.

**¿Cómo se usa día a día?** Leé el [manual de uso](docs/manual.md): comandos, mods, marchas, cuándo conviene usarlo y cuándo no, casos borde y manejo. Marca lo que está solo en `main` y todavía no salió en un release.

```bash
npx github:Gagaismo/orca-stack#v0.11.0 global     # instalación a nivel usuario
npx github:Gagaismo/orca-stack#v0.11.0 init       # cablea el proyecto actual
npx github:Gagaismo/orca-stack#v0.11.0 doctor     # verifica que todo funcione de verdad
npx github:Gagaismo/orca-stack#v0.11.0 remove     # deshace lo que instaló global
npx github:Gagaismo/orca-stack#v0.11.0 sesiones   # lista las sesiones recientes de Claude, Pi y agy (para `/retro`)
npx github:Gagaismo/orca-stack#v0.11.0 despachar 12 agy   # desde el checkout principal: despacha el ticket #12 al agente
npx github:Gagaismo/orca-stack#v0.11.0 revisar 15 pi      # despacha el review del PR #15
npx github:Gagaismo/orca-stack#v0.11.0 brief-revision 15 --modelo <modelo>   # modo un-agente: worktree y brief de review para un subagente
npx github:Gagaismo/orca-stack#v0.11.0 consultas 42 57    # filtra y avisa consultas nuevas en issues y PRs en curso
npx github:Gagaismo/orca-stack#v0.11.0 avisar 42 <url>    # Proactive: le toca el timbre al worker de #42 con la URL de la respuesta
npx github:Gagaismo/orca-stack#v0.11.0 vigilar 42 57      # el Monitor de la tanda: solo eventos de sus PRs, hasta tanda-cerrada
```

¿Primera vez, o un proyecto nuevo o ya empezado? Seguí la [guía de setup](docs/guia-setup.md): tiene un cuestionario que dice qué configurar en cada caso.

Cero dependencias, Node 20 o más nuevo. Funciona en Windows, macOS y Linux.

## Qué instala

`global` (idempotente; todo archivo que modifica se respalda antes en `~/.orca-stack/backups/<fecha>/` (nunca al lado del archivo, para que ningún agente cargue el respaldo)):

| Qué | Dónde |
| --- | --- |
| Política del stack: `ORCA-STACK.md` y `ROLE-BRIEFS.md` | `~/orca/stack/` |
| Wrappers `claude-orca-stack`, `codex-orca-stack`, `agy-orca-stack` (`.cmd` en Windows, `.sh` en el resto), cada uno con `--orca-stack-self-test` | `~/orca/stack/scripts/` |
| Skills propias: `orca-stack-policy`, `orca-setup`, `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-help` | `~/.claude/skills/` y `~/.agents/skills/` |
| Siete mods de Claude Code (ver abajo) y sus rutas en `env.CLAUDE_CODE_PLUGIN_DIRS` | `~/.claude/mods/` y `~/.claude/settings.json` |
| Nada de metodología en `~/.claude/CLAUDE.md`: si un `global` anterior dejó ahí el bloque `<!-- orca-stack:begin -->` … `<!-- orca-stack:end -->`, lo saca (con respaldo). También achica el bloque que gentle-ai escribe ahí (ver abajo) | `~/.claude/CLAUDE.md` |
| Pi: `gentle-pi@4.2.0` y `pi-claude-bridge@0.9.2` con `pi install` (`pi install npm:gentle-pi@4.2.0`), más `npm i -g gentle-pi@4.2.0` (comando `gentle-shell`). Necesita Pi `1.2.0` o más nuevo: con un Pi anterior no instala gentle-pi y falla | `~/.pi/agent/` y npm global |
| Comando `orca-stack`, para usar desde cualquier repo sin npx ni red | Windows: prefijo global de npm si esta en `PATH`, con shims `.cmd` y sin extension para PowerShell y Git Bash. Otros sistemas: primer directorio escribible del `PATH`. La copia queda en `~/.orca-stack/cli/`; si falta el destino compartido, se usa `~/.orca-stack/bin/` y `global` imprime como agregarlo al `PATH` |
| Registro de lo instalado, para `remove` | `~/.orca-stack/state.json` |
| Capa personal de configuración | `~/.orca-stack/config.json` |

Gentle Shell se actualiza volviendo a correr `global` con la versión nueva de orca-stack. Desde gentle-pi 4.2.0, `gentle-shell update` reinstala solo el paquete global dueño del Pi que corre, y si no puede probar qué paquete global es dueño de Pi, no toca nada.

Los wrappers se llaman distinto del binario real a propósito: así nunca se llaman a sí mismos. Cada uno fija los marcadores `ORCA_STACK_*`, busca el binario real en el `PATH`, pasa los argumentos tal cual y devuelve su código de salida.

`global` instala herramientas, skills, mods y wrappers, pero ningún texto de metodología: una sesión de Claude en un proyecto sin `.orca-stack.json` no recibe nada del stack por esta vía. La metodología llega por el proyecto, con `init` (el contrato y las líneas de la política en `AGENTS.md`, y `@AGENTS.md` en `CLAUDE.md`). Del `CLAUDE.md` global `global` solo saca el bloque entre `orca-stack:begin` y `orca-stack:end` (o `orca-stack:auto`, el viejo) que dejó una versión anterior, y respeta todo lo demás. Con `settings.json` hace algo parecido: solo suma sus carpetas a `CLAUDE_CODE_PLUGIN_DIRS` (con el separador de tu sistema), conserva las que ya había y no toca ninguna otra clave.

El bloque `gentle-ai:sdd-orchestrator` (v2/v3) o `gentle-ai:orchestrator` (v4) de `~/.claude/CLAUDE.md` (unos 16 KB: coordinación, delegación, tabla de modelos y el flujo de cada versión) se carga en cada sesión. Por eso `global` lo achica según `gentle.orchestrator` en `~/.orca-stack/config.json`:

- `"lazy"` (por defecto): guarda el texto completo, tal cual lo escribió gentle-ai, en `~/.orca-stack/gentle/orchestrator.md` y deja entre los marcadores un puntero corto (empieza con `<!-- orca-stack:gentle-lazy v1 -->`). El puntero dice que ODD es el flujo predeterminado y que la sesión que orquesta (`main`) debe leer la copia completa; también exige presentar completos los menús y pedidos de consentimiento, sin responder por el humano. Hace respaldo, es idempotente, respeta `--dry-run` e imprime cuántos KB ahorró. Con marcadores incompletos, repetidos o desordenados no escribe nada y dice por qué. Se omite mientras el RDD de gentle-ai esté prendido (o no se pueda leer): el bloque trae su contrato de review y el puntero lo apagaría en silencio; si ya estaba en lazy, `global` lo restaura desde la copia.
- `"full"`: deja el bloque como lo escribe gentle-ai (y, si estaba en lazy, lo restaura desde la copia, con respaldo; si la copia falta, avisa que corras `gentle-ai sync`). Con el RDD de gentle-ai apagado (`gentle-ai review mode status` dice `off`), además recorta las secciones de review, que no hacen nada y se cargan igual (unos 26 KB); si RDD está prendido o gentle-ai no está instalado, ese recorte se omite y dice por qué.

`gentle-ai sync` reescribe el bloque entre los marcadores (reemplaza el contenido, no duplica ni valida un hash), así que después de cada sync hay que correr `orca-stack global` de nuevo, que además refresca la copia y el puntero. `doctor` avisa si la sync lo reescribió, si falta la copia o si todavía está en la ruta antigua. Para volver al bloque completo: poné `"gentle": { "orchestrator": "full" }` y corré `orca-stack global`, o corré `gentle-ai sync`. `orca-stack remove` también lo restaura desde la copia. La clave antigua `gentle.sddOrchestrator` sigue funcionando durante la migración; `doctor` sugiere renombrarla y, si están las dos, `gentle.orchestrator` tiene prioridad. `global` mueve la copia antigua `sdd-orchestrator.md` a `orchestrator.md`; si existen ambas, conserva la más nueva por fecha de modificación y respalda la otra.

**gentle-ai v4.** v4 retiró SDD y OpenSpec: ODD es su único flujo y `gentle-ai sync` renombra el bloque en el lugar a `gentle-ai:orchestrator`, con el orquestador ODD adentro y las mismas secciones de review. `global`, `doctor` y `remove` reconocen los dos nombres: el modo lazy, el recorte y la restauración funcionan igual; el puntero indica que ODD es el flujo predeterminado y que la sesión `main` lee la copia completa. La copia queda en `~/.orca-stack/gentle/orchestrator.md`. Para pasar a v4 en Windows (necesita Go 1.25.10 o más nuevo en el `PATH`):

```powershell
go install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@v4.1.1
gentle-ai sync
npx github:Gagaismo/orca-stack global
```

La sync deja el bloque completo y la copia vieja (de v2) queda desactualizada: `doctor` avisa que corras `orca-stack global`, que guarda el texto de v4 en la copia y vuelve a dejar el puntero.

### Los mods

Son plugins de Claude Code que se recargan en caliente (`.claude-plugin/plugin.json` + `hooks/`). Se activan con la variable `CLAUDE_CODE_PLUGIN_DIRS`, que `global` completa por vos; se cargan en las sesiones que abras después.

| Mod | Qué hace | Config |
| --- | --- | --- |
| `tablero-despacho` | Tablero de PRs abiertos con checks, review y worktrees (`/tablero`). Usa `gh`. | Los atajos de despacho aparecen solo si hay `despacho` |
| `guardia-despacho` | Bloquea o corrige las llamadas a tus scripts de despacho y revisión según reglas del proyecto. Siempre activo, con o sin `despacho`: pregunta qué perfil de gentle-pi usa un despacho a pi (`--perfil-pi`); rechaza `orca worktree rm` y `git worktree remove` si la rama de ese worktree tiene commits que no están en ningún remoto, porque `orca worktree rm` borra también la rama local. Si no puede resolver la rama, rechaza | Las reglas de despacho están **apagadas** salvo que haya `despacho` |
| `puente-gentle` | Consulta a Gentle Shell (Pi) como otro orquestador par (`/pi`, `/gentle`). La instrucción de consultar y la herramienta `consultar_gentle_shell` aparecen solo en un repo con `.orca-stack.json`. Frena el merge de un PR grande sin consulta y el de uno que toca `riesgo` sin sus reviews limpios (de pi, o de dos familias de modelo que no sean la de pi si el PR lo escribió pi) | `humano`, `riesgo`, `agentes.pi.claudeConfigDir` |
| `bandeja-mensajes` | Captura los bloques ` ```mensaje <destinatario> ` que redacta Claude y deja copiarlos o guardarlos | `mensajes.destinatarios` |
| `grilling-ok` | Responde con un clic (o con un `ok`) a las preguntas Q1…Qn de una sesión de grilling | — |
| `modo-autonomo` | Instrucción permanente de trabajo autónomo hasta la meta, con recordatorio anti-parada acotado | — |
| `marchas` | `/marcha` muestra o cambia la marcha de `main`: Lazy, Medium o Proactive; cada sesión nueva empieza en Medium; avisa en una línea cuando el modo autónomo coincide con Lazy, Proactive o ultracode | — |
| `reloj-cache` | Muestra cuánto falta para que venza el caché del prompt y ofrece `/compactar-ya` | — |

El mod `marchas` actúa solo en el checkout principal de un repo con `.orca-stack.json` o `.orca-stack.local.json` cuyo contrato incluye la sección `Marchas`. Para mostrar la marcha actual, usá `/marcha`; para cambiarla, `/marcha lazy`, `/marcha medium` o `/marcha proactive`. Para apagarlo, corré `claude plugin disable marchas@inline --scope user`; usá `--scope local` para este repo en esta máquina o `--scope project` para el equipo.

## Prerrequisitos

- Node.js 20 o más nuevo (Pi pide Node 22.19 o más nuevo).
- Git y [GitHub CLI](https://cli.github.com) (`gh`), para el tablero y para el puente.
- [Claude Code](https://claude.com/claude-code), para los mods.
- En Windows, el `postinstall` de `gentle-pi` compila el binario de gentle-ai con Go (1.25.10 o más nuevo): si `pi install` de gentle-pi falla, revisá que `go` esté en el `PATH`.

`global` **detecta** estas herramientas, no las instala; si faltan, imprime el comando oficial de cada una:
[Orca](https://github.com/stablyai/orca), [engram](https://github.com/Gentleman-Programming/engram), [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) y [Pi](https://github.com/earendil-works/pi).

## Uso

```text
orca-stack global [--dry-run] [--force] [--skip-pi] [--limpiar-sdd] [--humano <nombre>]
orca-stack init   [--dry-run]
orca-stack doctor [--offline] [--skip-pi]
orca-stack remove [--dry-run] [--with-pi]
orca-stack sesiones [--desde <AAAA-MM-DD>] [--limite <n>]
orca-stack despachar <issue> <agente> [--nota "<texto>"] [--confirmado] [--perfil-pi <nombre>] [--dry-run]
orca-stack revisar <pr> <agente> [--nota "<texto>"] [--confirmado] [--perfil-pi <nombre>] [--dry-run]
orca-stack consultas <n...>
orca-stack avisar <issue|pr> <url-del-comentario> [--dry-run]
orca-stack vigilar <n...> [--cada <segundos>] [--una-vez] [--dry-run] [--consultas]
orca-stack vigilar --merge-de-main <pr>
```

- `--dry-run` cuenta cada acción sin escribir nada.
- `--force` reemplaza archivos que ya existían y no son de orca-stack (por ejemplo, una skill tuya llamada igual). Sin `--force` se saltean con un aviso ⚠ y quedan como estaban; con `--force` se respaldan antes.
- `global --limpiar-sdd` respalda en `~/.orca-stack/backups/sdd-<fecha>/` y mueve solo restos conocidos; `doctor` lista los que encuentra y muestra el comando exacto. Los nombres desconocidos nunca se mueven y `global` sin esta opción no limpia nada. Si algún movimiento falla, informa qué quedó pendiente; podés volver a ejecutar el mismo comando.
- `init` escribe en el `AGENTS.md` del proyecto el bloque `<!-- orca-stack:begin -->` … `<!-- orca-stack:end -->` con el contrato de trabajo completo (`assets/stack/CONTRATO.md`, igual en todos los proyectos) y las líneas de la política; a `CLAUDE.md` le pone un bloque corto con `@AGENTS.md`. Además crea `.orca-stack.json` y `.orca-stack.local.json` si faltan y agrega este último a `.gitignore`. Es idempotente y respalda lo que modifica. Los valores propios de cada proyecto no van en el bloque: viven en `.orca-stack.json`.
- `orca-setup` es la skill con la que la sesión de `main` entrevista al humano, en una sola ronda, para completar `.orca-stack.json` (`"setup": "completo"`). La ofrece sola cuando falta y `doctor` avisa si quedó pendiente.
- `sesiones` es de solo lectura: lista las sesiones recientes de Claude Code (`~/.claude/projects` y, si está, la carpeta de `agentes.pi.claudeConfigDir`), de Pi (`~/.pi/agent/sessions`) y de agy (`~/.gemini/antigravity-cli`, solo con Node 22.13 o más nuevo). Por sesión muestra la herramienta, la carpeta, inicio y fin, las llamadas, tus mensajes, las llamadas con error y los resultados de más de 15k caracteres. Es la entrada para quien corre `/retro` de Matt: `--desde` fija el día de inicio (por defecto, los últimos 2 días) y `--limite` cuántas sesiones (por defecto, 10).
- `consultas <n...>` filtra y avisa consultas nuevas en issues o PRs de una tanda. Consulta `gh api user` en ejecución, busca comentarios de la cuenta del stack que empiecen con `Consulta:` e imprime `consulta nueva en #<n>` una sola vez por comentario, guardando los IDs en `.git/orca-stack/consultas-reportadas.json`.
- `vigilar <n...>` es el Monitor de una tanda (`<n...>`, los issues de la tanda): stdout lleva solo eventos, uno por línea, y todo diagnóstico va a stderr. Cada `--cada` segundos (por defecto 60) lee `gh pr list --state all` (sin `--state` no aparecen los PRs mergeados ni cerrados) y emite `pr-abierto`, `ci-verde`, `ci-roja` (con los checks que fallaron), `pr-mergeado`, `pr-cerrado`, `vigilar-ciego` (tres vueltas seguidas sin poder leer GitHub, una vez por corte; nunca dice que no hay PRs) y, cuando terminaron todos los items, `tanda-cerrada`, y sale con 0. Un PR es del issue por su referencia de cierre, por la rama del worktree de este repo enlazado al issue (buscado como en `avisar`) o por una línea `Closes #<n>` en su cuerpo, nunca por el nombre de la rama; un issue cerrado sin PR cuenta como terminado. De dos corridas de un mismo check en un commit cuenta la última, y cada corrida que termina en rojo es un `ci-roja`, también un `gh run rerun --failed` que vuelve a fallar en el mismo commit; la misma corrida leída de nuevo no se repite. Lo emitido queda en `.git/orca-stack/vigilar.json`: rearmado con los mismos argumentos, retoma sin repetir nada. `--una-vez` consulta una vez y sale, `--dry-run` además no escribe nada, y `--consultas` corre en cada vuelta el chequeo de `consultas` para los mismos items, así Proactive sigue con un solo Monitor. Como todas las sesiones comparten la cuenta de `gh`, un merge de `main` se ve igual que uno del humano: `main` corre `vigilar --merge-de-main <pr>` justo antes de cada intento de `gh pr merge <pr>` (y de nuevo después de `gh pr update-branch`), que registra el head del PR en `.git/orca-stack/vigilar-merges.json`; un merge de ese head visto dentro de los 30 minutos no emite `pr-mergeado`. El watcher solo lee ese archivo.
- `avisar <issue|pr> <url-del-comentario>` es el timbre de Proactive: cuando `main` responde la pregunta de un worker, le escribe en su terminal una sola línea fija, `Message from main: <url>`, con la URL del comentario y nada de su texto. Encuentra la terminal por el worktree de este repo enlazado a `<n>` en `orca worktree ps` (con un PR, el de la rama del PR), buscado solo entre los de `git worktree list`, porque los selectores `issue:<n>` y `branch:` de Orca abarcan todos los repos; lista sus terminales con `orca terminal list --worktree path:<ruta>` y se niega si alguna no trae ese `worktreePath`. Si un `rebote` dejó dos, elige la del agente vivo según `orca worktree ps`. Manda solo mientras el turno del worker está en curso (estado `working` en Orca y el indicador de turno de Claude en pantalla): se niega si el turno ya terminó, si la terminal muestra un shell o un diálogo, o si hay más de un agente vivo. Por ahora solo avisa a claude: se niega con pi, que corre sin TUI y relee los comentarios antes de su PR, y con codex y agy hasta que pasen su prueba de Enter a mitad de turno. Se niega si el comentario no es de la cuenta del stack (`gh api user`), si no está en `<issue|pr>` o si no empieza con `Respuesta de main:` o `Respuesta del humano:` (la misma cuenta publica las `Consulta:` de los workers). Envía una sola vez con `--wait-submit`: sin recibo de entrega informa la falla y no reenvía. `--dry-run` muestra la línea y la terminal elegida sin enviar nada. `main` nunca arma el timbre con llamadas sueltas a `orca`.
- `despachar` y `revisar` (agentes: claude, agy, codex, codex-cc, pi) corren desde el checkout principal de un repo con el setup completo. Se niegan si el agente no está en `agentes.usa`, si está en `agentes.preguntarAntes` (repetí con `--confirmado` cuando el humano dijo que sí), si el issue está cerrado o asignado, si el revisor es el implementador del PR (línea `Implementador:`) o corre un modelo de su misma familia (sale de `agentes.modelos`; pi y claude sí se revisan entre sí), si el agente tiene una regla `guardia.bloquear` vigente, o si ya hay un worktree o un agente vivo para ese ticket. Antes de tocar nada hacen `git fetch origin` y comprueban que cada ruta que cita el brief (armado desde `assets/stack/brief-ticket.md` o `brief-revision.md`) exista en `origin/<ramaBase>` (en `revisar`, en la rama del PR): una ruta que falta o que git ignora aborta sin asignar ni crear nada. Si pasa todo, `despachar` asigna el issue (el assignee es el cerrojo y lo maneja el comando: no se asigna antes), y ambos crean el worktree con `orca worktree create` (así lo ve Orca), escriben el brief en `~/orca/briefs/`, lanzan el agente en una terminal de Orca y le mandan el brief. `despachar` imprime `Rama: <rama>` con el nombre devuelto por Orca; en `--dry-run` aclara que Orca define la rama al crear el worktree. Después de confirmar el inicio, despachar, revisar y rebote leen tres veces la pantalla de cada terminal salvo pi, con pausas de 5 segundos: fallan si ven un mensaje de cuota o si el último renglón no vacío volvió al prompt de PowerShell (`PS <unidad>:\...>`). No detectan prompts de bash ni `cmd.exe`. Si algo falla después de crear el worktree, el mensaje lista lo que quedó (assignee, worktree, brief) y cómo recuperarlo, porque el cerrojo rechaza un reintento. Pi corre sin TUI (`pi -p`), así que sí puede ejecutar git, gh y la suite. `--nota` agrega texto al brief y `--dry-run` muestra el plan y el brief sin escribir nada. Los modelos salen de `agentes.modelos` de tu config personal: un texto, `{ "modelo", "esfuerzo" }` o `{ "implementar": {…}, "revisar": {…} }` por agente.

- `--perfil-pi <nombre>` (solo con `pi`) fija qué perfil de modelos de gentle-pi usa **ese** despacho, sin tocar el perfil global activo. Los perfiles viven en `~/.pi/gentle-ai/profiles.json`; el comando se niega si el nombre no existe o si el clon ya fija otro perfil (`<git-common-dir>/gentle-ai/profile-pin.json`, que gana en silencio sobre el del worktree). Después de crear el worktree escribe el pin `.pi/gentle-ai/profile.json` ahí (gentle-pi lo lee en cada lanzamiento de subagente) y, si git no lo ignora, agrega `/.pi/gentle-ai/profile.json` a `<git-common-dir>/info/exclude`, así que nunca se commitea. Si el pin ya está versionado en el repo, lo deja como está cuando declara el mismo perfil y se niega (sin escribir) si declara otro; si git sigue sin ignorarlo después de la entrada (por ejemplo un `.gitignore` con `!.pi/gentle-ai/profile.json`), también se niega. Un `thinking` inválido en el perfil se avisa y se ignora. Como un pin no mueve al orquestador, lanza pi con `--model <orchestrator.model del perfil> --thinking <orchestrator.thinking>`. Con `--dry-run` cuenta todo esto sin escribir. Sin el flag y sin `agentes.pi.perfil` (o con `"preguntar"`) rige el perfil activo global, como siempre. `agentes.pi.perfil: "<nombre>"` lo fija para todos los despachos a pi y el flag gana.
- `guardia-despacho` pregunta ese perfil por vos: cuando Claude corre `orca-stack despachar|revisar <n> pi` sin `--perfil-pi` y `agentes.pi.perfil` no es un nombre, abre el diálogo "Perfil Pi" con los perfiles de `profiles.json` (`opus-haiku` y `samu-balanceado` primero; máximo cuatro opciones) y agrega `--perfil-pi <elegido>` justo detrás del agente. Si cierran el diálogo, o no hay nadie que conteste (`-p`), el comando corre sin cambios. Las consultas (`/pi`, `consultar_gentle_shell`) no preguntan, y un `--dry-run` tampoco.
- Perfil `opus-haiku`: el orquestador es Opus 5.5 (`claude-bridge/claude-opus-5-5`, thinking `high`) y los diez subagentes de gentle-pi (`gentle-ai-explore`, `gentle-ai-verify`, `gentle-ai-worker`, `jd-fix-agent`, `jd-judge-a`, `jd-judge-b`, `review-readability`, `review-reliability`, `review-resilience`, `review-risk`) corren en Haiku 5.5 (`claude-bridge/claude-haiku-5-5`). Un perfil tiene que nombrar a todos los agentes: el que omite uno lo deja con el modelo de su frontmatter. Para cambiarlo después: `/gentle:profiles` en Pi, o editar `~/.pi/gentle-ai/profiles.json` (hacé una copia antes).
- `--skip-pi` no toca Pi (útil si todavía no lo instalaste).
- `--humano` fija cómo te nombran los mods; si no lo pasás, sale de `git config user.name`.
- `doctor` hace sondeos reales y sale con código 1 si hay una falla (✖). Los avisos (⚠) no cambian el código.
- `remove` borra lo que `global` creó, restaura lo que había reemplazado, saca sus entradas de `CLAUDE_CODE_PLUGIN_DIRS` y, si quedó, el bloque de `CLAUDE.md` de una instalación vieja. Los respaldos (`~/.orca-stack/backups/<fecha>/`) se quedan. Los paquetes de Pi solo se sacan con `--with-pi`, y solo los que no tenías antes de instalar. Si editaste `~/.orca-stack/config.json`, se conserva.
- Para probar sin tocar tu carpeta personal: `ORCA_STACK_HOME=/ruta/temporal orca-stack global`.

### `doctor`

No se queda en "el archivo existe":

- corre el `--orca-stack-self-test` de cada wrapper y comprueba que la ruta de la política exista;
- compara la versión de Pi y de sus paquetes con las fijadas (Pi `1.2.0`, gentle-pi `4.2.0`, pi-claude-bridge `0.9.2`) y avisa si no coinciden; un Pi anterior a `1.2.0` es una falla, porque gentle-pi 4.2.0 no arranca con él;
- sondea con un `pi -p` corto (con tiempo máximo) si falta el `/login` (se omite con `--offline`);
- verifica que las skills de gentle-pi se resuelvan igual que lo hace `puente-gentle` en ejecución (primero la carpeta de Pi, después `npm root -g`);
- comprueba que cada mod esté en `CLAUDE_CODE_PLUGIN_DIRS`;
- avisa si los plugins `ponytail` o `caveman` de Claude Code están instalados y activos, con el comando que los desactiva;
- combina las tres capas de configuración igual que los mods y avisa si un script de `despacho` no existe;
- avisa de la deriva: el plugin `mattpocock-skills` por debajo de 1.3.1, skills que están en `~/.claude/skills` y también en el plugin (quedan dos veces en el contexto), `pr`, `implement-spec` o `retro` ausentes de `~/.agents/skills`, el bloque orca-stack viejo que sigue en `~/.claude/CLAUDE.md` (`orca-stack global` lo saca) el bloque de gentle-ai que la sync reescribió completo (o, en modo `full`, las secciones de review que siguen ahí con RDD apagado) y, como falla, un puntero lazy sin su copia. Son avisos, no fallas, y cada uno trae el comando que lo arregla;
- detecta `engram` (y avisa si es anterior a 3.4.0: con un servidor más viejo, Gentle Shell 4.2.0 deja la memoria apagada), `gentle-ai`, `gh` y Orca, y **solo lee** `orca-data.json` de los perfiles de Orca para decirte si los overrides de los agentes apuntan a los wrappers. Nunca lo escribe.

## Configuración en tres capas

Los mods leen su configuración al ejecutarse, de tres archivos. Cada capa pisa a la anterior (los objetos se combinan clave por clave; las listas se reemplazan enteras).

| # | Archivo | Para qué | ¿Se commitea? |
| --- | --- | --- | --- |
| 1 | `~/.orca-stack/config.json` | Personal: sirve en todos tus proyectos | — |
| 2 | `<repo>/.orca-stack.json` | Reglas del proyecto, compartidas con el equipo | Sí |
| 3 | `<repo>/.orca-stack.local.json` | Datos locales o sensibles (por ejemplo, destinatarios) | No: `init` lo agrega a `.gitignore` |

`<repo>` es el checkout principal: el mod lo busca con `git rev-parse --git-common-dir`, así que una sesión dentro de un worktree de Orca (`~/orca/workspaces/...`) lee los archivos del checkout principal.

### Claves

| Clave | Quién la usa | Qué hace |
| --- | --- | --- |
| `humano` | `puente-gentle` | Cómo se refiere el puente a la persona ("mostrale a Ana las dos posturas"). Sin valor: "el usuario". |
| `mensajes.destinatarios` | `bandeja-mensajes` | Lista de nombres que Claude conoce para los bloques ` ```mensaje <nombre> `. Sin lista, el mod captura cualquier nombre. |
| `despacho.script`, `despacho.revisar` | `guardia-despacho`, `tablero-despacho` | Rutas (relativas al repo) a tus scripts de despacho y revisión. **Sin `despacho`, la guardia está apagada** y el tablero no muestra los atajos de despacho. |
| `guardia.bloquear` | `guardia-despacho` | Lista de `{ "agente", "hasta", "motivo" }`. Mientras la fecha local `hasta` (AAAA-MM-DD, a las 00:00) no llegue, despacharle algo a ese agente se rechaza con el `motivo`: lo aplican `orca-stack despachar` y `revisar`, y `guardia-despacho` para los scripts de despacho. Las reglas de las tres capas se suman: una capa no puede borrar el bloqueo de otra. |
| `guardia.modeloClaude` | `guardia-despacho` | Modelo obligatorio para `despacho.script ... claude`. Si falta, el mod antepone `CLAUDE_MODELO=<modelo>`; si pasan otro modelo, lo rechaza. Tu script de despacho debe leer `CLAUDE_MODELO`. |

### Ejemplos

`~/.orca-stack/config.json` (la crea `global`):

```json
{
  "humano": "Ana"
}
```

`<repo>/.orca-stack.json` (reglas compartidas; `init` lo crea con `{ "version": 1 }` y el setup completa el resto):

```json
{
  "version": 1,
  "despacho": {
    "script": "scripts/despachar.sh",
    "revisar": "scripts/revisar.sh"
  },
  "guardia": {
    "modeloClaude": "claude-sonnet-5-5"
  }
}
```

Las claves del contrato de trabajo, que escribe `orca-setup` y que el bloque de `AGENTS.md` manda a leer (se fusionan las tres capas, personal → proyecto → local):

| Clave | Qué guarda |
| --- | --- |
| `setup` | `"completo"` cuando el setup ya se hizo |
| `modo` | `"multiagente"` o `"un-agente"` |
| `ramaBase` | La rama contra la que se abren los PRs |
| `agentes` | Qué agentes usa el repo (`usa`) y cuáles necesitan el OK del humano (`preguntarAntes`). Los modelos y esfuerzos (`agentes.modelos`) viven en `~/.orca-stack/config.json`, por máquina |
| `review` | Solo en modo `un-agente`: `"subagente"` (por defecto) o `"humano"` |
| `verificacion` | `{ "suite", "typecheck" }`: los comandos exactos |
| `merge` | Si `main` mergea sola cuando se cumple la condición de merge |
| `despliegue` | `{ "despues": false }`, o el comando y cómo se verifica |
| `idioma` | Idioma del código, los commits y los PRs |
| `riesgo` | Lista de globs de rutas cuyo cambio no se deshace con un revert (migraciones, auth, deploy, dependencias). `puente-gentle` no deja mergear un PR que toca alguna hasta que tenga un review limpio de pi sobre su último commit (`Revisor: pi`, `Commit: <sha>` y `## BLOQUEA` en `nada`, de `orca-stack revisar <n> pi`). Si lo escribió pi, pide dos reviews limpios de dos familias de modelo distintas que no sean la de pi (Claude); la familia sale del modelo de `agentes.modelos`. Un review con bloqueos sobre ese commit frena el merge, y también lo frena que falte la línea `Implementador:` |
| `agentes.pi.claudeConfigDir` | Solo en `~/.orca-stack/config.json`: carpeta de config de Claude con otra cuenta para pi. El puente lanza pi con `CLAUDE_CONFIG_DIR=<carpeta>`, y así pi y `main` no se quedan sin cuota juntos. El login se hace una vez a mano: `$env:CLAUDE_CONFIG_DIR="<carpeta>"; claude` y `/login` |
| `agentes.pi.perfil` | Nombre de un perfil de `~/.pi/gentle-ai/profiles.json` (o `"preguntar"`, el valor por defecto). Con un nombre, todo `despachar`/`revisar` a pi usa ese perfil sin preguntar (el flag `--perfil-pi` gana). Con `"preguntar"` o ausente, `guardia-despacho` pregunta en cada despacho a pi y, sin el mod, rige el perfil activo global |

`<repo>/.orca-stack.local.json` (local, ignorado por git; `init` lo crea vacío):

```json
{
  "mensajes": { "destinatarios": ["Beto", "Carla", "el grupo"] },
  "guardia": {
    "bloquear": [
      { "agente": "codex", "hasta": "2026-10-29", "motivo": "Codex sin cuota: despachá a claude o agy." }
    ]
  }
}
```

## Pasos manuales

Al terminar, `global` imprime la lista con tus rutas exactas. Resumen:

1. **Orca > Settings > Agents > command overrides**: apuntá Claude Code, Codex y Antigravity a `claude-orca-stack`, `codex-orca-stack` y `agy-orca-stack` (en `~/orca/stack/scripts/`). Se configura desde la interfaz de Orca; `orca-stack` no escribe en los datos de Orca.
2. `pi` → `/login` (sin una cuenta conectada, Gentle Shell no responde).
3. `gh auth login`.
4. `gentle-ai sync`.
5. Instalar lo que falte: Orca, engram, gentle-ai y Pi (los comandos oficiales los imprime `global`).
6. Skills de terceros desde su origen (ver abajo).
7. Reiniciar Claude Code.

## Qué NO instala, y por qué

- **Binarios de terceros** (Orca, engram, gentle-ai, Pi, `gh`): son de otros proyectos con su propio ciclo de versiones y firmas. Se detectan y se imprime cómo instalarlos.
- **Las skills de Matt Pocock** (`mattpocock/skills`): es la metodología de ingeniería por defecto del stack (Pi trabaja con la suya) y la mantiene su autor. Se instala desde su origen, con el marketplace del propio Matt (el oficial fija una versión vieja): `claude plugin marketplace add mattpocock/skills` y `claude plugin install mattpocock-skills@mattpocock`, que trae la 1.3.1 con el mismo nombre de plugin, así que `/mattpocock-skills:<skill>` sigue andando. Para agy y codex: `npx skills add mattpocock/skills -g -s '*' -a codex -a antigravity-cli -y`. La 1.3 agrega `pr`, `implement-spec` y `retro`, quita `resolving-merge-conflicts` y solo busca `GLOSSARY.md` (antes `CONTEXT.md`).
- **Caveman** (`JuliusBrussee/caveman`, Apache-2.0): se instala desde su origen, sin fijar versión y solo como skills: `npx skills add JuliusBrussee/caveman -g` (el stack se verificó con la 3.2.0). El comando detecta los agentes que tenés instalados (Claude Code, Codex, Antigravity) y deja las skills en la carpeta de cada uno. En Claude Code ya no arranca sola: la aplica el modo Auto de Orca.
- **Los hooks de ciclo de vida completos de Ponytail y Caveman**: duplicarían el control que ya tienen Orca y los proveedores (ver `ORCA-STACK.md`, sección "Deliberate exclusions").
- **El plugin `ponytail` de Claude Code**: si lo tenés instalado, desactivalo en las sesiones de Orca (`claude plugin disable ponytail@ponytail`), porque Orca trae sus propias skills adaptadas y sus hooks duplican el control de Orca.
- **El plugin `caveman` de Claude Code**: si lo tenés instalado, desactivalo en las sesiones de Orca (`claude plugin disable caveman@caveman`), porque sus hooks inyectan caveman en cada subagente y duplican el control de Orca. Las skills de `npx skills add` alcanzan.
- **Credenciales y datos locales**: nada de `auth.json`, `models.json`, `~/.claude.json`, bases de engram ni datos de la aplicación de Orca.
- **Los datos de la aplicación de Orca**: solo se leen en `doctor`, nunca se escriben.

## Origen y licencias

| Componente | Origen | Licencia |
| --- | --- | --- |
| Este repositorio: CLI, wrappers, mods, `ORCA-STACK.md`, `ROLE-BRIEFS.md`, skill `orca-stack-policy` | Propio | MIT (ver `LICENSE`) |
| Skills `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-help` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), tag `v5.2.0` (commit `2961b52`); el origen exacto y el hash de cada archivo están en `assets/skills/ponytail-upstream.json`. `ponytail` y `ponytail-help` agregan al texto de upstream una sección `## In Orca`; las otras tres son copias textuales. `ponytail-gain` no se incluye: es un tablero del benchmark, no una política de implementación ni un review | MIT, © 2026 DietrichGebert. La nota de licencia viaja en `LICENSE` dentro de cada carpeta de skill |
| Skills `principle-make-operations-idempotent`, `principle-attack-the-premise`, `principle-explain-the-number`, `arena`, `swarm` | [cursor/plugins](https://github.com/cursor/plugins) (`pstack/`, versión `0.15.24`, commit `1e5c90a`); el origen exacto y el hash de cada archivo están en `assets/skills/pstack-upstream.json`. Principios textuales, `arena` y `swarm` adaptadas | MIT, © 2026 Lauren Tan. La nota de licencia viaja en `LICENSE` dentro de cada carpeta de skill |
| `caveman` | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | Apache-2.0. **No se incluye**: se instala desde su origen |
| Matt Pocock skills | [mattpocock/skills](https://github.com/mattpocock/skills) (plugin `mattpocock-skills@mattpocock`) | Según su repo. **No se incluye**: se instala desde su origen |
| Pi | [earendil-works/pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) | Se instala con el instalador oficial |
| `gentle-pi`, `pi-claude-bridge` | Paquetes npm de terceros | Se instalan con `pi install` desde npm |
| engram, gentle-ai | [Gentleman-Programming](https://github.com/Gentleman-Programming) | Solo se detectan |
| Orca | [stablyai/orca](https://github.com/stablyai/orca) | Solo se detecta |

## Desarrollo

```bash
npm test                  # CLI, round-trips en un HOME temporal, chequeo de rutas personales
npm run test:mods         # tests de cada mod con `claude plugin test` (necesita Claude Code)
npm run verify            # suite completa configurada para el repo
npm run sync-shared       # copia shared/orca-config.ts a los mods que lo usan
```

Un plugin de Claude Code solo puede importar archivos de su propia carpeta, y el motor no deja pasar `$` a través de un `import`. Por eso el resolvedor de configuración (`shared/orca-config.ts`) se copia tal cual en cada mod que lo usa y recibe sus operaciones como funciones; un test falla si alguna copia se desfasa.

Los mods se cargan por `CLAUDE_CODE_PLUGIN_DIRS` (carpetas absolutas separadas por el separador de rutas del sistema, tomadas del entorno o del bloque `env` de `~/.claude/settings.json`). La documenta la guía de authoring de plugins de Claude Code (skill `plugin-authoring`); no la encontré en la referencia pública de ajustes.

El job `evidencia` de CI valida que los nombres de test de `## Evidencia` existan antes de que `ci-ok` pase.

## Licencia

MIT, ver [`LICENSE`](./LICENSE).
