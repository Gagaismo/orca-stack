import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import { harness } from './harness'

const COST = 'Modo aut\u00f3nomo, lo que puede costar m\u00e1s sin supervisi\u00f3n: '
const PROACTIVE = 'la exploraci\u00f3n, las consultas y la vigilancia de Proactive'
const ULTRACODE = 'el workflow de ultracode para cada tarea sustantiva, sin l\u00edmite de concurrencia'
const LAZY_WARNING = 'Modo aut\u00f3nomo en Lazy: los items que no est\u00e9n especificados van a esperar un cambio de marcha.'
const PROACTIVE_WARNING = `${COST}${PROACTIVE}. Para bajarlo: /marcha medium`
const ULTRACODE_WARNING = `${COST}${ULTRACODE}. Para bajarlo: apag\u00e1 ultracode`
const BLIND_WARNING = `${COST}${PROACTIVE}. No puedo ver si ultracode est\u00e1 activo. Para bajarlo: /marcha medium`

const COMMAND = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})
const ATTACHMENT = (type: string) => ({ type, text: type, origin: { kind: 'engine' as const } })

// Stands in for modo-autonomo, loaded beside the gear mod as another user plugin (a test cannot
// import another plugin's folder): like mods/modo-autonomo/hooks/register.ts, it answers /autonomo
// itself, without next, and writes its own `isOn`.
const WITH_AUTONOMO = {
  plugins: [{
    name: 'modo-autonomo',
    register(on: On) {
      on('command.run', { command: 'autonomo' }, async $ => {
        await $.state.set({ plugin: 'modo-autonomo', key: 'isOn' }, true)

        return { text: 'Modo aut\u00f3nomo activado \u2192 producci\u00f3n. Para apagarlo: /autonomo off.' }
      })
    },
  }],
}

const setup = (on: On) => {
  mock.store(on)
  const world = harness(on)
  on('command.run', { command: 'effort' }, () => ({ text: '' }))

  return world
}

const start = async ($: EngineInterface) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const run = async ($: EngineInterface, command: string, args = '') => $.command.run(COMMAND(command, args))

test('Rule 1: /autonomo in Lazy warns once that unspecified items will wait', WITH_AUTONOMO, async ($, on) => {
  const world = setup(on)
  await start($)
  await run($, 'marcha', 'lazy')
  await run($, 'autonomo')

  expect(world.notices).toEqual([LAZY_WARNING])
})

test('Rule 2: /autonomo in Proactive warns about its cost, ending with /marcha medium', WITH_AUTONOMO, async ($, on) => {
  const world = setup(on)
  await start($)
  await run($, 'marcha', 'proactive')
  await run($, 'autonomo')

  expect(world.notices).toEqual([PROACTIVE_WARNING])
  expect(world.notices[0]?.endsWith('/marcha medium')).toBe(true)
})

test('Rule 3: /autonomo in Medium with ultracode on warns naming ultracode', WITH_AUTONOMO, async ($, on) => {
  const world = setup(on)
  await start($)
  await run($, 'effort', 'ultracode')
  await run($, 'autonomo')

  expect(world.notices).toEqual([ULTRACODE_WARNING])
})

test('Rule 4: /marcha proactive during autonomous mode warns about its cost', WITH_AUTONOMO, async ($, on) => {
  const world = setup(on)
  await start($)
  await run($, 'autonomo')
  await run($, 'marcha', 'proactive')

  expect(world.notices).toEqual([PROACTIVE_WARNING])
})

test('Rule 5: /effort ultracode during autonomous mode warns about its cost', WITH_AUTONOMO, async ($, on) => {
  const world = setup(on)
  await start($)
  await run($, 'autonomo')
  await run($, 'effort', 'ultracode')

  expect(world.notices).toEqual([ULTRACODE_WARNING])
})

test('Rule 6: /autonomo in Medium without ultracode shows no warning', WITH_AUTONOMO, async ($, on) => {
  const world = setup(on)
  await start($)
  await run($, 'autonomo')

  expect(world.notices).toEqual([])
  expect(world.toasts).toEqual([])
})

test('Rule 7: after /clear empties the state, the Proactive warning says it cannot see ultracode', WITH_AUTONOMO, async ($, on) => {
  const world = setup(on)
  await start($)
  await run($, 'effort', 'ultracode')
  // `/clear` empties `$.state` and starts a new session id without `session.start` (#153).
  world.emptyState()
  world.setSessionId('session-2')
  await run($, 'marcha', 'proactive')
  await run($, 'autonomo')

  expect(world.notices).toEqual([BLIND_WARNING])
})

test('Rule 8: a resumed session starts with ultracode off for the mod', WITH_AUTONOMO, async ($, on) => {
  const world = setup(on)
  await start($)
  await run($, 'marcha', 'proactive')
  await run($, 'effort', 'ultracode')
  // A resume runs in a new process: `$.state` is empty, `session.start` fires, and the history's
  // ultracode attachments are asked again in order, the new process adding its exit (#153).
  world.emptyState()
  await start($)
  await $.prompt.attachment(ATTACHMENT('ultra_effort_enter'))
  await $.prompt.attachment(ATTACHMENT('ultra_effort_exit'))
  await run($, 'autonomo')

  expect(world.notices).toEqual([PROACTIVE_WARNING])
})

test('Preserve /marcha proactive output and posture outside autonomous mode, with no warning', async ($, on) => {
  const world = setup(on)
  await start($)
  const out = await run($, 'marcha', 'proactive')

  expect(out.text).toBe('Marcha: proactive (esfuerzo m\u00ednimo: xhigh)')
  expect(out.context?.[0]).toContain('Este mensaje de marcha reemplaza cualquier postura de marcha anterior.')
  expect(world.notices).toEqual([])
})

test('Preserve /effort reaching the engine and returning its output outside autonomous mode', async ($, on) => {
  mock.store(on)
  const world = harness(on)
  const reached: string[] = []
  on('command.run', { command: 'effort' }, (_$, e) => {
    reached.push(e.args)
    return { text: `effort ${e.args}` }
  })
  await start($)

  expect((await run($, 'effort', 'xhigh')).text).toBe('effort xhigh')
  expect((await run($, 'effort', 'ultracode')).text).toBe('effort ultracode')
  expect(reached).toEqual(['xhigh', 'ultracode'])
  expect(world.notices).toEqual([])
})
