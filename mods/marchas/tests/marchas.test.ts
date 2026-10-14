import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import { AGENTS, harness, WITHOUT_MARCHAS, WORKTREE_GIT } from './harness'

const RUN = (args: string) => ({
  command: 'marcha',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const setup = (on: On, options: { contract?: string; config?: boolean; git?: string; store?: Record<string, unknown> } = {}) => {
  mock.store(on, options.store)

  return harness(on, options)
}

const start = async ($: EngineInterface) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const band = async ($: EngineInterface) => $.ui.mount({ plugin: 'marchas', surface: 'terminal', component: 'AbovePrompt', props: BAND })

test('Rule 1: proactive shift shows its marker, warning band, and hidden posture', async ($, on) => {
  setup(on)
  await start($)
  const out = await $.command.run(RUN('proactive'))
  expect(out.text).toBe('Marcha: proactive')
  expect(out.context?.[0]).toContain('Este mensaje de marcha reemplaza cualquier postura de marcha anterior.')
  const ui = await band($)
  const text = await ui.find({ type: 'Text' })
  expect(text?.text).toContain('Proactive')
  expect(text?.props?.color).toBe('warning')
  await ui.unmount()
})

test('Rule 2: a new session shows Medium with no argument', async ($, on) => {
  setup(on)
  await start($)
  expect((await $.command.run(RUN(''))).text).toBe('Marcha: medium')
})

test('Rule 3: an unknown gear lists choices and keeps the current gear', async ($, on) => {
  setup(on)
  await start($)
  await $.command.run(RUN('lazy'))
  expect((await $.command.run(RUN('turbo'))).text).toContain('lazy|medium|proactive')
  expect((await $.command.run(RUN(''))).text).toBe('Marcha: lazy')
})

test('Rule 4: captured real worktree git output registers no command or band', async ($, on) => {
  const h = setup(on, { git: WORKTREE_GIT })
  await start($)
  expect(h.registered).not.toContain('marcha')
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /Proactive|Medium|Lazy/ })).toBeUndefined()
  await ui.unmount()
})

test('Rule 5: project config absence leaves the mod inert', async ($, on) => {
  const h = setup(on, { config: false })
  await start($)
  expect(h.registered).not.toContain('marcha')
})

test('Rule 6: a contract without Marchas leaves the mod inert', async ($, on) => {
  const h = setup(on, { contract: WITHOUT_MARCHAS })
  await start($)
  expect(h.registered).not.toContain('marcha')
})

test('Rule 7: pending setup does not turn gears off', async ($, on) => {
  const h = setup(on)
  await start($)
  expect(h.registered).toContain('marcha')
})

test('Rule 8: a resumed session loads its gear by session id', async ($, on) => {
  setup(on)
  await start($)
  await $.command.run(RUN('proactive'))
  await start($)
  expect((await $.command.run(RUN(''))).text).toBe('Marcha: proactive')
})

test('Rule 9: every posture replaces the previous one and Medium posture is delivered', async ($, on) => {
  setup(on)
  await start($)
  for (const gear of ['lazy', 'medium', 'proactive']) {
    const out = await $.command.run(RUN(gear))
    expect(out.context?.[0]).toContain('reemplaza cualquier postura de marcha anterior')
    expect(out.context?.[0]).toContain('En tu pr\u00f3ximo mensaje, empez\u00e1 con una l\u00ednea')
  }
  expect((await $.command.run(RUN('medium'))).context?.[0]).toContain('Trabaj\u00e1 seg\u00fan ODD y el contrato.')
})

test('Rule 10: no posture names excluded tools or future sections', async ($, on) => {
  setup(on)
  await start($)
  for (const gear of ['lazy', 'medium', 'proactive']) {
    const text = (await $.command.run(RUN(gear))).context?.join('\n') ?? ''
    expect(text).not.toContain('orca-stack avisar')
    expect(text).not.toContain('Consulta:')
    expect(text).not.toContain('Arena y swarm')
  }
})

