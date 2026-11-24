# Spike: `worker-start --agent --model --effort` frente al despacho de hoy (#434)

## Qué se comparó y por qué

Hoy `despachar` crea la terminal, lanza el agente con los wrappers de orca-stack y los flags de modelo en su línea de comandos, y recién después llama a `orca orchestration worker-start --terminal <handle>` (ADR 0001). La alternativa es que Orca lance el agente con `worker-start --agent <agente> --model <id> --effort <nivel>`. Se quiso saber si Orca deja un registro verificable del modelo que corrió (`launch.requested` / `launch.effective`) y qué cambiaría en `despachar`, `limpiar` y la regla de familia del revisor.

**Lanzamiento real: no se hizo.** El brief de este worker prohíbe despachar workers, y main lo confirmó: "En #434 no lances ningún worker: documentá las ayudas y los recibos observables, y marcá el lanzamiento real como bloqueado por la regla de no despachar workers, citando R2". #434 R2 dice: "if the spike cannot launch a worker by then, it reports what blocked it". Lo que lo bloqueó es esa regla. Por eso R4 (destino seguro) no tuvo worktree que crear ni sacar. En su lugar se leyeron los registros de despachos que ya existían en este Orca: entre ellos hay lanzamientos anteriores con `--agent --model --effort`, de otros repos.

## Comandos corridos y su salida observada

Todos son de solo lectura (Orca 1.4.272, `orca --version`).

1. `orca orchestration --help`: lista `worker-start`, `worker-show`, `worker-read`, `worker-list`, `worker-stop` y `worker-release`, entre otros.
2. `orca orchestration worker-start --help` (ver también Log L4 de `odd/tasks/issue-430.md`):
   - `(--agent <agent> | --terminal <handle>) ... [--model <id>] [--effort <level>]`
   - "--model supports Claude, Codex, Cursor, Antigravity, Grok, and Muse opaque provider model ids; --effort requires --model."
   - "Neither can combine with --terminal."
   - "Pi takes a provider/id --model and maps --effort to its --thinking level (off, minimal, low, medium, high, xhigh, max)."
   - "Not every worker has a terminal. [...] orca terminal verbs do not accept every worker handle."
   - "a worker started in a new worktree (new-child or new-top-level) is kept open when the receipt says keepOpenByDefault, so release it when no one will use its chat."
3. `orca orchestration worker-show --help`, `worker-list --help` y `worker-read --help`: `worker-show --dispatch <id> [--json] [--full]`; `worker-read`: "Output stays readable after the terminal is released".
4. `orca orchestration worker-show --dispatch ctx_b933fbc7e1b4 --json --full` (este mismo worker, lanzado por `despachar` con `--terminal`):
   ```
   "terminal": "term_6d68b420-...", "agent": null,
   "launch": { "requested": { "agent": null, "model": null, "effort": null },
               "effective": { "agent": null, "model": null, "effort": null } }
   "projection": { ... "provider": { "id": "claude", "model": null } }
   "terminal": { ... "title": "π - orca-stack-430", "paneTitle": "pi", "agentIdentity": "claude" }
   ```
5. `orca orchestration worker-list --json --full --limit 100`: 100 filas (`scope.source: "all"`); las filas no traen `launch`.
6. `orca orchestration worker-show --dispatch <id> --json --full` para cada una de esas 100 filas, agrupando por `startOptions.launch`. Resultado (cantidad, `requested` → `effective`):
   ```
    6  claude/opus/high              → claude/opus/high
    4  codex/gpt-5.6-luna/high       → codex/gpt-5.6-luna/high
    1  codex/gpt-5.6-luna/xhigh      → codex/gpt-5.6-luna/xhigh
    2  codex/gpt-5.6-sol/medium      → codex/gpt-5.6-sol/medium
    3  codex/gpt-6.1-terra/medium    → codex/gpt-6.1-terra/medium
    1  antigravity/gemini-4-neon-medium/null → igual
   33  antigravity/null/null         → igual
    3  codex/null/null               → igual
    1  pi/null/null                  → igual
    1  command-code/null/null        → igual
    5  null/null/null (--terminal)   → antigravity/null/null
    9  null/null/null (--terminal)   → codex/null/null
   23  null/null/null (--terminal)   → null/null/null   (incluye los pi y este worker)
    8  sin startOptions.launch
   ```
7. `orca orchestration worker-show --dispatch <id> --json --full` sobre `ctx_2ebb252a92c8` (claude), `ctx_192893bb4fb0` (codex), `ctx_48bfc4f5883c` (agy) y `ctx_7e63ac318dd1`: `startOptions.worktree: "new-top-level"`, `effects`: `worktree:created_top_level`, `terminal:reused_agent_terminal` o `terminal:created`, `setup:run`.
8. `orca orchestration worker-read --dispatch <id> --limit 100 --json` sobre esos tres, buscando el nombre del modelo en la salida: claude (`source: transcript`) y agy (`source: terminal`) no lo mencionan; codex devuelve `archive_unavailable: ... it had no transcript to read (session_not_reported)`.

