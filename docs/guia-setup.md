# Guía de setup: stack de agentes con orca-stack

Esta guía deja una máquina y un proyecto listos para trabajar con el stack de agentes: Orca ejecuta, las skills de Matt Pocock definen el método y orca-stack instala la política, los wrappers, Ponytail y los mods de Claude Code. Tiene dos partes. La de la máquina se hace una sola vez. La del proyecto se hace en cada repo y se guía con un cuestionario que cambia según el proyecto arranque de cero o ya esté empezado.

Versión de referencia: `orca-stack v0.16.1` (octubre de 2026). Si sale una versión nueva, cambiá la etiqueta `#v0.16.1` en los comandos. Lo marcado `UNKNOWN / MUST VERIFY` no está confirmado: verificalo antes de darlo por cierto.

---

## Ruta rápida

1. **Máquina, una sola vez:** `npx github:Gagaismo/orca-stack#v0.16.1 global`, completá los pasos manuales que imprime y verificá con `doctor`.
2. **Proyecto:** respondé el cuestionario de la Parte 2 y seguí el recorrido que te toca: **A** si arrancás de cero, **B** si ya está empezado.
3. **Cierre:** corré la verificación final (Parte 5) y commiteá el setup en una rama propia.

---

## Mapa del stack

| Pieza | Qué hace | Quién la instala |
| --- | --- | --- |
| Orca | Corre los Runs, las Tasks, los worktrees y los workers en paralelo | Instalador oficial (github.com/stablyai/orca) |
| Skills de Matt Pocock | Son el método: grill, spec, tickets, implement con TDD y review | Claude Code: `claude plugin marketplace add mattpocock/skills` y `claude plugin install mattpocock-skills@mattpocock` (versión 1.3.1 o más nueva). Codex y Antigravity: ver la nota debajo |
| orca-stack | Política `ORCA-STACK.md`, wrappers de proveedores, Ponytail y los 8 mods de Claude Code | `npx github:Gagaismo/orca-stack#v0.16.1 global` |
| Gentle Shell (Pi) | Un segundo orquestador al que Claude consulta en las decisiones | Pi con su instalador oficial; los paquetes los instala `global` |
| Engram | Memoria entre sesiones (no planifica ni decide) | Instalador propio de Engram |
| gentle-ai | Context7, permisos de Claude Code y skills extra | Instalador propio de gentle-ai |
| Caveman | Comprime la prosa larga para ahorrar tokens | Solo las skills: `npx skills add JuliusBrussee/caveman -g` (verificado con la 3.2.0). Si tenés el plugin de Claude Code, desactivalo en las sesiones de Orca: `claude plugin disable caveman@caveman` |
| [Impeccable](https://impeccable.style/) (Frontend repos, opcional) | Vocabulario de diseño para agentes (polish, audit, critique, typeset, distill) y detector con 61 checks para defaults de diseño en IA. Licencia: Apache-2.0 | Solo las skills: `npx skills add pbakaus/impeccable`. Instalar solo sus skills, no sus hooks, porque el stack no instala hooks de ciclo de vida de terceros (`ORCA-STACK.md`, "Deliberate exclusions") |
| [Taste Skill](https://www.tasteskill.dev/) (Frontend repos, opcional) | Reglas de diseño frontend para agentes (tipografía, espaciado, color, layout y motion). Licencia: MIT | Solo las skills: `npx skills add Leonxlnx/taste-skill --skill design-taste-frontend` |

Hay una regla que ordena todo lo demás: **las skills de Matt Pocock son el método por defecto**. Gentle Shell (Pi) trabaja con su propio criterio. Orca no planifica, solo ejecuta los tickets que salen de `/to-tickets`. Ponytail achica la implementación pero nunca saca requisitos, validaciones ni tests.

**Nota sobre las skills de Matt:**
- El plugin solo las instala para Claude Code. Si Codex o Antigravity van a usarlas, tienen que estar en `~/.agents/skills`: `npx skills add mattpocock/skills -g -s '*' -a codex -a antigravity-cli -y`.
- Instalá el plugin desde el marketplace del propio Matt (`mattpocock/skills`), no desde el oficial: el oficial fija una versión vieja (1.2.3). Matt publica la 1.3.1 con el mismo nombre de plugin, así que `/mattpocock-skills:<skill>` sigue andando. La 1.3 agrega `pr` (cuerpos de PR con evidencia y riesgo de merge), `implement-spec` (implementa una spec con sus tickets en una rama de integración) y `retro` (mirar las sesiones pasadas y proponer mejoras), quita `resolving-merge-conflicts` y solo busca `GLOSSARY.md` en lugar de `CONTEXT.md`.
- Para alimentar `/retro` con las sesiones de todos los agentes (Claude Code, Pi y agy), corré `orca-stack sesiones`: lista las recientes en un formato compacto (`--desde <AAAA-MM-DD>`, `--limite <n>`).
- Elegí **una sola vía por proveedor**. Si las tenés como plugin y también sueltas en `~/.claude/skills`, quedan duplicadas.
- Casi todas (`/setup-matt-pocock-skills`, `/wayfinder`, `/grill-with-docs`, `/to-spec`, `/to-tickets`, `/triage`, `/implement`) **solo se activan cuando una persona escribe el comando**: un agente no las puede invocar por su cuenta. En Codex se escriben con `$` en vez de `/`.

---

## Parte 1: preparar la máquina (una sola vez)

### Prerrequisitos

- [ ] Node.js 20 o más nuevo (Pi necesita 22.19 o más nuevo).
- [ ] Git y GitHub CLI (`gh`).
- [ ] Claude Code instalado.
- [ ] En Windows, Go 1.25.10 o más nuevo en el `PATH` (el `postinstall` de gentle-pi compila con Go).
- [ ] Orca, Engram, gentle-ai y Pi instalados. Si falta alguno, `global` lo detecta y te imprime el comando oficial.
- [ ] Pi 1.2.0 o más nuevo (gentle-pi 4.2.0 no arranca con uno anterior) y Engram 3.4.0 o más nuevo (con uno anterior, Gentle Shell deja la memoria apagada).

### Instalar

```bash
# 1. Mirá qué va a hacer, sin escribir nada
npx github:Gagaismo/orca-stack#v0.16.1 global --dry-run

# 2. Instalá (--humano fija cómo te nombran los mods; si no, sale de git config user.name)
npx github:Gagaismo/orca-stack#v0.16.1 global --humano "Tu nombre"

# 3. Verificá, parado en la raíz de un proyecto
npx github:Gagaismo/orca-stack#v0.16.1 doctor
```

- `global` respalda todo lo que toca en `~/.orca-stack/backups/<fecha>/` y anota lo que instaló en `~/.orca-stack/state.json`. `remove` lo deshace.
- Si Pi, gentle-pi o pi-claude-bridge faltan o están en otra versión, `global` instala la versión fijada **aunque no uses `--force`** (`pi install npm:gentle-pi@4.2.0`, `npm i -g gentle-pi@4.2.0` y `pi install npm:pi-claude-bridge@0.9.2`). Si querés conservar tus versiones de Pi, agregá `--skip-pi`.
- Si tu Pi es anterior a 1.2.0, `global` no instala gentle-pi y falla: actualizá Pi con el comando oficial que imprime y volvé a correrlo.
- Gentle Shell se actualiza volviendo a correr `global`. Desde gentle-pi 4.2.0, `gentle-shell update` reinstala solo el paquete global dueño del Pi que corre, y si no puede probar qué paquete global es dueño de Pi, no toca nada.
- Al final, `global` sugiere `doctor` e `init` sin la etiqueta de versión. Usalos con `#v0.16.1`.

### Pasos manuales que imprime `global`

1. **Orca > Settings > Agents > command overrides:** apuntá Claude Code, Codex y Antigravity a `claude-orca-stack`, `codex-orca-stack` y `agy-orca-stack` (están en `~/orca/stack/scripts/`).
2. Abrí `pi` y corré `/login`. Sin login, Gentle Shell no responde.
3. Corré `gh auth login` (lo necesitan el tablero de PRs y el puente).
4. Corré `gentle-ai sync`.
5. Instalá las skills de Matt Pocock (Claude Code con el marketplace de Matt y, para agy y codex, `npx skills add mattpocock/skills -g -s '*' -a codex -a antigravity-cli -y`) y Caveman con los comandos del mapa.
6. Reiniciá Claude Code: los mods se cargan en las sesiones nuevas.

Además, instalá lo que `global` marque como faltante.

**Resultado esperado de `doctor`:** **0 fallas** (✖), y cada aviso (⚠) leído y entendido. Es normal ver algún aviso, por ejemplo un perfil de Orca sin override o una versión de Pi más nueva que la probada (una anterior a 1.2.0 es una falla). Corrélo desde la raíz de un proyecto: así también revisa sus `.orca-stack*.json` y que existan sus scripts de despacho.

### Qué hace `global` con el `CLAUDE.md` global

`global` no escribe metodología en `~/.claude/CLAUDE.md`: instala herramientas, skills, mods y wrappers, y nada más. La metodología llega solo por el proyecto (`init`), así que una sesión en un repo sin `.orca-stack.json` no recibe texto del stack; `puente-gentle` tampoco inyecta su instrucción de consulta ni registra `consultar_gentle_shell` ahí. Si una versión anterior dejó en ese archivo el bloque `orca-stack:begin` / `orca-stack:end` (o el viejo `orca-stack:auto`), `global` lo saca, con respaldo, y lo avisa.

**El bloque de gentle-ai.** `~/.claude/CLAUDE.md` trae el bloque `gentle-ai:sdd-orchestrator` (v2/v3) o `gentle-ai:orchestrator` (v4), unos 16 KB que se cargan en cada sesión. `global` lo achica según `gentle.orchestrator` en `~/.orca-stack/config.json`:

- `"lazy"` (por defecto): guarda el bloque completo en `~/.orca-stack/gentle/orchestrator.md` y deja entre los marcadores un puntero corto (con la marca `<!-- orca-stack:gentle-lazy v1 -->`). El puntero dice que ODD es el flujo predeterminado y que la sesión que orquesta (`main`) debe leer la copia completa; también pide presentar completos los menús y pedidos de consentimiento. Hace respaldo, es idempotente, respeta `--dry-run` e imprime los KB ahorrados. Se omite mientras el RDD de gentle-ai esté prendido (el bloque trae su contrato de review): si ya estaba en lazy, `global` lo restaura desde la copia.
- `"full"`: el bloque queda como lo escribe gentle-ai. Si estaba en lazy, `global` lo restaura desde la copia (con respaldo). Con el RDD de gentle-ai apagado (`gentle-ai review mode status` empieza con `receipt-driven development: off`) también recorta sus secciones de review (unos 26 KB); con RDD prendido o sin gentle-ai, lo omite y dice por qué.

**`gentle-ai sync` reescribe el bloque** (reemplaza lo que hay entre los marcadores), así que después de cada sync corré `orca-stack global` de nuevo: refresca la copia y el puntero. `doctor` avisa si la sync lo reescribió, si falta la copia o si sigue en la ruta antigua. Para volver atrás: `"gentle": { "orchestrator": "full" }` y `orca-stack global`, o `gentle-ai sync`; `orca-stack remove` también restaura el bloque completo. La clave vieja `gentle.sddOrchestrator` se acepta y `doctor` recomienda renombrarla; si aparecen ambas, gana `gentle.orchestrator`. `global` mueve la copia antigua a `orchestrator.md`; si están las dos, conserva la más nueva y respalda la otra.

**Pasar a gentle-ai v4 (Windows).** v4 retiró SDD: ODD es su único flujo, y la sync renombra el bloque a `gentle-ai:orchestrator` (mismas secciones de review). orca-stack trata igual los dos nombres; en v4 el puntero dice que ODD es el flujo predeterminado y que la sesión `main` lee la copia completa. Con Go 1.25.10 o más nuevo en el `PATH`:

```powershell
go install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@v4.1.1
gentle-ai sync
npx github:Gagaismo/orca-stack global
```

Después de la sync, `doctor` avisa que el bloque quedó completo; `orca-stack global` refresca la copia con el texto de v4 y vuelve a dejar el puntero.

### Codex en Windows: acentos rotos

codex-cli en Windows lee los archivos con `powershell.exe -Command "Get-Content -Raw <archivo>"`, sin `-NoProfile`. Windows PowerShell 5.1 decodifica el UTF-8 sin BOM como cp1252, así que el modelo ve cada letra acentuada como dos caracteres raros (la `á` de `está` llega como `Ã` seguida de `¡`) y escribe ese mojibake de vuelta (#58). Hay dos arreglos, y conviene tener los dos:

- **La regla ASCII, que escribe `global`.** Solo en Windows, y solo si existe `~/.codex`, `global` agrega a `~/.codex/AGENTS.md` un bloque entre `<!-- orca-stack:codex-ascii:begin -->` y `<!-- orca-stack:codex-ascii:end -->`: el código fuente queda en ASCII y los caracteres no ASCII de los literales van como escapes `\u`. No toca el texto fuera de los marcadores, hace respaldo, es idempotente y respeta `--dry-run`; `remove` saca el bloque y deja el resto del archivo. Si ya tenías una copia de la regla escrita a mano, sin marcadores, `global` no la detecta: sacala vos.
- **La línea del perfil de PowerShell, que agregás a mano.** `global` nunca edita el perfil, porque afecta a todas tus sesiones de PowerShell. Abrí Windows PowerShell 5.1 (no `pwsh`) y agregá esta línea al archivo que muestra `$PROFILE` (si tu carpeta Documentos está en OneDrive, la ruta lo refleja):

  ```powershell
  $PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'
  ```

  Si el archivo no existe: `New-Item -ItemType File -Force $PROFILE` y después `notepad $PROFILE`. Con la política de ejecución en `Restricted` el perfil no se carga: mirala con `Get-ExecutionPolicy -List`.

`doctor`, en Windows y con `codex` en `agentes.usa`, revisa los dos: lee un archivo de prueba con el mismo comando que codex y avisa (nunca falla) con la línea y la ruta del perfil si no vuelve `está`, o con "no se pudo verificar" si `powershell.exe` no está o tarda más de 10 s; y avisa con "corré `orca-stack global`" si falta el bloque. En Linux y macOS, o sin `codex`, no imprime nada de esto.

### Qué va en la configuración personal

`~/.orca-stack/config.json` vale para **todos** tus proyectos, así que ahí va solo lo tuyo: `humano` (cómo te nombran los mods), los modelos y esfuerzos de cada agente (`agentes.modelos`) la cuenta de Claude que usa pi (`agentes.pi.claudeConfigDir`) y, si no querés que te pregunten en cada despacho a pi, el perfil de modelos (`agentes.pi.perfil`). Todo lo que nombra personas, scripts o proveedores de un proyecto (destinatarios de mensajes, scripts de despacho, bloqueos, modelo obligatorio) va en la configuración de **ese** proyecto. Si no, aparece en cada setup nuevo y hay que apagarlo a mano.

### Perfiles de modelos de Pi (despachos a pi)

gentle-pi guarda perfiles de modelos en `~/.pi/gentle-ai/profiles.json` (cada perfil nombra el orquestador y los diez subagentes). `orca-stack despachar|revisar <n> pi` puede fijar uno de ellos solo para el worktree de ese despacho, con `--perfil-pi <nombre>`:

- Escribe `.pi/gentle-ai/profile.json` en el worktree (gentle-pi lo lee en cada lanzamiento de subagente, también en modo `-p`) y lo excluye de git con `<git-common-dir>/info/exclude`.
- Lanza pi con `--model` y `--thinking` del `orchestrator` del perfil, porque un pin nunca mueve al orquestador.
- Se niega si el perfil no existe o si el clon ya tiene un pin local (`<git-common-dir>/gentle-ai/profile-pin.json`) con otro perfil, porque ese gana sobre el del worktree.
- Se niega si el orquestador o algún subagente del perfil usa un modelo que no es `claude-bridge/…`, `anthropic/…` (el login OAuth de Anthropic en pi) ni `openai/…`, y nombra cada agente y modelo. `orca-stack doctor` avisa de cada perfil guardado que rompe esta regla.
- Imprime `perfil de Pi: <nombre> (fuente: flag | config | pin | global)` y el brief guarda la misma línea.
- El perfil global activo no cambia, y las consultas a Gentle Shell (`/pi`, `consultar_gentle_shell`) no usan esto.

Perfiles que conviene tener: `opus-sonnet` (Opus 5.5 orquesta; los diez subagentes en Sonnet 5.5, todos por `claude-bridge`) y `OpusFull` (Opus 5.5 orquesta por `claude-bridge` y los subagentes corren en Opus 5.5 por `anthropic`). Un perfil tiene que listar a **todos** los agentes: si omite uno, ese agente usa el modelo de su frontmatter. Para editarlos: `/gentle:profiles` dentro de Pi, o editar `profiles.json` a mano (copiá el archivo antes).

Quién elige el perfil, en este orden: el flag `--perfil-pi`; en `rebote` y `reanudar`, el pin que ya tiene el worktree; `agentes.pi.perfil` con un nombre, o `"global"` para usar a propósito el perfil activo global; y si falta o vale `"preguntar"`, el mod `guardia-despacho` te lo pregunta (diálogo "Perfil Pi") cuando Claude despacha a pi, y agrega el flag al comando. Si no queda un perfil elegido (cierran el diálogo, `-p`, sin `profiles.json`), el mod niega el comando, y el CLI solo también se niega: un despacho a pi nunca cae al perfil activo global sin que la config lo diga.

### Si la máquina ya tenía una instalación anterior

Pasa si el stack se armó a mano antes de que existiera el instalador. El `--dry-run` lo delata con muchas líneas `⚠ ... ya existe y no es de orca-stack`. Sin `--force`, `global` deja esos archivos como estaban y te queda una mezcla de versiones. Este es el orden seguro:

1. **Anotá los valores que estaban fijos en los mods viejos:** cómo te nombran, a quiénes les mandás mensajes, los scripts de despacho, los proveedores bloqueados y el modelo obligatorio.
2. **Repartilos antes de instalar:**
   - `humano` va en `~/.orca-stack/config.json`. Escribilo a mano antes de `global`: así `global` no lo genera solo y `remove` nunca lo borra.
   - Lo demás va en el proyecto al que pertenece. Lo ideal es su `.orca-stack.json` commiteado. Si todavía no podés commitear en ese repo, usá su `.orca-stack.local.json` de forma provisoria e ignoralo con `.git/info/exclude`, que no toca archivos versionados.
3. **Revisá `~/.claude/CLAUDE.md`.** `global` ya no escribe ahí: la metodología llega por el proyecto, con `init`. Si la instalación vieja dejó una sección "Orca stack integration" sin marcadores, sacala a mano (respaldá el archivo antes); `global` solo saca el bloque que tenga marcadores `orca-stack:begin` / `orca-stack:end`.
4. Corré `global --dry-run --force` y leé la lista completa. Que corra `pi install` o `npm i -g gentle-pi` es esperable si tus versiones no coinciden con las fijadas.
5. Corré `global --force`. Todo lo que reemplaza queda respaldado.
6. **Revisá `CLAUDE_CODE_PLUGIN_DIRS`** en `~/.claude/settings.json`. `global` conserva las entradas que ya había: si un mod viejo vivía en otra carpeta, queda cargado junto al nuevo. Dejá solo los 8 mods de `~/.claude/mods/`.
7. **Revisá si las skills de Matt están duplicadas** (como plugin y sueltas) y dejá una sola vía. `doctor` lo avisa, con el comando `npx skills remove <nombres> -g -a claude-code -y`.
8. **Borrá los instaladores viejos** (por ejemplo, un script que copiaba los mods a mano): si alguien los corre, vuelven a copiar los mods anteriores encima de los nuevos.
9. Corré `doctor`.

> Ojo con `remove` después de un `--force`: no deja la máquina limpia, **restaura la instalación vieja** desde el respaldo. El `~/.claude/CLAUDE.md` no se toca si ya no tiene el bloque.

---

## Parte 2: cuestionario para configurar un proyecto

### Cómo usarlo

- Lo puede recorrer una persona o un agente (en el Apéndice A hay un prompt listo para pegar).
- **Primero se explora el repo y después se pregunta.** Si el repo ya responde una pregunta, se saltea. Por ejemplo, si hay un remoto de GitHub no hace falta preguntar dónde vive el código.
- Se pregunta **de a una**, con la opción recomendada primero, para que se pueda aceptar con un "sí".
- Cada pregunta dice a qué tipo de proyecto aplica: **[Nuevo]**, **[Empezado]** o **[Ambos]**. Algunas dicen "solo si...": salteala si no se cumple la condición.
- Cada respuesta termina en una acción concreta: un archivo, una clave o un comando. No hay preguntas "para saber".

### Versión corta (5 minutos)

Si no hay tiempo para todo, respondé A1, B1, C1, C3, C4 y F1. Con eso alcanza para un primer setup que funcione. El resto se puede completar después.

### Bloque A: punto de partida

**A1. ¿El proyecto arranca de cero o ya está empezado?** [Ambos]
- Por qué importa: decide el recorrido. Uno nuevo se arma en orden. En uno empezado primero hay que hacer inventario y limpiar.
- Opciones: **De cero** (no hay código, o solo un esqueleto recién generado) · **Empezado** (hay código, historial, issues o instrucciones para agentes).
- Acción: de cero, Recorrido A. Empezado, Recorrido B.

**A2. ¿El proyecto tiene repo de git y remoto? ¿Dónde?** [Ambos]
- Por qué importa: `orca-stack init` solo corre dentro de un repo de git. Además, el remoto define el tracker que se propone por defecto.
- Opciones: **GitHub** (recomendada) · GitLab · Sin remoto, solo local.
- Acción: si no hay repo, `git init` y, si va a GitHub, `gh repo create`. La respuesta alimenta B1.

**A3. ¿Qué instrucciones para agentes existen hoy y cuál manda?** [Empezado]
- Por qué importa: `init` escribe un bloque en `AGENTS.md` y en `CLAUDE.md`. Si hay varias fuentes que se contradicen, los agentes eligen al azar.
- Buscá: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.github/copilot-instructions.md`, `docs/agents/`.
- Opciones: **`AGENTS.md` es el contrato, y `CLAUDE.md` y `GEMINI.md` solo lo importan con `@AGENTS.md`** (recomendada: Codex lee `AGENTS.md`) · Mantener archivos separados por proveedor.
- Acción: mové las reglas a `AGENTS.md` y dejá `CLAUDE.md` y `GEMINI.md` como punteros.
- `UNKNOWN / MUST VERIFY`: que Antigravity lea `AGENTS.md` o resuelva el `@AGENTS.md` de `GEMINI.md`.

**A4. ¿Quedaron restos de otros flujos o de instalaciones anteriores?** [Empezado]
- Por qué importa: los métodos que compiten confunden a los agentes, y los bloques viejos del stack se duplican con el nuevo.
- Buscá: carpetas `openspec/` o instrucciones `sdd-*` (Gentle AI SDD), superpowers, gstack, secciones "Orca stack integration" sin marcadores y secciones de verificación con TestSprite (ya no forma parte de la política).
- Acción: para restos personales instalados que `doctor` enumera, revisá la lista y ejecutá `orca-stack global --limpiar-sdd`; el comando solo mueve rutas conocidas a `~/.orca-stack/backups/` y deja intactos los nombres desconocidos. Para restos del repo, decidí explícitamente qué conservar o retirar antes de `init`; no borres datos a ciegas. Los bloques `<!-- orca-stack:auto -->` no hace falta sacarlos: `init` los reemplaza por el bloque actual. En `AGENTS.md` dejá escrito que el método de Matt es el de por defecto.

**A5. ¿Hay trabajo en curso: ramas abiertas, PRs o worktrees de Orca?** [Empezado]
- Por qué importa: si el setup se commitea en la rama de un ticket, se mezcla con ese trabajo.
- Opciones: **Rama aparte desde `main`, por ejemplo `chore/agent-stack-setup`** (recomendada) · En la rama actual, si es el único trabajo abierto.
- Acción: creá la rama antes de tocar archivos.

### Bloque B: método y tracker (Matt Pocock)

**B1. ¿Dónde viven los tickets?** [Ambos]
- Por qué importa: `/to-spec`, `/to-tickets` y `/triage` leen y escriben ahí, y Orca arma el DAG con sus dependencias.
- Opciones: **GitHub Issues** (recomendada si el remoto es GitHub) · GitLab Issues · Markdown local en `.scratch/<feature>/` (proyectos solos y sin remoto) · Otro (Jira, Linear: se describe en un párrafo).
- Acción: `/setup-matt-pocock-skills` escribe `docs/agents/issue-tracker.md`. Con GitHub, confirmá que el repo pueda usar dependencias nativas entre issues ("blocked by"): `/to-tickets`, `/wayfinder` y el DAG de Orca se apoyan en eso. Si no puede, las dependencias se anotan como texto en cada issue.

**B2. ¿Usás las etiquetas de triage por defecto?** [Ambos; solo si la skill `triage` está instalada]
- Por qué importa: si el tracker ya tiene etiquetas propias, `/triage` crearía duplicados.
- Opciones: **Sí: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`** (recomendada) · No, mapear a las que ya existen (solo en proyectos empezados).
- Acción: `docs/agents/triage-labels.md`.

**B3. ¿El dominio es uno solo o hay varios contextos?** [Ambos; solo si hay señales de monorepo: `pnpm-workspace.yaml`, `workspaces` en `package.json` o `packages/*` con código propio]
- Opciones: **Uno solo: un `GLOSSARY.md` y `docs/adr/` en la raíz** (lo que `/setup-matt-pocock-skills` escribe sin preguntar si no hay monorepo) · Varios: un `GLOSSARY-MAP.md` que apunta a un `GLOSSARY.md` por paquete.
- Acción: `docs/agents/domain.md`.

**B4. ¿Qué tan claro está lo que hay que construir?** [Ambos]
- Por qué importa: define con qué skill arranca el trabajo real. La escribe la persona, no el agente.
- Opciones:
  - Idea grande y difusa que no entra en una sesión: **`/grill-with-docs`** primero; si la planificación se va de las manos, **`/wayfinder`** la convierte en un mapa de tickets de decisión. Nunca arranques con `/wayfinder`.
  - Idea clara pero sin los detalles decididos: **`/grill-with-docs`** (entrevista y deja `GLOSSARY.md` y ADRs).
  - Decidido, pero sin spec escrita: **`/to-spec`**.
  - Ya hay una spec acordada: **`/to-tickets`**.
  - [Empezado] Hay un backlog sin ordenar: **`/triage`**.
- Acción: es el primer comando después del setup (último paso del recorrido).

**B5. ¿Hay vocabulario del dominio y decisiones tomadas que no estén escritas?** [Empezado]
- Por qué importa: los agentes respetan lo que está en `GLOSSARY.md` y en los ADRs, no lo que "todos saben".
- Opciones: **Una sesión de `/domain-modeling` con vos, recorriendo el código** (recomendada). La skill construye `GLOSSARY.md` de a poco, a medida que se resuelven términos con una persona, y propone ADRs solo para decisiones que lo valen. No es una siembra automática · Dejarlo para el primer `/grill-with-docs`.
- Si el conocimiento lo tiene otra persona, `/to-questionnaire` arma un cuestionario para que esa persona lo complete.

### Bloque C: toolchain y worktrees

**C1. ¿Qué lenguaje, gestor de paquetes y lockfile usa el proyecto?** [Ambos; en uno nuevo, contestala después de generar el esqueleto]
- Por qué importa: cuando Orca crea un worktree con setup (`worker-start --setup run`), corre `scripts.setup` de `orca.yaml`.
- Ejemplos: npm con `package-lock.json`: `npm ci` · pnpm: `pnpm install --frozen-lockfile`.
- Acción: `orca.yaml` en la raíz (plantillas en el Apéndice B). En Windows usá un solo comando que funcione igual en cmd, PowerShell y bash. Las fuentes no coinciden sobre si un script con `#!` funciona ahí (`UNKNOWN / MUST VERIFY`).

**C2. ¿Vas a compartir carpetas pesadas entre worktrees (por ejemplo `node_modules`)?** [Ambos]
- Por qué importa: Orca **no copia** las `sharedDirectories`: las enlaza con un symlink a la carpeta del checkout principal. Si el setup de C1 reinstala esa carpeta (`npm ci` vacía `node_modules` antes de instalar), cada worktree nuevo puede borrar y reinstalar el `node_modules` del checkout principal, y varios workers de la misma ola lo harían a la vez.
- Opciones:
  - **No compartir, y que cada worktree instale con `npm ci`** (recomendada si vas a correr workers en paralelo; es más lento, pero es seguro).
  - Compartir `node_modules` **sin setup que lo reinstale**. Cuando cambie el lockfile, reinstalás a mano en el checkout principal, sin workers corriendo.
- Acción: `worktree.sharedDirectories` y `scripts.setup` en `orca.yaml`. Nunca compartas una carpeta que el setup borra o reescribe.

**C3. ¿Qué archivos ignorados necesita la app para correr?** [Ambos]
- Ejemplos: `.env`, `.env.local`, credenciales de desarrollo.
- Acción: listalos con rutas literales en `.worktreeinclude`, para que Orca los copie a cada worktree. Agregá en `AGENTS.md` la regla de que los agentes no leen `.env*` (salvo `.env.example`).

**C4. ¿Cuáles son los comandos de test, typecheck, lint y build?** [Ambos]
- Por qué importa: `/implement` y los workers los corren antes de reportar, y son la verificación que nombra el brief. Sin ellos no pueden cumplir "suite completa".
- Acción: escribilos en `AGENTS.md`, en la sección de entrega.

### Bloque D: agentes y despacho

**D1. ¿Qué proveedores van a trabajar y con qué rol?** [Ambos]
- Opciones típicas: Claude Code para coordinar y para implementar lo delicado · Codex para implementar con razonamiento alto · Antigravity para tickets chicos y reviews.
- Acción: dejá el criterio de reparto en `AGENTS.md` o en el brief del coordinator. Los overrides de Orca ya apuntan a los wrappers desde la Parte 1. Si Codex o Antigravity implementan, confirmá que tengan las skills de Matt (ver la nota del mapa).

**D2. ¿Despachás con scripts propios (por ejemplo `scripts/despachar.sh`) en vez de con `orca orchestration`?** [Ambos]
- Por qué importa: el mod `guardia-despacho` solo se enciende si hay `despacho`, y `tablero-despacho` solo muestra sus atajos con esa clave. Además, un worker lanzado por un script propio no tiene el preámbulo de Orca: no tiene `ask` ni `worker_done`.
- Opciones:
  - **No, despacho con `orca orchestration`** (recomendada): no declares nada.
  - Sí: `despacho.script` y `despacho.revisar` en el `.orca-stack.json` del proyecto. El brief del script tiene que decir dónde pregunta el worker (normalmente un comentario en el issue) y cómo cierra (normalmente un PR abierto).
- Con `orca-stack despachar <issue> <agente>` y `orca-stack revisar <pr> <agente>` no hace falta ningún script propio: crean el worktree en Orca, escriben el brief y lanzan el agente (probalos con `--dry-run`).
- No pongas `despacho` en la capa personal aunque uses los mismos nombres en varios repos: aparecería en todos tus proyectos y tendrías que apagarlo con `"despacho": null` en cada uno que no lo usa.

**D3. ¿Hay algún proveedor sin cuota o vetado por un tiempo?** [Ambos; solo si D2 = Sí]
- Por qué importa: la guardia solo revisa las llamadas a tus scripts de despacho. Sin `despacho`, esta clave no hace nada, y nunca frena un despacho hecho con `orca orchestration`.
- Acción: `guardia.bloquear` con `{ "agente", "hasta", "motivo" }`. `hasta` es excluyente: el bloqueo se levanta a las 00:00 de ese día. Si es una cuota de tu cuenta, ponelo en tu config personal (`~/.orca-stack/config.json`), que vale en todos los repos; si es una regla del proyecto, en `.orca-stack.json`.
- Las reglas de `guardia.bloquear` de las tres capas se suman: una capa no puede borrar el bloqueo de otra. Las demás listas sí se reemplazan.

**D4. ¿Los Claude que implementan tienen que ir con un modelo fijo?** [Ambos; solo si D2 = Sí]
- Acción: `guardia.modeloClaude` en `.orca-stack.json`. Tu script de despacho tiene que leer `CLAUDE_MODELO`.

### Bloque E: personas y comunicación

Cómo te nombran los agentes (`humano`) es de la máquina, no del proyecto: se fija en la Parte 1 con `--humano`.

**E1. ¿A quiénes les vas a mandar mensajes que redacte Claude desde este proyecto?** [Ambos]
- Por qué importa: `bandeja-mensajes` captura los bloques ` ```mensaje <nombre> ` para copiarlos o guardarlos, y le dice a Claude qué nombres conocés. Sin lista, igual captura cualquier nombre.
- Opciones: **Nadie en particular:** no declares nada (`init` deja `.orca-stack.local.json` vacío) · **Gente de este proyecto:** `mensajes.destinatarios` en `.orca-stack.local.json`, nunca en el commiteado, porque son nombres reales.
- Los destinatarios de un proyecto no van en la capa personal: aparecerían en todos los demás.

**E2. ¿Trabaja más gente en el repo con este stack?** [Ambos]
- Acción: lo compartido se commitea (`AGENTS.md`, `.orca-stack.json`, `docs/agents/`, `orca.yaml`). Cada persona corre `global` en su máquina y tiene su propio `config.json` y `.orca-stack.local.json`.

### Bloque F: dominio, datos y límites

**F1. ¿El proyecto maneja datos sensibles (salud, finanzas, datos personales)?** [Ambos]
- Acción: reglas explícitas en `AGENTS.md`: nada de datos reales en logs, analytics, crash reports, fixtures ni servicios de terceros; nada de secretos en commits. Ejemplo: una app de salud prohíbe dar consejos médicos y mandar datos de salud a terceros.

**F2. ¿Qué no debe leer ni tocar nunca un agente?** [Ambos]
- Ejemplos: `.env*`, `*.pem`, `*.key`, `secrets/`, migraciones ya aplicadas, carpetas generadas.
- Acción: sección de seguridad en `AGENTS.md`. Ojo: los permisos de gentle-ai solo protegen a Claude Code. Para Codex y Antigravity, esa regla escrita es la única barrera.

**F3. ¿En qué idioma va cada cosa?** [Ambos]
- Opciones: **Código, comentarios, tests, issues y docs técnicas en inglés; la UI en el idioma del usuario** (recomendada) · Todo en un solo idioma.
- Acción: sección de idioma en `AGENTS.md`. Los IDs y valores de enums se mantienen estables y en inglés.

**F4. ¿Qué librerías y frameworks son clave?** [Ambos]
- Acción: nombralos en `AGENTS.md`, en conocimiento externo: sus APIs se consultan en Context7, y lo que no se pueda confirmar se marca `UNKNOWN / MUST VERIFY`.

**F5. ¿Hay fuentes que hoy se contradicen (README viejo, wiki, issues desactualizados)?** [Empezado]
- Acción: escribí en `AGENTS.md` la jerarquía de verdad: código, después ADRs, después `GLOSSARY.md` y `docs/agents/`, después la spec, después el ticket, después Engram y por último la conversación.

### Bloque G: ejecución con Orca

**G1. ¿Vas a ejecutar tickets en paralelo con Orca desde el principio?** [Ambos]
- Opciones: **Sí** (recomendada si hay más de 3 o 4 tickets independientes) · Más adelante.
- Acción: agregá `docs/agents/orchestration.md` (cómo se comporta un worker sin nadie mirando: escala, no espera) y `docs/agents/orca-dag.md` (cómo pasar de `/to-tickets` a `task-create --deps`), adaptados al tracker de B1. Las plantillas están en el Apéndice B. Si elegís paralelo, revisá C2.

**G2. ¿Cómo se integra el trabajo?** [Ambos]
- Opciones: **Una rama de integración por feature, con un PR al final** (recomendada) · Un PR por ticket directo a `main`.
- Acción: dejalo escrito en `docs/agents/orca-dag.md`.

---

## Parte 3: los dos recorridos

En los dos, los comandos de Matt (`/setup-matt-pocock-skills`, `/wayfinder`, etc.) los escribís vos en la sesión. Un agente puede preparar los borradores, pero no puede lanzar esas skills.

### Recorrido A: proyecto desde cero

1. **Repo:** `git init`, el esqueleto de la app y `gh repo create` (A2).
2. **Contrato:** creá `AGENTS.md` a partir de la plantilla del Apéndice B, con las respuestas de C4 y del bloque F. **Todavía no crees `CLAUDE.md`.**
3. **Método:** escribí `/setup-matt-pocock-skills` (B1 a B3). Como todavía no hay `CLAUDE.md`, la skill escribe su sección en `AGENTS.md`, que es lo que querés.
4. **Punteros:** creá `CLAUDE.md` y `GEMINI.md` con una sola línea: `@AGENTS.md`.
5. **orca-stack:** `npx github:Gagaismo/orca-stack#v0.16.1 init`. A `CLAUDE.md` le pone un bloque corto, y el bloque completo, con el contrato de trabajo, va en `AGENTS.md`. Además crea `.orca-stack.json`, un `.orca-stack.local.json` vacío y la línea en `.gitignore`.
6. **Config de los mods:** completá los dos `.orca-stack*.json` con las respuestas de D y E. Si no despachás con scripts y no tenés destinatarios, no hay nada que agregar.
7. **Worktrees:** creá `orca.yaml` y `.worktreeinclude` (C1 a C3).
8. **Orquestación:** agregá `docs/agents/orchestration.md` y `orca-dag.md` (G).
9. **Verificación:** hacé la Parte 5.
10. **Commit:** `chore: set up agent stack`.
11. **Arranque:** escribí el comando que salió de B4 (normalmente `/grill-with-docs`).

### Recorrido B: proyecto ya empezado

1. **Rama:** creá una rama aparte desde `main` (A5).
2. **Inventario:** listá todas las instrucciones para agentes y los restos de otros flujos (A3 y A4). Mirá cada diff antes de tocar nada.
3. **Limpieza:** sacá los bloques viejos y los métodos que compiten, con commit aparte o `git stash`. No borres a ciegas.
4. **Consolidación:** dejá `AGENTS.md` como contrato y `CLAUDE.md` y `GEMINI.md` como `@AGENTS.md`. Las reglas que valgan solo para Claude pueden quedar en `CLAUDE.md`. `init` le pone un bloque corto con `@AGENTS.md` si todavía no lo importa: Claude Code deja de leer `AGENTS.md` por su cuenta en cuanto existe un `CLAUDE.md`.
5. **Método:** escribí `/setup-matt-pocock-skills`. La skill edita `CLAUDE.md` si existe. Cuando te muestre el borrador, pedile explícitamente que lo escriba en `AGENTS.md` (o movelo vos después), para que Codex también lo lea. Respeta lo que ya haya en `docs/agents/`.
6. **Dominio:** una sesión de `/domain-modeling` con vos sobre el código (B5).
7. **orca-stack:** primero `init --dry-run` y después `init`. Si avisa marcadores duplicados o incompletos, arreglalos a mano y volvé a correrlo.
8. **Config de los mods:** respuestas de D y E. Si el repo se inicializó con la v0.1.0, su `.orca-stack.local.json` puede tener un `"destinatarios": []` que conviene sacar.
9. **Worktrees:** armá `orca.yaml` y `.worktreeinclude` con el toolchain real (C1 a C3), y probalo creando un worktree desde Orca.
10. **Orquestación:** `docs/agents/orchestration.md` y `orca-dag.md` (G).
11. **Backlog:** escribí `/triage` para ordenar los issues abiertos (B4).
12. **Verificación y entrega:** la Parte 5, un commit `chore: set up agent stack` y un PR.

---

## Parte 4: configuración de los mods, dónde va cada cosa

### Las tres capas

| # | Archivo | Para qué | ¿Se commitea? |
| --- | --- | --- | --- |
| 1 | `~/.orca-stack/config.json` | Personal: vale en todos tus proyectos. Solo lo tuyo | No (está fuera del repo) |
| 2 | `<repo>/.orca-stack.json` | Reglas del proyecto, compartidas con el equipo | Sí |
| 3 | `<repo>/.orca-stack.local.json` | Datos locales, sensibles o temporales de este repo | No: `init` lo agrega a `.gitignore` |

### Reglas de combinación

- Cada capa pisa a la anterior. **Los objetos se combinan clave por clave; las listas se reemplazan enteras.**
- Una lista vacía también pisa: `"destinatarios": []` en el local reemplaza la lista de las otras capas.
- `null` apaga una clave heredada: `"despacho": null` apaga la guardia y los atajos del tablero en ese repo.
- Sin `despacho`, `guardia-despacho` no aplica `guardia.bloquear` ni `guardia.modeloClaude`; `orca-stack despachar` y `revisar` aplican `guardia.bloquear` igual. La protección de worktrees (rechaza `orca worktree rm` y `git worktree remove` si la rama tiene commits que no están en ningún remoto) no depende de `despacho`.
- Una sesión dentro de un worktree de Orca lee la configuración del checkout principal.
- `doctor` combina las tres capas igual que los mods y avisa si un script de `despacho` no existe.

### Claves

| Clave | Mod | Dónde va |
| --- | --- | --- |
| `humano` | puente-gentle | Personal |
| `mensajes.destinatarios` | bandeja-mensajes | `.orca-stack.local.json` del proyecto |
| `despacho.script`, `despacho.revisar` | guardia-despacho, tablero-despacho | `.orca-stack.json` del proyecto |
| `guardia.bloquear` | guardia-despacho, despachar, revisar | Tu config personal si es una cuota de tu cuenta; `.orca-stack.json` si es regla del proyecto. Las capas se suman |
| `guardia.modeloClaude` | guardia-despacho | `.orca-stack.json` del proyecto |
| `riesgo` | puente-gentle | `.orca-stack.json` del proyecto: globs de las rutas cuyo cambio no se deshace con un revert. Un PR que toca alguna no se mergea sin un review limpio de pi sobre su último commit (`orca-stack revisar <n> pi`). Si lo escribió pi, hacen falta dos reviews de dos familias de modelo distintas que no sean la de pi (Claude); la familia sale del modelo de `agentes.modelos` |
| `agentes.pi.claudeConfigDir` | puente-gentle | Personal. Carpeta de config de Claude con otra cuenta para pi; el puente lanza pi con `CLAUDE_CONFIG_DIR=<carpeta>`. El login se hace una vez a mano: en PowerShell, `$env:CLAUDE_CONFIG_DIR="<carpeta>"; claude` y después `/login` |
| `agentes.pi.perfil` | guardia-despacho, despachar, revisar | Personal (recomendado). Nombre de un perfil de `~/.pi/gentle-ai/profiles.json`, o `"preguntar"` (por defecto). Con un nombre, los despachos a pi usan ese perfil sin preguntar; con `"preguntar"` o ausente, `guardia-despacho` abre el diálogo "Perfil Pi" y agrega `--perfil-pi <elegido>` al comando |
| `verificacion` | contrato | `.orca-stack.json`: `{ "suite": "...", "typecheck": "...", "cuerpoPR": "..." }`. `cuerpoPR` define el comando con placeholder `{file}` para pre-validar localmente el cuerpo del PR antes de crearlo; la columna Test de `## Evidencia` acepta títulos exactos declarados en `test()`/`it()`, describe paths aceptados por su último segmento y patrones de template, con verificaciones sin test como texto plano sin backticks |

---

## Parte 5: verificación final

- [ ] `npx github:Gagaismo/orca-stack#v0.16.1 doctor`, corrido **desde la raíz del proyecto**, termina con `0 fallas` y cada aviso está entendido.
- [ ] `AGENTS.md` tiene **un solo** bloque `orca-stack:begin` / `orca-stack:end`, sin restos de `orca-stack:auto`.
- [ ] `CLAUDE.md` y `GEMINI.md` importan `AGENTS.md`.
- [ ] `AGENTS.md` nombra los comandos de test y typecheck (C4).
- [ ] `git check-ignore -v .orca-stack.local.json` confirma que está ignorado.
- [ ] `~/.orca-stack/config.json` no tiene nada de este proyecto (solo `humano`, `agentes.modelos`, `agentes.pi.claudeConfigDir` y `agentes.pi.perfil`).
- [ ] Existen `docs/agents/issue-tracker.md` y `docs/agents/domain.md`, y `triage-labels.md` si usás `/triage`.
- [ ] Orca crea un worktree y el setup de `orca.yaml` termina sin errores, sin tocar el `node_modules` del checkout principal.
- [ ] En una sesión nueva de Claude Code aparecen los mods (por ejemplo `/tablero` y `/pi`).
- [ ] `git diff --cached` no tiene secretos, `.env` ni datos reales.

`doctor` avisa si `AGENTS.md` o `CLAUDE.md` todavía tienen el bloque viejo `orca-stack:auto` y si `.orca-stack.json` no tiene `"setup": "completo"` (en ese caso, abrí una sesión de Claude en el checkout principal: ofrece el setup con `orca-setup`). También avisa de la deriva: el plugin de Matt por debajo de 1.3.1, skills duplicadas entre el plugin y `~/.claude/skills`, `pr`, `implement-spec` o `retro` ausentes de `~/.agents/skills` el bloque orca-stack viejo que sigue en `~/.claude/CLAUDE.md` y las secciones de review de gentle-ai que volvieron ahí con RDD apagado. No revisa el resto de `AGENTS.md` ni `orca.yaml`: esos puntos se miran a mano.

---

## Parte 6: problemas comunes

| Síntoma | Causa | Arreglo |
| --- | --- | --- |
| `Hay más de un bloque orca-stack:begin` | Bloque duplicado a mano | Dejá uno solo y volvé a correr el comando |
| Dos secciones "Orca stack integration" con formatos distintos | Instalación anterior (`orca-stack:auto` o sección sin marcadores) | Sacá la vieja con stash o commit aparte, o envolvela con los marcadores antes de `global` / `init` |
| Muchos `⚠ ya existe y no es de orca-stack` | Instalación previa hecha a mano | Seguí "Si la máquina ya tenía una instalación anterior" (Parte 1) |
| Los mods no aparecen | Claude Code no se reinició, o falta la ruta en `CLAUDE_CODE_PLUGIN_DIRS` | Reiniciá y corré `doctor` |
| Un mod viejo y uno nuevo cargan a la vez | `CLAUDE_CODE_PLUGIN_DIRS` conserva entradas viejas | Dejá solo las 7 carpetas de `~/.claude/mods/` |
| Un agente no puede correr `/setup-matt-pocock-skills` (u otra skill de Matt) | Esas skills solo se activan cuando una persona escribe el comando | Escribilo vos en la sesión |
| Gentle Shell no responde | Falta el login de Pi | `pi`, después `/login` |
| `pi install` de gentle-pi falla en Windows | Falta Go o la versión es vieja | Instalá Go 1.25.10 o más nuevo y ponelo en el `PATH` |
| La guardia no bloquea nada | No hay `despacho` en ninguna capa (está apagada a propósito), se despachó con `orca orchestration`, o la fecha `hasta` ya pasó | Declarale `despacho` en el proyecto, o revisá `guardia.bloquear` en las tres capas |
| Aparecen destinatarios o atajos de despacho de otro proyecto | Están en la capa personal | Movelos al `.orca-stack*.json` del proyecto que los usa |
| Claude dejó de conocer a tus destinatarios en un repo | Repo inicializado con la v0.1.0: su `.orca-stack.local.json` trae `"destinatarios": []` | Sacá esa clave |
| El `node_modules` del checkout principal se borra o se rompe cuando arrancan workers | `node_modules` compartido (symlink) más un setup que lo reinstala (`npm ci`) | Elegí una de las dos opciones de C2 |
| El setup de `orca.yaml` falla en Windows | Corre en `cmd.exe` | Un solo comando neutral, por ejemplo `npm ci` |
| Los mods volvieron a una versión vieja | Corrió un instalador viejo | Borralo y corré `global` (con `--force` solo si se perdió `~/.orca-stack/state.json`) |

---

## Apéndice A: prompt para que un agente haga el setup

Pegalo en una sesión de Claude Code (o en Codex, cambiando `/` por `$` en las skills), abierta en la raíz del proyecto:

```text
Vas a configurar este repo con el stack de agentes orca-stack, siguiendo la guía
"Guía de setup: stack de agentes con orca-stack" (pegada abajo o en <ruta>).

1. Explorá antes de preguntar: git remote, AGENTS.md / CLAUDE.md / GEMINI.md,
   docs/agents/, GLOSSARY.md, docs/adr/, lockfiles, .gitignore, .env.example,
   orca.yaml, restos de otros flujos (openspec/, sdd-*, orca-stack:auto) y ramas abiertas.
2. Decidí con A1 si es el Recorrido A (desde cero) o B (empezado) y decímelo con la evidencia.
3. Hacé las preguntas del cuestionario de a una, con la opción recomendada primero.
   Salteá las que el repo ya responde y las condicionales que no aplican, y decime qué encontraste.
   Si estoy apurado, hacé solo la versión corta (A1, B1, C1, C3, C4, F1).
4. Con las respuestas, mostrame un borrador de cada archivo que vas a crear o tocar.
   No escribas nada hasta que lo confirme.
5. Seguí el recorrido elegido paso a paso, en una rama propia. Antes de cada comando
   que modifica archivos (init, global), corré su --dry-run.
6. Nada de este proyecto va en ~/.orca-stack/config.json: destinatarios, despacho y
   guardia van en los .orca-stack*.json del repo.
7. Las skills de Matt (/setup-matt-pocock-skills, /wayfinder, /grill-with-docs, /to-spec,
   /to-tickets, /triage) no las podés lanzar vos: cuando toque una, avisame cuál
   escribir y con qué respuestas ya acordadas.
8. Terminá con la verificación de la Parte 5 y reportá: qué cambió, archivos tocados,
   resultado de doctor, rama y commit, y qué quedó pendiente.
```

---

## Apéndice B: plantillas

### `AGENTS.md` mínimo

```markdown
# Agent guide

## Engineering method

This repo uses Matt Pocock's engineering skills as the default process authority:

`/grill-with-docs` -> `/domain-modeling` -> `GLOSSARY.md` + ADRs -> `/to-spec` ->
`/to-tickets` -> `/implement` (TDD) -> `/code-review` -> commit

- Planning ends at `/to-tickets`. `/implement` does not re-debate the plan; if the
  ticket is wrong, escalate instead of reinterpreting it.
- Do not start or propose retired Gentle AI workflow flows, superpowers, or gstack planning/review
  flows unless the human asks for them explicitly.
- Parallel execution is handled by Orca. See `docs/agents/orca-dag.md`.

## Source of truth

1. Current code  2. ADRs (`docs/adr/`)  3. `GLOSSARY.md` and `docs/agents/*`
4. Spec  5. Ticket  6. Engram memory  7. Conversation history

## External knowledge

- Library and framework APIs (<key libraries>): Context7.
- If nothing confirms something, write `UNKNOWN / MUST VERIFY` instead of guessing.

## Running unattended

Before asking a blocking question, read `docs/agents/orchestration.md`.
Inside an Orca worker, never wait on stdin.

## Delivery

- Tests: `<command>` · Typecheck: `<command>` · Lint: `<command>`
- Strict TDD for implementation tickets; full suite before reporting completion.
- Conventional Commits.

## Security

Do not read `.env*` (except `.env.example`), `*.pem`, `*.key`, `secrets/`, or
credential files. Ask for the specific value you need.

## Language

Code, comments, tests, issues, and technical docs in English. UI copy in <language>.
```

`orca-stack init` le agrega al final el bloque `orca-stack:begin` / `orca-stack:end`, y `/setup-matt-pocock-skills` la sección de issue tracker, labels y domain docs.

### `CLAUDE.md` y `GEMINI.md`

```markdown
@AGENTS.md
```

### `orca.yaml`

Opción segura para workers en paralelo (cada worktree instala lo suyo):

```yaml
# orca.yaml (repo root)
scripts:
  # Runs when Orca creates a worktree with setup. On Windows it runs under
  # cmd.exe, so keep it one shell-neutral command.
  setup: npm ci
```

Opción rápida (todos comparten el `node_modules` del checkout principal; sin setup que lo reinstale):

```yaml
# orca.yaml (repo root)
worktree:
  # Symlinked (not copied) into each worktree. Never let a setup step wipe it.
  # Reinstall it by hand in the primary checkout when the lockfile changes.
  sharedDirectories:
    - node_modules
```

Con pnpm, el setup de la opción segura es `pnpm install --frozen-lockfile`.

### `.worktreeinclude`

```text
# Gitignored files copied (not linked) into each new Orca worktree.
# Literal paths only. The app needs these; agents must not read them.
.env
.env.local
```

### `.orca-stack.json` (se commitea)

Proyecto que despacha con `orca orchestration` (lo que crea `init`):

```json
{
  "version": 1
}
```

Proyecto con scripts de despacho propios y modelo fijo:

```json
{
  "version": 1,
  "despacho": { "script": "scripts/despachar.sh", "revisar": "scripts/revisar.sh" },
  "guardia": { "modeloClaude": "claude-sonnet-5-5" }
}
```

### `.orca-stack.local.json` (no se commitea)

Vacío (lo que crea `init`):

```json
{}
```

Destinatarios de este proyecto y un bloqueo temporal (el bloqueo solo actúa si el proyecto declara `despacho`):

```json
{
  "mensajes": { "destinatarios": ["Nombre 1", "Nombre 2", "el grupo"] },
  "guardia": {
    "bloquear": [
      { "agente": "codex", "hasta": "2026-10-29", "motivo": "Codex sin cuota: despachá a claude o agy." }
    ]
  }
}
```

### `~/.orca-stack/config.json` (personal)

```json
{
  "humano": "Tu nombre"
}
```

### `docs/agents/orchestration.md`

```markdown
# Orchestration

How engineering skills behave when this repo runs inside Orca.

## Attendance

- Orca worker: the prompt has an injected Orca preamble with a Task ID and a
  Dispatch ID. Treat the session as unattended. Nobody is watching this terminal.
- Orca coordinator: attended by the user through the coordinator.
- Anything else: attended. Ask questions normally, one at a time.

## Escalation (unattended only)

- Never wait on stdin or open a local question UI.
- For a blocking question, use the exact `ask` command from the injected preamble,
  with concrete options and the recommended one first. On timeout, resume the same
  question with `--resume <message_id>`.
- Non-blocking doubts: pick the option most consistent with ADRs and `GLOSSARY.md`,
  note it in the commit body and the `worker_done` summary, and continue.
- If the ticket contradicts an ADR, do not reinterpret it: escalate, or finish
  with `--outcome failed` and explain why.

## Completion

- One ticket per worker: `/implement` -> TDD -> full suite -> `/code-review` -> commit.
- Send `worker_done` exactly once with a three-sentence summary, then stay idle.
- Completion does not close the ticket; the merged PR does.

## Out of scope for workers

Re-planning or creating tickets, and merging other workers' branches.
```

Si despachás con scripts propios (D2 = Sí), esos workers no tienen preámbulo, `ask` ni `worker_done`: el brief del script reemplaza las secciones de escalamiento y cierre (dónde preguntar y cómo cerrar).

`UNKNOWN / MUST VERIFY`: `/implement` solo se activa si alguien lo escribe. Confirmá que el worker la cargue cuando el `--spec` de la Task la nombra; si no, el `--spec` tiene que empezar con `/implement`.

### `docs/agents/orca-dag.md`

Para tickets en Markdown local. Con GitHub Issues, reemplazá las rutas de `.scratch/` por los números de issue y leé las dependencias con `gh issue view`.

````markdown
# From `/to-tickets` to an Orca DAG

Orca does not plan. It receives the tickets `/to-tickets` already produced and runs the frontier.

| Who | Decides |
| --- | --- |
| Matt skills (`/to-spec`, `/to-tickets`) | What units exist and what blocks what |
| Orca coordinator | Who runs each unit and when (ready frontier) |
| Worker + `/implement` | How each unit is built |

## 1. Input

```text
Spec: <path or issue>
Integration branch: feat/<feature-slug>

01 blocked_by=[]
02 blocked_by=[]
03 blocked_by=[01]
04 blocked_by=[01,02]
```

## 2. Create every Task before the first wait

One Task per ticket. `--deps` takes Orca task IDs returned by earlier `task-create`
calls, not ticket numbers, so create blockers first.

```text
orca orchestration run-create --objective "Feature <slug>: tickets 01-04" --json
orca orchestration task-create --spec "<spec for 01>" --json                  # -> T01
orca orchestration task-create --spec "<spec for 02>" --json                  # -> T02
orca orchestration task-create --spec "<spec for 03>" --deps '["T01"]' --json
orca orchestration task-create --spec "<spec for 04>" --deps '["T01","T02"]' --json
orca orchestration task-list --ready --brief --json
```

On Windows PowerShell 5.1, pass `--deps '[\"T01\"]'`.

Each `--spec` is self-contained:

```text
Ticket: <path or issue> (read it in full first)
Change: implement the ticket with /implement (TDD, full tests, /code-review, commit)
Constraints: follow AGENTS.md and docs/agents/orchestration.md; ADRs win over the ticket
Ownership: only the files needed for this ticket, on this worktree's branch
Observable acceptance: the ticket's acceptance criteria checked, test suite green, one commit
```

## 3. Run a wave

```text
orca orchestration worker-start --task T01 --worktree new-top-level --name <slug>-01 --base-branch feat/<slug> --agent codex --setup run --json
orca orchestration worker-start --task T02 --worktree new-top-level --name <slug>-02 --base-branch feat/<slug> --agent claude --setup run --json
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

Product or architecture questions go to the human; the coordinator never invents the answer.

## 4. Integrate before the next wave

1. Merge each succeeded worker branch into `feat/<slug>`.
2. Run the full test suite on `feat/<slug>`.
3. Only then start the newly ready Tasks, again with `--base-branch feat/<slug>`.

## 5. Finish

All Tasks settled and merged, full validation on `feat/<slug>`, then open the PR.
Tickets close on merge.
````

---

## Apéndice C: ejemplo, app móvil ya empezada

| Pregunta | Respuesta | Dónde quedó |
| --- | --- | --- |
| A1 | Empezado: app con historial, issues y una instalación anterior del stack | Recorrido B |
| A4 | Bloques `orca-stack:auto` viejos en `AGENTS.md`, `CLAUDE.md` y `GEMINI.md` | `init` los reemplazó por el bloque actual |
| B1 | GitHub Issues con dependencias nativas | `docs/agents/issue-tracker.md` |
| B3 | Un solo contexto | `GLOSSARY.md` + `docs/adr/` |
| C1 y C2 | npm; antes compartía `node_modules` y además corría `npm ci` | `orca.yaml` sin `sharedDirectories`, con `setup: npm ci` |
| C3 | `.env`, `.env.local` | `.worktreeinclude` |
| D2 | Sin scripts de despacho (se despacha con `orca orchestration`) | Nada que declarar |
| E1 | Nadie en particular | `.orca-stack.local.json` vacío |
| F1 | Datos de salud: nada de diagnóstico ni dosis, y ningún dato a terceros | `AGENTS.md`, límites de producto |
| F3 | Técnico en inglés, UI en español | `AGENTS.md`, idioma |
