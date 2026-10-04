import { expect, test } from 'claude-code/testing'

import { allOk, describeRange, expandAnswer, findQuestions } from '../hooks/questions'
import { world } from './harness'

test('detects questions in bold, bullets, headers and plain lines', () => {
  const text = [
    'Antes de seguir necesito cerrar esto:',
    '',
    '**Q1.** ¿Quién aprueba el gasto?',
    '**Q2** ¿Y el plazo?',
    '- Q3: ¿Hay presupuesto?',
    '* **Q4:** ¿Qué pasa si falla?',
    '### Q5 Alcance',
    '## **Q6.** Riesgos',
    'Q10) ¿Se factura?',
    '1. Q11. ¿Cuándo?',
    '> Q30. ¿Última?',
    'Q12.',
  ].join('\n')
  expect(findQuestions(text)).toEqual([1, 2, 3, 4, 5, 6, 10, 11, 30, 12])
})

test('ignores Q&A, quarters and mid-sentence mentions', () => {
  const text = [
    'Q&A con el cliente mañana.',
    'Q3 2026 fue flojo para ventas.',
    'Como dijimos en Q4. no hay cambios',
    'Respondí la Q7. ayer',
    'La sección Q&A: pendiente',
    'Q: ¿algo?',
    'Q0. cero',
  ].join('\n')
  expect(findQuestions(text)).toEqual([])
})

test('keeps order without duplicates', () => {
  expect(findQuestions('Q2. a\nQ1. b\nQ2. c')).toEqual([2, 1])
})

test('describes ranges', () => {
  expect(describeRange([12, 13, 14, 15, 16, 17])).toBe('Q12–Q17')
  expect(describeRange([5])).toBe('Q5')
  expect(describeRange([1, 2, 3, 5])).toBe('Q1–Q3, Q5')
})

test('expands ok / todo ok / ok todo', () => {
  const pending = [12, 13, 14]
  for (const said of ['ok', ' OK ', 'Todo ok', 'ok todo', 'todo OK.']) {
    expect(expandAnswer(said, pending)).toBe('Q12. ok Q13. ok Q14. ok')
  }
})

test('expands the salvo case with the exception text', () => {
  const pending = [12, 13, 14, 15]
  expect(expandAnswer('ok salvo Q14: usar el plan B', pending)).toBe(
    'Q12. ok Q13. ok Q14. usar el plan B Q15. ok',
  )
  expect(expandAnswer('todo ok menos Q14 que sea semanal', pending)).toBe(
    'Q12. ok Q13. ok Q14. que sea semanal Q15. ok',
  )
  expect(expandAnswer('ok salvo Q13: no, Q15. mejor mensual', pending)).toBe(
    'Q12. ok Q13. no Q14. ok Q15. mejor mensual',
  )
})

test('anything else passes through', () => {
  const pending = [1, 2]
  expect(expandAnswer('ok pero cambiá la Q2', pending)).toBeUndefined()
  expect(expandAnswer('ok salvo Q9: x', pending)).toBeUndefined()
  expect(expandAnswer('ok salvo todo lo demás', pending)).toBeUndefined()
  expect(expandAnswer('ok salvo Q2:', pending)).toBeUndefined()
  expect(expandAnswer('dale, hacelo', pending)).toBeUndefined()
  expect(expandAnswer('ok', [])).toBeUndefined()
  expect(allOk([1, 2])).toBe('Q1. ok Q2. ok')
})

const turn = (answer: string) => ({
  answer,
  durationMs: 1,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
})
const submit = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

test('turn end records the questions; a bare ok is rewritten and clears them', async ($, on) => {
  const w = world(on)
  const entered: string[] = []
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$, e) => {
    entered.push(e.text)

    return { text: e.text }
  })

  await $.turn.complete(turn('Q1. uno\nQ2. dos\nQ3. tres'))
  expect(w.state.get('grilling-ok/pending')?.value).toEqual([1, 2, 3])

  await $.prompt.submit(submit('ok'))
  expect(entered.at(-1)).toBe('Q1. ok Q2. ok Q3. ok')
  expect(w.toasts).toEqual(['Respondí Q1–Q3'])
  expect(w.state.get('grilling-ok/pending')?.value).toEqual([])

  await $.prompt.submit(submit('ok'))
  expect(entered.at(-1)).toBe('ok')
})

test('a free-text answer passes untouched and still clears the questions', async ($, on) => {
  const w = world(on)
  const entered: string[] = []
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$, e) => {
    entered.push(e.text)

    return { text: e.text }
  })

  await $.turn.complete(turn('Q1. uno\nQ2. dos'))
  await $.prompt.submit(submit('Q1. sí Q2. no'))
  expect(entered.at(-1)).toBe('Q1. sí Q2. no')
  expect(w.state.get('grilling-ok/pending')?.value).toEqual([])
})

test('the band shows the range and the button submits the answers', async ($, on) => {
  const w = world(on)
  const entered: string[] = []
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$, e) => {
    entered.push(e.text)

    return { text: e.text }
  })
  const props = {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  }

  await $.turn.complete(turn('**Q12.** a\n**Q13.** b\n**Q14.** c'))
  const ui = await $.ui.mount({
    plugin: 'grilling-ok',
    surface: 'terminal',
    component: 'AbovePrompt',
    props,
  })
  expect((await ui.find({ type: 'Text' }))?.text).toContain('Preguntas Q12–Q14')
  await ui.press({ key: 'all-ok' })
  expect(entered).toEqual(['Q12. ok Q13. ok Q14. ok'])
  expect(w.state.get('grilling-ok/pending')?.value).toEqual([])
  await ui.unmount()
})