## El despacho de hoy frente a `worker-start --agent`

| Aspecto | Hoy (`--terminal`) | `worker-start --agent --model --effort` |
|---|---|---|
| Quién lanza el agente | El wrapper de orca-stack, con `--model`, `-c model_reasoning_effort=...` (codex) o `--thinking` (pi) | Orca, con su propio comando |
| Flags extra de codex (`features.fast_mode=false`, `approval_policy="never"`, `sandbox_mode=...`) y `--dangerously-skip-permissions` | Sí, en `launcherFor` (`src/despacho.mjs`) | No hay flag para pasarlos |
| Worktree | Lo crea `despachar` (`worktree create … --issue <n>`) | Lo puede crear Orca (`--worktree new-top-level`) o reusar uno existente |
| `launch.requested` / `launch.effective` | Siempre `null` en modelo y esfuerzo; el agente a veces se detecta, a veces no | Se completan con lo pedido |
| Fuente de verdad del modelo | `agentes.modelos` | El recibo, más lo que se haya pasado |

## Respuestas a R3

**(a) ¿`launch.effective` está presente y es exacto?** Presente sí, para claude, codex y agy (`antigravity`), en los 17 lanzamientos con `--model` observados. En todos, `effective` es idéntico a `requested`. Si es exacto es `desconocido`: ninguna fuente independiente muestra el modelo que corrió (el transcript de claude y la terminal de agy no lo nombran, y la de codex ya no está disponible). Que `effective` repita siempre a `requested` no prueba que Orca lo verifique. Con `--terminal`, `effective.model` es siempre `null`, y `effective.agent` es inconsistente: este worker de pi figura como `provider.id: "claude"` y `agentIdentity: "claude"`, mientras que otro worker de pi (`ctx_ace6d9ee1bb2`) figura como `pi`.

**(b) Valores de `--effort`.** Según la ayuda, `--effort` requiere `--model`, y en pi se traduce a `--thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). La ayuda no lista los valores de claude, codex ni agy. En los registros se aceptaron `high` (claude con `opus`) y `medium`, `high` y `xhigh` (codex). Para agy, `effort` es `null` en todos los registros: `desconocido`. Los demás valores también son `desconocido` sin lanzar.

**(c) Cómo cerraría `limpiar`.** Hoy `limpiar` corre `orca terminal close --worktree path:<worktree> --all --json` y después `orca worktree rm`. Un worker lanzado con `--agent` en el worktree del ticket también tiene su terminal en ese worktree, así que el cierre por worktree la alcanzaría. Pero la ayuda avisa que "Not every worker has a terminal" y que los verbos `orca terminal` no aceptan todos los handles: lo seguro sería cerrar por dispatch (`worker-stop --dispatch <id>` o `worker-release`) antes del cierre por worktree, y guardar el `dispatchId` del recibo. Además, con `new-top-level` el recibo puede marcar `keepOpenByDefault`, y en ese caso hay que liberarlo a mano. Cómo se comporta en la práctica es `desconocido` sin lanzar.

**(d) ¿Sirve el registro para la familia del revisor?** En parte. `launch.effective.model` (`opus`, `gpt-5.6-luna`, `gemini-4-neon-medium`) lo clasifica `familyOfModel` con los mismos patrones de `FAMILIES`. Pero `revisar` decide la familia antes de lanzar, y las revisiones no son supervisadas (ADR 0001: "Reviews stay unsupervised"), así que no hay recibo del revisor. Sin `--model`, el registro dice `null`: el default de agy (`gemini-4-neon-high`) vive en `despachar`, no en Orca. El registro serviría para comprobar después lo que corrió el autor, no para reemplazar la lectura de `agentes.modelos`.

## Hallazgos de R5

No se observó ningún flag rechazado ni ningún modelo ignorado. Sin lanzar no se puede observar ninguno: ninguno de los 100 registros tiene un `effective` distinto de `requested`. Hay dos hallazgos de lectura: con `--terminal`, el recibo no registra el modelo, y la identidad del agente puede ser incorrecta (pi aparece como `claude`).

## Recomendación

**No migrar.** `worker-start --agent` deja afuera los wrappers y los flags que orca-stack necesita (los de autonomía y sandbox de codex, `--dangerously-skip-permissions`, y el perfil, las skills y las herramientas de pi), que son la razón del ADR 0001. Lo que se gana es un `launch.effective` que, en lo observado, solo repite lo pedido, y no puede reemplazar el chequeo previo de `revisar`. Si un lanzamiento real en un destino descartable mostrara que Orca verifica el modelo, se puede reabrir la idea. Una migración, total o parcial, sería un ticket nuevo. Este PR no cambia el camino por defecto de `despachar` (S15).
