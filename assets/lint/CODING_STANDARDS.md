# Coding standards

Reglas de juicio sobre cómo se escribe el código en este repo. Las reglas mecánicas viven en la CI y en [`orca-stack lint`](https://github.com/Gagaismo/orca-stack/blob/main/docs/manual.md#lint); las de producto, en `AGENTS.md`.

## La regla de los comentarios

Todo comentario de código cae en uno de cuatro tipos, y cada tipo dice qué hacer con él:

| Type | Action |
|---|---|
| Tautology | Delete it. |
| Excuse | Delete it and open an issue to fix the implementation. |
| Stale | Delete it. |
| Decision Record | Move it to an ADR. |

Fuente: Matt Pocock, https://x.com/mattpocockuk/status/2123798388227403983.

El único comentario permitido es un Decision Record que cita un ADR o un issue `#n` (o `owner/repo#n` si es de otro repo). `orca-stack lint` aplica la parte mecánica de esta regla en JavaScript, TypeScript, Go, Python y Shell; lo demás lo aplica quien revisa.
