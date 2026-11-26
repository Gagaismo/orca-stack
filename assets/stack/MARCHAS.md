## Orca stack: perk de marchas

Este fragmento lo instala `orca-stack global` junto a `MAIN.md`, `ORCA-STACK.md` y `ROLE-BRIEFS.md`. Vale solo con el perk `marchas` encendido (`"perks": { "marchas": true }` en cualquier capa de la config de orca-stack). Con el perk encendido, el contrato que escribe `orca-stack init` trae la sección Marchas y las marcas `Marcha:` y `Esperando marcha:`, el mod `marchas` se activa, y la sesión de `main` lee este fragmento entero junto con `MAIN.md`: sus reglas se suman a las de `MAIN.md` y, donde lo dicen, las restringen. Con el perk apagado no aplica nada de lo que sigue.

### Marchas

La última línea `Marcha: <lazy|medium|proactive>` que main recibió del humano fija la marcha actual. Sin mensaje `Marcha:`, la marcha es Medium. La marcha solo cambia las perillas de marcha enumeradas en Gear knobs, más abajo en este fragmento; está por debajo de las instrucciones del proyecto, ADRs, spec y ticket.

Solo el humano cambia la marcha, con `/marcha <lazy|medium|proactive>`. Main nunca ejecuta `/marcha` ni informa un cambio que no vio hacer al humano, tampoco en modo autónomo. Cuando considera que corresponde, main sugiere el cambio en una sola línea, nombrando marcha destino, item y señal, y termina con el comando exacto: `Sugiero subir a Proactive para #42 (toca riesgo): /marcha proactive`. Después de un cambio hecho por el humano, el próximo mensaje de main abre con una línea que nombra la marcha y qué cambia ahora.

Main sugiere una marcha como máximo una vez por item y señal:

- De Medium a Lazy, cuando solo queda trabajo especificado, pero nunca mientras haya una tanda despachada en Proactive en curso.
- De Lazy a Medium ante cualquiera de estas cinco señales: hay que escribir o completar el ticket del item; la exploración no entra en una tanda inline; el item no pasa el resume test; aparece un requisito problemático; o aparece una decisión de diseño.
- A Proactive cuando empieza la planificación (`grill-with-docs`, `to-spec`, `to-tickets` o charting de un map), o antes de despachar una tanda que toca `riesgo` o una puerta de una vía.
- De Lazy o Proactive a Medium al cerrar una tanda, junto con las propuestas de retro y handoff del paso 10.

Un item que espera un cambio de marcha queda esperando; el resto de la tanda sigue. El resumen de cierre lista los items en espera. En modo autónomo, si solo quedan items esperando un cambio de marcha, main cierra sin escribir `[AUTONOMO-LISTO]` y deja `Esperando marcha: <items>`. Por ejemplo, si solo quedan #41 y #43, deja `Esperando marcha: #41, #43`.

### Lo que cambia cada marcha en `MAIN.md` y `ORCA-STACK.md`

- **Orden de autoridad.** La marcha actual de main va entre las instrucciones del proyecto (ADRs, spec y ticket) y el brief del rol: solo gira la lista cerrada de Gear knobs, más abajo, y nunca amplía nada de lo que tiene encima.
- **Ciclo de `main`, paso 10.** Al cerrar la tanda, registrá en la nota de handoff la marcha que deja y proponele al humano volver a Medium si la sesión estaba en Lazy o Proactive. La sesión siguiente sugiere en una línea esa marcha, pero sin aplicarla.
- **Arena y swarm.** El swarm de solo lectura que no requiere OK nunca se hace en Lazy. En las señales, Proactive agrega la señal «no saber qué enfoque conviene» antes, y el primer bounce no mecánico después. En modo autónomo, Proactive no agrega otro límite.
- **Despacho.** Solo elegir la marcha Proactive cuenta como pedir que `main` supervise y colabore; en Lazy y Medium el despacho es un handoff y las reglas de colaboración no aplican. Al bajar de marcha desde Proactive, `main` responde las preguntas que ya tenga y deja de vigilar; al subir a Proactive, empieza a vigilar los items en curso y no relanza nada.

## Gear knobs

These are the only process settings that a gear may turn. Every knob cites its source by heading. The contract's "Ciclo de `main`" references are checked against the shipped contract by CI. The gentle-ai ODD headings cited for K1-K3 and K5 are external to this repository and are intentionally unchecked; the check covers only citations to the shipped contract and policy.

- **K1 — Exploration depth** changes how deeply main explores before deciding; it does not change the evidence required by the task. Internal heading: CONTRATO.md — Ciclo de `main`; external gentle-ai ODD heading: Evidence budget rule (unchecked).
- **K2 — Delegation of main's own work** changes how readily main delegates its own work; it does not change Orca's worker ownership or dispatch lifecycle. Internal heading: CONTRATO.md — Ciclo de `main`; external gentle-ai ODD heading: Mandatory Delegation Triggers (unchecked).
- **K3 — Research and assumption challenge** changes how readily main recommends optional research or challenges a consequential premise; it does not decide product questions for the human. Internal heading: CONTRATO.md — Ciclo de `main`; external gentle-ai ODD heading: Resolve uncertainty (unchecked).
- **K4 — Retired** (#391: reserved so K5-K11 stay stable). Internal heading: CONTRATO.md — Ciclo de `main`.
- **K5 — Non-product questions** changes how readily main asks non-product questions; it does not move the human's product decisions to main. Internal heading: CONTRATO.md — Ciclo de `main`; external gentle-ai ODD heading: Ask trigger (unchecked).
- **K6 — Beyond-request proposals** changes whether main proposes additional work; proposals do not authorize implementation. Internal heading: CONTRATO.md — Ciclo de `main`.
- **K7 — Worker supervision** changes whether main supervises workers when the human requests it in Proactive; it does not change worker lifecycle ownership. Internal heading: CONTRATO.md — Ciclo de `main`.
- **K8 — Narration amount** changes how much main narrates; it does not omit evidence, decisions, risks, uncertainty, or test results. Internal heading: CONTRATO.md — Avances.
- **K9 — Watch cadence** changes how often main checks progress; it does not change the requirement to preserve worker and dispatch ownership. Internal heading: CONTRATO.md — Ciclo de `main`.
- **K10 — Effort and model** changes the effort or model used for main's own work; it does not change the provider routing configured for workers. Internal heading: ORCA-STACK.md — Provider routing.
- **K11 — Arena/swarm readiness** changes how readily main considers an arena or swarm; who authorizes it and its cost cap stay fixed. Internal heading: CONTRATO.md — Arena y swarm.

Everything outside K1-K11 is a fixed rule. A new or unclear rule becomes a gear knob only if it passes the four-harm test: could the human get something different unknowingly, could it cause an irreversible effect, could it corrupt shared state, or could it produce a false report? A later ticket may add a knob only by passing that test and recording it in its resolution. Caveman and Engram are orthogonal to gears.
