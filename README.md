# orca-stack

Instala de una vez el stack de agentes que uso para trabajar con [Orca](https://github.com/stablyai/orca): la política del stack, las skills propias, los wrappers de proveedores, Pi con Gentle Shell y los mods de Claude Code. Todo en un comando, con respaldo de lo que toca y con vuelta atrás.

```bash
npx github:Gagaismo/orca-stack#v0.1.0 global     # instalación a nivel usuario
npx github:Gagaismo/orca-stack#v0.1.0 init       # cablea el proyecto actual
npx github:Gagaismo/orca-stack#v0.1.0 doctor     # verifica que todo funcione de verdad
npx github:Gagaismo/orca-stack#v0.1.0 remove     # deshace lo que instaló global
```

Cero dependencias, Node 20 o más nuevo. Funciona en Windows, macOS y Linux.

## Qué instala

`global` (idempotente; todo archivo que modifica se respalda antes como `<archivo>.bak-orca-stack-<fecha>`):

| Qué | Dónde |
| --- | --- |
| Política del stack: `ORCA-STACK.md` y `ROLE-BRIEFS.md` | `~/orca/stack/` |
| Wrappers `claude-orca-stack`, `codex-orca-stack`, `agy-orca-stack` (`.cmd` en Windows, `.sh` en el resto), cada uno con `--orca-stack-self-test` | `~/orca/stack/scripts/` |
| Skills propias: `orca-stack-policy`, `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-help` | `~/.claude/skills/` y `~/.agents/skills/` |
| Siete mods de Claude Code (ver abajo) y sus rutas en `env.CLAUDE_CODE_PLUGIN_DIRS` | `~/.claude/mods/` y `~/.claude/settings.json` |
| Bloque `<!-- orca-stack:begin -->` … `<!-- orca-stack:end -->` que apunta a la política | `~/.claude/CLAUDE.md` |
| Pi: `gentle-pi@4.0.0` y `pi-claude-bridge@0.9.1` con `pi install`, más `npm i -g gentle-pi@4.0.0` (comando `gentle-shell`) | `~/.pi/agent/` y npm global |
| Registro de lo instalado, para `remove` | `~/.orca-stack/state.json` |
| Capa personal de configuración | `~/.orca-stack/config.json` |

Los wrappers se llaman distinto del binario real a propósito: así nunca se llaman a sí mismos. Cada uno fija los marcadores `ORCA_STACK_*`, busca el binario real en el `PATH`, pasa los argumentos tal cual y devuelve su código de salida.

El bloque de `CLAUDE.md` y todo lo que está fuera de los marcadores se respeta: `global` solo reemplaza lo que hay entre `orca-stack:begin` y `orca-stack:end`. Lo mismo hace con `settings.json`: solo suma sus carpetas a `CLAUDE_CODE_PLUGIN_DIRS` (con el separador de tu sistema), conserva las que ya había y no toca ninguna otra clave.

### Los mods

Son plugins de Claude Code que se recargan en caliente (`.claude-plugin/plugin.json` + `hooks/`). Se activan con la variable `CLAUDE_CODE_PLUGIN_DIRS`, que `global` completa por vos; se cargan en las sesiones que abras después.

| Mod | Qué hace | Config |
| --- | --- | --- |
| `tablero-despacho` | Tablero de PRs abiertos con checks, review y worktrees (`/tablero`). Usa `gh`. | Los atajos de despacho aparecen solo si hay `despacho` |
| `guardia-despacho` | Bloquea o corrige las llamadas a tus scripts de despacho y revisión según reglas del proyecto | **Apagado** salvo que haya `despacho` |
| `puente-gentle` | Consulta a Gentle Shell (Pi) como otro orquestador par (`/pi`, `/gentle`) | `humano` |
| `bandeja-mensajes` | Captura los bloques ` ```mensaje <destinatario> ` que redacta Claude y deja copiarlos o guardarlos | `mensajes.destinatarios` |
| `grilling-ok` | Responde con un clic (o con un `ok`) a las preguntas Q1…Qn de una sesión de grilling | — |
| `modo-autonomo` | Instrucción permanente de trabajo autónomo hasta la meta, con recordatorio anti-parada acotado | — |
| `reloj-cache` | Muestra cuánto falta para que venza el caché del prompt y ofrece `/compactar-ya` | — |

## Prerrequisitos

- Node.js 20 o más nuevo (Pi pide Node 22.19 o más nuevo).
- Git y [GitHub CLI](https://cli.github.com) (`gh`), para el tablero y para el puente.
- [Claude Code](https://claude.com/claude-code), para los mods.

`global` **detecta** estas herramientas, no las instala; si faltan, imprime el comando oficial de cada una:
[Orca](https://github.com/stablyai/orca), [engram](https://github.com/Gentleman-Programming/engram), [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) y [Pi](https://github.com/earendil-works/pi).

## Uso

```text
orca-stack global [--dry-run] [--skip-pi] [--humano <nombre>]
orca-stack init   [--dry-run]
orca-stack doctor [--offline] [--skip-pi]
orca-stack remove [--dry-run] [--with-pi]
```

- `--dry-run` cuenta cada acción sin escribir nada.
- `--skip-pi` no toca Pi (útil si todavía no lo instalaste).
- `--humano` fija cómo te nombran los mods; si no lo pasás, sale de `git config user.name`.
- `doctor` hace sondeos reales y sale con código 1 si hay una falla (✖). Los avisos (⚠) no cambian el código.
- `remove` borra lo que `global` creó, restaura lo que había reemplazado, saca sus entradas de `CLAUDE_CODE_PLUGIN_DIRS` y su bloque de `CLAUDE.md`. Los respaldos se quedan. Los paquetes de Pi solo se sacan con `--with-pi`. Si editaste `~/.orca-stack/config.json`, se conserva.
- Para probar sin tocar tu carpeta personal: `ORCA_STACK_HOME=/ruta/temporal orca-stack global`.

### `doctor`

No se queda en "el archivo existe":

- corre el `--orca-stack-self-test` de cada wrapper y comprueba que la ruta de la política exista;
- compara la versión de Pi y de sus paquetes con las fijadas (Pi `0.99.1`, gentle-pi `4.0.0`, pi-claude-bridge `0.9.1`) y avisa si no coinciden;
- sondea con un `pi -p` corto (con tiempo máximo) si falta el `/login` (se omite con `--offline`);
- verifica que las skills de gentle-pi se resuelvan igual que lo hace `puente-gentle` en ejecución (primero la carpeta de Pi, después `npm root -g`);
- comprueba que cada mod esté en `CLAUDE_CODE_PLUGIN_DIRS`;
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
| `guardia.bloquear` | `guardia-despacho` | Lista de `{ "agente", "hasta", "motivo" }`. Mientras la fecha local `hasta` (AAAA-MM-DD, a las 00:00) no llegue, llamar a los scripts de despacho con ese agente se rechaza con el `motivo`. |
| `guardia.modeloClaude` | `guardia-despacho` | Modelo obligatorio para `despacho.script ... claude`. Si falta, el mod antepone `CLAUDE_MODELO=<modelo>`; si pasan otro modelo, lo rechaza. Tu script de despacho debe leer `CLAUDE_MODELO`. |

### Ejemplos

`~/.orca-stack/config.json` (la crea `global`):

```json
{
  "humano": "Ana"
}
```

`<repo>/.orca-stack.json` (reglas compartidas; `init` lo crea con `{ "version": 1 }`):

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

`<repo>/.orca-stack.local.json` (local, ignorado por git):

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
- **Las skills de Matt Pocock** (`mattpocock/skills`): es la metodología de ingeniería del stack y la mantiene su autor. Se instala desde su origen: `claude plugin install mattpocock-skills@claude-plugins-official`.
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
| Matt Pocock skills | [mattpocock/skills](https://github.com/mattpocock/skills) (plugin `mattpocock-skills@claude-plugins-official`) | Según su repo. **No se incluye**: se instala desde su origen |
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