test('Rule 11: the band names each gear and uses its required color', async ($, on) => {
  setup(on)
  await start($)
  for (const [gear, label, color] of [['lazy', 'Lazy', 'ide'], ['medium', 'Medium', 'success'], ['proactive', 'Proactive', 'warning']]) {
    await $.command.run(RUN(gear))
    const ui = await band($)
    const text = await ui.find({ type: 'Text' })
    expect(text?.text).toContain(label)
    expect(text?.props?.color).toBe(color)
    await ui.unmount()
  }
})

test('Rule 12: the gate reads no config keys', async ($, on) => {
  const h = setup(on)
  await start($)
  expect(h.registered).toContain('marcha')
  expect(h.reads.every(path => path.endsWith('/AGENTS.md'))).toBe(true)
  expect(AGENTS).toContain('Marchas')
})

test('Rule 1: clear starts on Medium and redraws the band after a Proactive shift', async ($, on) => {
  const h = setup(on)
  await start($)
  await $.command.run(RUN('proactive'))
  h.setSessionId('session-after-clear')

  await $.classic.SessionStart({ source: 'clear' } as never)

  expect((await $.command.run(RUN(''))).text).toBe('Marcha: medium')
  const ui = await band($)
  const text = await ui.find({ type: 'Text' })
  expect(text?.text).toContain('Medium')
  await ui.unmount()
})

test('Rule 2: compaction reinjects a shifted gear posture', async ($, on) => {
  setup(on)
  await start($)
  await $.command.run(RUN('proactive'))

  const out = await $.classic.SessionStart({ source: 'compact' } as never)

  expect(out.additionalContext?.some(text => text.includes('reemplaza cualquier postura de marcha anterior'))).toBe(true)
  expect(out.additionalContext?.some(text => text.includes('Mir\u00e1 m\u00e1s all\u00e1 del pedido'))).toBe(true)
})

test('Rule 3: compaction adds no posture before the session has shifted', async ($, on) => {
  setup(on)
  await start($)

  const out = await $.classic.SessionStart({ source: 'compact' } as never)

  expect(out.additionalContext?.some(text => text.includes('postura de marcha'))).toBe(false)
})

test('Rule 4: a compacted session without classic reinjection asks the human to repeat the shift', async ($, on) => {
  setup(on)
  await start($)
  await $.command.run(RUN('proactive'))

  await $.session.compact({ messages: [{ role: 'user', text: 'resumen', toolUses: [] }] } as never)

  const ui = await band($)
  const text = await ui.find({ type: 'Text' })
  expect(text?.text).toContain('repetí /marcha proactive')
  await ui.unmount()
})

test('Rule 5: session start prunes expired Marchas keys but keeps recent and unrelated keys', async ($, on) => {
  const h = setup(on, { store: {
    'marchas:expired': { gear: 'proactive', shiftedAt: 1 },
    'marchas:recent': { gear: 'lazy', shiftedAt: 9999999999999 },
    'marchas:legacy': 'proactive',
    'another-mod:session': { gear: 'proactive', shiftedAt: 1 },
  } })
  await start($)

  h.setSessionId('expired')
  expect((await $.command.run(RUN(''))).text).toBe('Marcha: medium')
  h.setSessionId('recent')
  expect((await $.command.run(RUN(''))).text).toBe('Marcha: lazy')
  h.setSessionId('legacy')
  expect((await $.command.run(RUN(''))).text).toBe('Marcha: proactive')
})

test('Rule 6: /marcha keeps its public result after restoring a compacted gear', async ($, on) => {
  setup(on)
  await start($)
  await $.command.run(RUN('proactive'))
  await $.classic.SessionStart({ source: 'compact' } as never)

  expect((await $.command.run(RUN(''))).text).toBe('Marcha: proactive')
})
