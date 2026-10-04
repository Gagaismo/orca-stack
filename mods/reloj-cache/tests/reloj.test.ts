import { expect, mock, test } from 'claude-code/testing'

import { world } from './harness'

const MIN = 60_000
const turn = {
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
}

test('turn end starts the countdown and the clock ticks it down', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  expect(w.statuses.at(-1)).toBeUndefined()

  await $.turn.complete(turn)
  expect(w.statuses.at(-1)).toBe('caché: 60 min')

  await clock.advance(13 * MIN)
  expect(w.statuses.at(-1)).toBe('caché: 47 min')
})

test('warns once at 10 minutes and says vencida after the hour', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turn)
  await clock.advance(49 * MIN)
  expect(w.toasts).toEqual([])
  await clock.advance(2 * MIN)
  expect(w.toasts).toEqual(['Caché por vencer en 10 min'])
  await clock.advance(5 * MIN)
  expect(w.toasts).toHaveLength(1)
  await clock.advance(10 * MIN)
  expect(w.statuses.at(-1)).toBe('caché: vencida')
})

test('a new response resets the countdown and the warning', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await $.turn.complete(turn)
  await clock.advance(55 * MIN)
  expect(w.toasts).toHaveLength(1)
  await $.turn.complete(turn)
  expect(w.statuses.at(-1)).toBe('caché: 60 min')
  await clock.advance(55 * MIN)
  expect(w.toasts).toHaveLength(2)
})

test('/compactar-ya compacts the conversation from a timer', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const w = world(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })

  const out = await $.command.run({
    command: 'compactar-ya',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(out.text).toBe('Compactando la conversación…')
  await clock.advance(1)
  expect(w.compactions).toHaveLength(1)
  expect(w.toasts).toContain('Conversación compactada')
  expect(w.statuses.at(-1)).toBe('caché: 60 min')
})
