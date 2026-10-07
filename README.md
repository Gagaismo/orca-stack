# orca-stack

Instala de una vez el stack de agentes que uso para trabajar con [Orca](https://github.com/stablyai/orca): la política del stack, las skills propias, los wrappers de proveedores, Pi con Gentle Shell y los mods de Claude Code. Todo en un comando, con respaldo de lo que toca y con vuelta atrás.

```bash
npx github:Gagaismo/orca-stack#v0.4.0 global     # instalación a nivel usuario
npx github:Gagaismo/orca-stack#v0.4.0 init       # cablea el proyecto actual
npx github:Gagaismo/orca-stack#v0.4.0 doctor     # verifica que todo funcione de verdad
npx github:Gagaismo/orca-stack#v0.4.0 remove     # deshace lo que instaló global
npx github:Gagaismo/orca-stack#v0.4.0 sesiones   # lista las sesiones recientes de Claude, Pi y agy (para `/retro`)
npx github:Gagaismo/orca-stack#v0.4.0 despachar 12 agy   # desde el checkout principal: despacha el ticket #12 al agente
npx github:Gagaismo/orca-stack#v0.4.0 revisar 15 pi      # despacha el review del PR #15
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
| Bloque `<!-- orca-stack:begin -->` … `<!-- orca-stack:end -->` que apunta a la política. Con el RDD de gentle-ai apagado, también recorta de ese archivo las secciones de review que gentle-ai escribe (ver abajo) | `~/.claude/CLAUDE.md` |
| Pi: `gentle-pi@4.0.0` y `pi-claude-bridge@0.9.1` con `pi install`, más `npm i -g gentle-pi@4.0.0` (comando `gentle-shell`) | `~/.pi/agent/` y npm global |
| Registro de lo instalado, para `remove` | `~/.orca-stack/state.json` |
| Capa personal de configuración | `~/.orca-stack/config.json` |

Los wrappers se llaman distinto del binario real a propósito: así nunca se llaman a sí mismos. Cada uno fija los marcadores `ORCA_STACK_*`, busca el binario real en el `PATH`, pasa los argumentos tal cual y devuelve su código de salida.

El bloque de `CLAUDE.md` y todo lo que está fuera de los marcadores se respeta: `global` solo reemplaza lo que hay entre `orca-stack:begin` y `orca-stack:end`. Lo mismo hace con `settings.json`: solo suma sus carpetas a `CLAUDE_CODE_PLUGIN_DIRS` (con el separador de tu sistema), conserva las que ya había y no toca ninguna otra clave.

Con el desarrollo guiado por recibos (RDD) de gentle-ai apagado (`gentle-ai review mode status` dice `off`), las secciones de review del bloque `gentle-ai:sdd-orchestrator` de `~/.claude/CLAUDE.md` no hacen nada y se cargan igual en cada sesión (unos 26 KB). `global` las saca, con respaldo, e imprime cuántos KB ahorró. Si RDD está prendido, o gentle-ai no está instalado, se omite el paso y dice por qué. `gentle-ai sync` las vuelve a escribir: después de cada sync hay que correr `orca-stack global` de nuevo, y `doctor` avisa si volvieron.

### Los mods

Son plugins de Claude Code que se recargan en caliente (`.claude-plugin/plugin.json` + `hooks/`). Se activan con la variable `CLAUDE_CODE_PLUGIN_DIRS`, que `global` completa por vos; se cargan en las sesiones que abras después.

| Mod | Qué hace | Config |
| --- | --- | --- |
| `tablero-despacho` | Tablero de PRs abiertos con checks, review y worktrees (`/tablero`). Usa `gh`. | Los atajos de despacho aparecen solo si hay `despacho` |
| `guardia-despacho` | Bloquea o corrige las llamadas a tus scripts de despacho y revisión según reglas del proyecto. Siempre activo, con o sin `despacho`: rechaza `orca worktree rm` y `git worktree remove` si la rama de ese worktree tiene commits que no están en ningún remoto, porque `orca worktree rm` borra también la rama local. Si no puede resolver la rama, rechaza | Las reglas de despacho están **apagadas** salvo que haya `despacho` |
| `puente-gentle` | Consulta a Gentle Shell (Pi) como otro orquestador par (`/pi`, `/gentle`). Frena el merge de un PR grande sin consulta y el de uno que toca `riesgo` sin sus reviews limpios (de pi, o de dos familias de modelo que no sean la de pi si el PR lo escribió pi) | `humano`, `riesgo`, `agentes.pi.claudeConfigDir` |
| `bandeja-mensajes` | Captura los bloques ` ```mensaje <destinatario> ` que redacta Claude y deja copiarlos o guardarlos | `mensajes.destinatarios` |
| `grilling-ok` | Responde con un clic (o con un `ok`) a las preguntas Q1…Qn de una sesión de grilling | — |
| `modo-autonomo` | Instrucción permanente de trabajo autónomo hasta la meta, con recordatorio anti-parada acotado | — |
| `reloj-cache` | Muestra cuánto falta para que venza el caché del prompt y ofrece `/compactar-ya` | — |

## Prerrequisitos

- Node.js 20 o más nuevo (Pi pide Node 22.19 o más nuevo).
- Git y [GitHub CLI](https://cli.github.com) (`gh`), para el tablero y para el puente.
- [Claude Code](https://claude.com/claude-code), para los mods.
- En Windows, el `postinstall` de `gentle-pi` compila el binario de gentle-ai con Go (1.25.10 o más nuevo): si `pi install` de gentle-pi falla, revisá que `go` esté en el `PATH`.

`global` **detecta** estas herramientas, no las instala; si faltan, imprime el comando oficial de cada una:
[Orca](https://github.com/stablyai/orca), [engram](https://github.com/Gentleman-Programming/engram), [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) y [Pi](https://github.com/earendil-works/pi).

## Uso

```text
orca-stack global [--dry-run] [--force] [--skip-pi] [--humano <nombre>]
orca-stack init   [--dry-run]
orca-stack doctor [--offline] [--skip-pi]
orca-stack remove [--dry-run] [--with-pi]
orca-stack sesiones [--desde <AAAA-MM-DD>] [--limite <n>]
orca-stack despachar <issue> <agente> [--nota "<texto>"] [--confirmado] [--dry-run]
orca-stack revisar <pr> <agente> [--nota "<texto>"] [--confirmado] [--dry-run]
```

- `--dry-run` cuenta cada acción sin escribir nada.
- `--force` reemplaza archivos que ya existían y no son de orca-stack (por ejemplo, una skill tuya llamada igual). Sin `--force` se saltean con un aviso ⚠ y quedan como estaban; con `--force` se respaldan antes.
- `init` escribe en el `AGENTS.md` del proyecto el bloque `<!-- orca-stack:begin -->` … `<!-- orca-stack:end -->` con el contrato de trabajo completo (`assets/stack/CONTRATO.md`, igual en todos los proyectos) y las líneas de la política; a `CLAUDE.md` le pone un bloque corto con `@AGENTS.md`. Además crea `.orca-stack.json` y `.orca-stack.local.json` si faltan y agrega este último a `.gitignore`. Es idempotente y respalda lo que modifica. Los valores propios de cada proyecto no van en el bloque: viven en `.orca-stack.json`.
- `orca-setup` es la skill con la que la sesión de `main` entrevista al humano, en una sola ronda, para completar `.orca-stack.json` (`"setup": "completo"`). La ofrece sola cuando falta y `doctor` avisa si quedó pendiente.
- `sesiones` es de solo lectura: lista las sesiones recientes de Claude Code (`~/.claude/projects` y, si está, la carpeta de `agentes.pi.claudeConfigDir`), de Pi (`~/.pi/agent/sessions`) y de agy (`~/.gemini/antigravity-cli`, solo con Node 22.13 o más nuevo). Por sesión muestra la herramienta, la carpeta, inicio y fin, las llamadas, tus mensajes, las llamadas con error y los resultados de más de 15k caracteres. Es la entrada para quien corre `/retro` de Matt: `--desde` fija el día de inicio (por defecto, los últimos 2 días) y `--limite` cuántas sesiones (por defecto, 10).
- `despachar` y `revisar` (agentes: claude, agy, codex, codex-cc, pi) corren desde el checkout principal de un repo con el setup completo. Se niegan si el agente no está en `agentes.usa`, si está en `agentes.preguntarAntes` (repetí con `--confirmado` cuando el humano dijo que sí), si el issue está cerrado o asignado, si el revisor es el implementador del PR (línea `Implementador:`) o si codex y codex-cc se revisan entre sí, o si ya hay un worktree o un agente vivo para ese ticket. Antes de tocar nada hacen `git fetch origin` y comprueban que cada ruta que cita el brief (armado desde `assets/stack/brief-ticket.md` o `brief-revision.md`) exista en `origin/<ramaBase>` (en `revisar`, en la rama del PR): una ruta que falta o que git ignora aborta sin asignar ni crear nada. Si pasa todo, `despachar` asigna el issue (el assignee es el cerrojo y lo maneja el comando: no se asigna antes), y ambos crean el worktree con `orca worktree create` (así lo ve Orca), escriben el brief en `~/orca/briefs/`, lanzan el agente en una terminal de Orca y le mandan el brief. Si algo falla después de crear el worktree, el mensaje lista lo que quedó (assignee, worktree, brief) y cómo recuperarlo, porque el cerrojo rechaza un reintento. Pi corre sin TUI (`pi -p`), así que sí puede ejecutar git, gh y la suite. `--nota` agrega texto al brief y `--dry-run` muestra el plan y el brief sin escribir nada. Los modelos salen de `agentes.modelos` de tu config personal: un texto, `{ "modelo", "esfuerzo" }` o `{ "implementar": {…}, "revisar": {…} }` por agente.
- `--skip-pi` no toca Pi (útil si todavía no lo instalaste).
- `--humano` fija cómo te nombran los mods; si no lo pasás, sale de `git config user.name`.
- `doctor` hace sondeos reales y sale con código 1 si hay una falla (✖). Los avisos (⚠) no cambian el código.
- `remove` borra lo que `global` creó, restaura lo que había reemplazado, saca sus entradas de `CLAUDE_CODE_PLUGIN_DIRS` y su bloque de `CLAUDE.md`. Los respaldos (`~/.orca-stack/backups/<fecha>/`) se quedan. Los paquetes de Pi solo se sacan con `--with-pi`, y solo los que no tenías antes de instalar. Si editaste `~/.orca-stack/config.json`, se conserva.
- Para probar sin tocar tu carpeta personal: `ORCA_STACK_HOME=/ruta/temporal orca-stack global`.

### `doctor`

No se queda en "el archivo existe":

- corre el `--orca-stack-self-test` de cada wrapper y comprueba que la ruta de la política exista;
- compara la versión de Pi y de sus paquetes con las fijadas (Pi `0.99.1`, gentle-pi `4.0.0`, pi-claude-bridge `0.9.1`) y avisa si no coinciden;
- sondea con un `pi -p` corto (con tiempo máximo) si falta el `/login` (se omite con `--offline`);
- verifica que las skills de gentle-pi se resuelvan igual que lo hace `puente-gentle` en ejecución (primero la carpeta de Pi, después `npm root -g`);
- comprueba que cada mod esté en `CLAUDE_CODE_PLUGIN_DIRS`;
- combina las tres capas de configuración igual que los mods y avisa si un script de `despacho` no existe;
- avisa de la deriva: el plugin `mattpocock-skills` por debajo de 1.3.1, skills que están en `~/.claude/skills` y también en el plugin (quedan dos veces en el contexto), `pr`, `implement-spec` o `retro` ausentes de `~/.agents/skills`, y las secciones de review de gentle-ai que siguen en `~/.claude/CLAUDE.md` con RDD apagado. Son avisos, no fallas, y cada uno trae el comando que lo arregla;
- detecta `engram`, `gentle-ai`, `gh` y Orca, y **solo lee** `orca-data.json` de los perfiles de Orca para decirte si los overrides de los agentes apuntan a los wrappers. Nunca lo escribe.

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
- **Caveman** (`JuliusBrussee/caveman`, Apache-2.0): se instala desde su origen: `claude plugin marketplace add JuliusBrussee/caveman && claude plugin install caveman@caveman`.
- **Los hooks de ciclo de vida completos de Ponytail y Caveman**: duplicarían el control que ya tienen Orca y los proveedores (ver `ORCA-STACK.md`, sección "Deliberate exclusions").
- **Credenciales y datos locales**: nada de `auth.json`, `models.json`, `~/.claude.json`, bases de engram ni datos de la aplicación de Orca.
- **Los datos de la aplicación de Orca**: solo se leen en `doctor`, nunca se escriben.

## Origen y licencias

| Componente | Origen | Licencia |
| --- | --- | --- |
| Este repositorio: CLI, wrappers, mods, `ORCA-STACK.md`, `ROLE-BRIEFS.md`, skill `orca-stack-policy` | Propio | MIT (ver `LICENSE`) |
| Skills `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-help` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail). `ponytail` y `ponytail-review` están adaptadas para Orca; las otras tres son copias locales que pueden diferir del último upstream | MIT, © 2026 DietrichGebert. La nota de licencia viaja en `LICENSE` dentro de cada carpeta de skill |
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
npm run sync-shared       # copia shared/orca-config.ts a los mods que lo usan
```

Un plugin de Claude Code solo puede importar archivos de su propia carpeta, y el motor no deja pasar `$` a través de un `import`. Por eso el resolvedor de configuración (`shared/orca-config.ts`) se copia tal cual en cada mod que lo usa y recibe sus operaciones como funciones; un test falla si alguna copia se desfasa.

Los mods se cargan por `CLAUDE_CODE_PLUGIN_DIRS` (carpetas absolutas separadas por el separador de rutas del sistema, tomadas del entorno o del bloque `env` de `~/.claude/settings.json`). La documenta la guía de authoring de plugins de Claude Code (skill `plugin-authoring`); no la encontré en la referencia pública de ajustes.

## Licencia

MIT, ver [`LICENSE`](./LICENSE).
