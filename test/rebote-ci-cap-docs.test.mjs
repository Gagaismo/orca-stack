import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { read } from './helpers.mjs'

// Issue 396 S6: after the second CI bounce, main diagnoses and bounces up to four times.
const ROOT = process.cwd()
const main = read(path.join(ROOT, 'assets', 'stack', 'MAIN.md'))
const manual = read(path.join(ROOT, 'docs', 'manual.md'))
const step8 = main.split(/\r?\n/).find(line => line.startsWith('8. '))

describe('issue 396: CI bounces past the second need a Diagnóstico de main, up to four', () => {
  test('S6: MAIN.md step 8 replaces the hand-off to the human with diagnosis, cap and needs-info', () => {
    assert.ok(step8, 'MAIN.md has step 8')
    assert.doesNotMatch(step8, /Después del segundo rebote de CI, si vuelve a fallar, se lo pasás al humano/)
    assert.ok(step8.includes('Después del segundo rebote de CI, si vuelve a fallar, escribís en el PR un comentario `Diagnóstico: main` con `Causa:`, `Probado:`, `Siguiente hipótesis:` y `Commit: <headRefOid>`, publicado después del último `Rebote CI:`, con una hipótesis nueva distinta de `Probado:`, y rebotás de nuevo, hasta cuatro rebotes de CI.'), step8)
    assert.ok(step8.includes('Sin una hipótesis nueva o con el tope alcanzado, agregá `needs-info` al issue, comentá por qué e informá al humano.'), step8)
    assert.ok(step8.includes('El paso 7 (c) no se salda con `Decidido por main`.'), step8)
    assert.ok(step8.includes('la propuesta viaja con la escalación al humano, nunca en su lugar ni para demorarla'), step8)
  })

  test('S6: the manual describes the diagnosis gate, the cap and the three refusals', () => {
    assert.doesNotMatch(manual, /Después del segundo rebote de CI, si vuelve a fallar, se lo pasa al humano/)
    assert.match(manual, /hasta cuatro rebotes de CI/)
    for (const line of [
      '`rebote: falta un Diagnóstico de main sobre <sha> para el rebote de CI <k>`',
      '`rebote: el Diagnóstico de main sobre <sha> no trae una Siguiente hipótesis`',
      '`rebote: tope de 4 rebotes de CI alcanzado en el PR #<n>`',
    ]) assert.ok(manual.includes(line), line)
  })
})
