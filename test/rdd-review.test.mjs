import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => readFileSync(path.join(ROOT, file), 'utf8')
const main = read(path.join('assets', 'stack', 'MAIN.md'))
const step = n => main.split(/\r?\n/).find(line => line.startsWith(`${n}. `)) ?? ''

describe('#338 RDD review mode for pi PRs', () => {
  test('Rule 3: MAIN.md step 6 has main choose no review or an RDD review with lenses from the tier, reviewDue, Risk:, riesgo and a one-way door', () => {
    const six = step(6)
    assert.ok(six.includes('Con `agentes.pi.review: "rdd"` en la config fusionada y un PR de pi (`Implementador: pi`), no despachás `revisar`'), six)
    for (const input of ['el tier, `reviewDue` y la línea `Risk:`', 'si el diff toca un glob de `riesgo`', 'nombra una puerta de una vía']) assert.ok(six.includes(input), input)
    assert.ok(six.includes('elegís "sin review" o "review RDD con las lentes <lista>"'))
    assert.ok(six.includes('El `reviewDue` de pi es un dato, no la decisión: decidís vos.'))
  })

  test('Rule 4: MAIN.md step 7 merges without review only with a Sin review: comment whose Commit: is the headRefOid and a complete Evidencia', () => {
    const seven = step(7)
    assert.ok(seven.includes('si elegiste "sin review", con un comentario tuyo publicado con `--body-file` que lleva `Sin review: <razón>` y `Commit: <sha>`, con `## Evidencia` completa (una fila por Regla)'), seven)
    assert.ok(seven.includes('un `Sin review:` o un review RDD cuyo `Commit:` no es el `headRefOid` no cuenta'))
  })

  test('Rules 4 and 7: the GitHub merge (web-flow) exception of step 7 never lets a Sin review: or an RDD review on an older head count', () => {
    const seven = step(7)
    assert.ok(!seven.includes('Los comentarios de (a) siguen contando con el'), 'the exception no longer covers every comment of (a)')
    assert.ok(seven.includes('Salvo un `Sin review:` o un review RDD, que siempre tienen que nombrar el `headRefOid` actual (se repiten en cada head nuevo), los comentarios de (a) siguen contando con el `Commit:` anterior solo si el head nuevo es un merge hecho por GitHub'), seven)
  })

  test('Rules 5 and 6: MAIN.md step 6 says rebote --rdd posts the request puente-gentle needs, and how a START consent reaches the human and comes back', () => {
    const six = step(6)
    assert.ok(six.includes('`rebote --rdd` publica en el PR tu pedido, `RDD: <sha> (<lentes>)`, y `puente-gentle` solo cuenta un review RDD de pi con ese marcador sobre el mismo head y con las mismas lentes.'), six)
    assert.ok(six.includes('Si START de RDD pide consentimiento, pi lo deja en un comentario `Consulta: pi` en el PR y se detiene; se lo pasás al humano, que lo responde en la terminal de pi, y retomás a pi con `orca-stack reanudar <issue> <url-del-comentario>`.'))
    assert.ok(six.includes('Si la corrección acotada de RDD cambió el head, tu pedido no lo nombra'))
  })

  test('Rule 5: MAIN.md step 6 asks for the RDD review with rebote --rdd and the Revisor: pi (RDD: <lentes>) format', () => {
    assert.ok(step(6).includes('Lo pedís con `orca-stack rebote <pr> --rdd <lentes>`'))
    assert.ok(step(6).includes('con `Revisor: pi (RDD: <lentes>)` y `Commit: <sha>`'))
  })

  test('Rule 6: the contract states the RDD self-review exception once, and the ODD self-check or an unrequested RDD still do not count', () => {
    const contract = read(path.join('assets', 'stack', 'CONTRATO.md'))
    const exception = 'el review RDD que pi corre sobre un PR suyo cuando `main` se lo pide (`orca-stack rebote <pr> --rdd <lentes>`) es un review de registro, porque revisores de contexto limpio miran un commit congelado.'
    assert.equal(contract.split(exception).length - 1, 1, 'worded once in CONTRATO.md')
    assert.ok(contract.includes('Nadie revisa su propio PR y un worktree de ticket nunca revisa. Excepción: con `agentes.pi.review: "rdd"` en la config,'))
    assert.ok(contract.includes('El autochequeo ODD de pi, o un RDD que pi corrió por su cuenta antes del PR sin que `main` lo pidiera, no cuentan.'))
    assert.ok(contract.includes('salvo el review RDD que pide `main` (ver Agentes).'), 'Review points to the exception instead of repeating it')
    assert.equal(main.includes(exception), false, 'MAIN.md does not repeat it')
  })

  test('Rule 7: a clean RDD review on the headRefOid satisfies step 7 (a)-(b), and an uncleared correction_required follows the bounce rules of step 8', () => {
    assert.ok(step(7).includes('(a) también se cumple con un review `Revisor: pi (RDD: <lentes>)` sin bloqueos'))
    assert.ok(step(8).includes('Un review RDD que termina en `correction_required` sin que su corrección acotada lo salde publica sus bloqueos y sigue estas mismas reglas: un rebote por review, y después `Verificado por main` o `Decidido por main`.'))
  })

  test('Rule 8: MAIN.md never allows no review for riesgo or a one-way door: an RDD review with the risk lens and no cross review on top', () => {
    assert.ok(step(6).includes('Si el diff toca `riesgo`, nombra una puerta de una vía o le falta alguna de esas tres líneas, no hay "sin review": va un review RDD con `risk` entre las lentes'))
    assert.ok(step(6).includes('sin review cruzado de otra familia encima'))
  })

  test('Rule 9: this repo opts in with agentes.pi.review "rdd" in .orca-stack.json', () => {
    const config = JSON.parse(read('.orca-stack.json'))
    assert.equal(config.agentes?.pi?.review, 'rdd')
  })
})
