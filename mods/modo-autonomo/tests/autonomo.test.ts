import { expect, test } from 'claude-code/testing'

import { DONE_TOKEN, MAX_NUDGES } from '../hooks/register'
import { world } from './harness'

const COMPOSE = {
  model: 'm',
  promptModel: 'm',
  surfaces: ['terminal' as const],
  tools: [],
  outputStyle: null,
  traits: [],
}
const run = (args: string) => ({
  command: 'autonomo',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})
const stop = (last: string, extra: { background_tasks?: never[] } = {}) => ({
  stop_hook_active: false,
  last_assistant_message: last,
  ...extra,
})

const setup = (
  on: Parameters<typeof world>[0],
  options: { sessionStartContext?: string[]; stopContext?: string[] } = {},
) => {
  const w = world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  on('tool.call', () => ({ result: {} as never }))
  on('classic.Stop', () => ({ additionalContext: options.stopContext }))
  on('classic.SessionStart', () => ({ additionalContext: options.sessionStartContext }))

  return w
}

test('/autonomo turns the mode on with a goal and /autonomo off clears it', async ($, on) => {
  const w = setup(on)

  const out = await $.command.run(run(''))
  expect(out.text).toContain('producción')
  expect(w.statuses.at(-1)).toBe('AUTÓNOMO → producción')

  await $.command.run(run('staging verde'))
  expect(w.statuses.at(-1)).toBe('AUTÓNOMO → staging verde')

  await $.command.run(run('off'))
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.state.get('modo-autonomo/isOn')?.value).toBe(false)
})

test('the system prompt gets one session section only while on', async ($, on) => {
  setup(on)

  const off = await $.prompt.compose(COMPOSE)
  expect(off.sections.map(s => s.id)).toEqual(['intro'])

  await $.command.run(run('mergear el PR 12'))
  const onSections = (await $.prompt.compose(COMPOSE)).sections
  const last = onSections.at(-1)
  expect(last?.id).toBe('modo-autonomo:instrucciones')
  expect(last?.scope).toBe('session')
  expect(last?.text).toContain('mergear el PR 12')
  expect(last?.text).toContain(DONE_TOKEN)
})

test('/autonomo delivers the active instructions to the next turn', async ($, on) => {
  setup(on)

  const out = await $.command.run(run('prueba'))

  expect(out.context?.[0]).toContain('Modo aut\u00f3nomo activo. Meta: prueba.')
})

test('a compacted session receives the current autonomous instructions', async ($, on) => {
  setup(on, { sessionStartContext: ['existing context'] })
  await $.command.run(run('prueba'))

  const out = await $.classic.SessionStart({ source: 'compact' } as never)

  expect(out.additionalContext).toEqual([
    'existing context',
    expect.stringContaining('Modo aut\u00f3nomo activo. Meta: prueba.'),
  ])
})

test('/autonomo off tells the next turn the mode is off', async ($, on) => {
  setup(on)
  await $.command.run(run('prueba'))

  const out = await $.command.run(run('off'))

  expect(out.context?.[0]).toContain('Modo aut\u00f3nomo apagado')
})

test('/autonomo off while already off adds no context for the model', async ($, on) => {
  setup(on)

  const out = await $.command.run(run('off'))

  expect(out.context).toBeUndefined()
})

test('stopping is blocked up to three times, then it lets go and warns', async ($, on) => {
  const w = setup(on)
  await $.command.run(run(''))

  for (let i = 0; i < MAX_NUDGES; i += 1) {
    const blocked = await $.classic.Stop(stop('Listo por ahora.'))
    expect(blocked.block).toContain('Modo autónomo activo')
  }
  const released = await $.classic.Stop(stop('Sigo sin avanzar.'))
  expect(released.block).toBeUndefined()
  expect(w.toasts).toEqual(['Modo autónomo: me detuve, revisá'])
})

test('a tool call between stops resets the count', async ($, on) => {
  setup(on)
  await $.command.run(run(''))

  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < MAX_NUDGES; i += 1) {
      expect((await $.classic.Stop(stop('x'))).block).toBeDefined()
    }
    await $.tool.call({ tool: 'Bash', command: 'git status' })
  }
})

test('the done token turns the mode off and toasts', async ($, on) => {
  const w = setup(on, { stopContext: ['existing context'] })
  await $.command.run(run(''))

  const out = await $.classic.Stop(stop(`Todo en producción. ${DONE_TOKEN}`))
  expect(out.block).toBeUndefined()
  expect(out.additionalContext).toEqual([
    'existing context',
    expect.stringContaining('Modo aut\u00f3nomo apagado'),
  ])
  expect(w.toasts).toEqual(['Modo autónomo: meta alcanzada'])
  expect(w.statuses.at(-1)).toBeUndefined()
  expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro'])
})

test('no nudge while off or while a background task will wake the session', async ($, on) => {
  setup(on)
  expect((await $.classic.Stop(stop('fin'))).block).toBeUndefined()

  await $.command.run(run(''))
  const task = { id: 'm1', status: 'running' } as never
  const waiting = await $.classic.Stop({
    stop_hook_active: false,
    last_assistant_message: 'Esperando el monitor.',
    background_tasks: [task],
  })
  expect(waiting.block).toBeUndefined()
})
