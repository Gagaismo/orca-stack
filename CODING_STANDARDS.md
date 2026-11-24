# Coding standards

Reglas de juicio sobre cómo se escribe el código en este repo. Las reglas mecánicas viven en la CI y en [`orca-stack lint`](docs/manual.md#lint); las de producto, en `AGENTS.md`.

## La regla de los comentarios

Todo comentario de código cae en uno de cuatro tipos, y cada tipo dice qué hacer con él:

| Type | Action |
|---|---|
| Tautology | Delete it. |
| Excuse | Delete it and open an issue to fix the implementation. |
| Stale | Delete it. |
| Decision Record | Move it to an ADR. |

Fuente: Matt Pocock, https://x.com/mattpocockuk/status/2123798388227403983.

El único comentario permitido es un Decision Record que cita un ADR o un issue `#n`. La decisión está en [ADR 0002](docs/adr/0002-deprecate-ponytail-adopt-comment-rule.md) y el lint que la aplica, en [ADR 0003](docs/adr/0003-ast-grep-for-lint.md).

## Qué revisa el lint

`orca-stack lint` revisa los comentarios de JavaScript y TypeScript. Go, Python y Shell todavía no dan hallazgos de comentarios.

- **Decision Record:** un comentario que cita `#123`, `ADR 0002` o un link a `docs/adr/0002-…` pasa. Un "ver el ADR" que no nombra ninguno no es un Decision Record.
- **Excuse:** `TODO`, `FIXME` y `XXX` en mayúsculas, "hack", "workaround", "temporary", "for now", "shortcut:" o "upgrade when" sin una cita. Un `// TODO(#123): …` cita un issue y pasa.
- **Tautology**, solo en los casos claros: un comentario que repite la sentencia que sigue, como `// increment i` arriba de `i++` o `// return the result` arriba de `return result`.
- **Stale**, solo donde se puede comprobar: un comentario que nombra una llamada `nombre()` a una función que no está definida ni importada en el archivo. Un identificador entre backticks nunca se marca.
- **Nunca se marcan:** shebangs, encabezados de licencia, directivas `eslint-disable` y `@ts-…`, anotaciones de tipos JSDoc que pide una herramienta y strings que contienen `//`.

## Reglas de juicio

Lo que el lint no puede comprobar lo aplica quien revisa. Cada regla se cita por su encabezado.

### Tautología no obvia

Un comentario que dice lo mismo que el código con otras palabras se borra, aunque no repita la sentencia que tiene abajo.

### Comentario vencido

Un comentario que describe un comportamiento que el código ya no tiene se borra, aunque todos los nombres que menciona sigan existiendo.

### Excusa sin palabra clave

Un comentario que justifica un límite conocido de la implementación se borra y se abre un issue para arreglarla, aunque no use ninguna de las palabras que busca el lint.

### Decision Record que pide un ADR

Un comentario que explica una decisión con alternativas, consecuencias o más de un archivo afectado se mueve a un ADR, y el código cita ese ADR.
