import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import { AGENTS, harness, WITHOUT_MARCHAS, WORKTREE_GIT } from './harness'

const RUN = (args: string) => ({
  command: 'marcha',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})
const STEP = (effort: string, agentId?: string) => ({
  turnId: 't1',
  index: 0,
  model: 'claude-sonnet-4-5',
  effort,
  messageCount: 1,
  agentId,
})
const COMMAND = (command: string, args: string) => ({
  command,
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
const observeSteps = (on: On) => {
  const requests: Array<{ effort?: string; agentId?: string }> = []
  on('turn.step', async function* (_$, e) {
    requests.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })

  return {
    requests,
    run: async ($: EngineInterface, effort: string, agentId?: string, model = 'claude-sonnet-4-5') => {
      const stream = $.turn.step({ ...STEP(effort, agentId), model } as never)
      for await (const _ of stream) { /* Drain the response stream. */ }
      await stream.result
    },
  }
}

test('Rule 1: proactive shift shows its marker, warning band, and hidden posture', async ($, on) => {
  setup(on)
  await start($)
  const out = await $.command.run(RUN('proactive'))
  expect(out.text).toBe('Marcha: proactive (esfuerzo m\u00ednimo: xhigh)')
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
  expect((await $.command.run(RUN(''))).text).toBe('Marcha: medium (sin reescritura de esfuerzo)')
})

test('Rule 3: an unknown gear lists choices and keeps the current gear', async ($, on) => {
  setup(on)
  await start($)
  await $.command.run(RUN('lazy'))
  expect((await $.command.run(RUN('turbo'))).text).toContain('lazy|medium|proactive')
  expect((await $.command.run(RUN(''))).text).toBe('Marcha: lazy (esfuerzo m\u00e1ximo: medium)')
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
  expect((await $.command.run(RUN(''))).text).toBe('Marcha: proactive (esfuerzo m\u00ednimo: xhigh)')
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

test('Rule 10: postures avoid excluded tools while Medium and Proactive name arena signals', async ($, on) => {
  setup(on)
  await start($)
  const postures = new Map<string, string>()
  for (const gear of ['lazy', 'medium', 'proactive']) {
    const text = (await $.command.run(RUN(gear))).context?.join('\n') ?? ''
    postures.set(gear, text)
    expect(text).not.toContain('orca-stack avisar')
    expect(text).not.toContain('Consulta:')
  }
  expect(postures.get('lazy')).not.toContain('Arena y swarm')
  expect(postures.get('medium')).toContain('Propon\u00e9 arena o swarm cuando un requisito muestre se\u00f1ales de la secci\u00f3n "Arena y swarm" del contrato.')
  expect(postures.get('proactive')).toContain('Propon\u00e9 arena o swarm temprano, ante se\u00f1ales m\u00e1s d\u00e9biles, antes de que aparezca un problema.')
})

test('Rule 13: Lazy keeps its prohibition on proposing arena or swarm', async ($, on) => {
  setup(on)
  await start($)
  const text = (await $.command.run(RUN('lazy'))).context?.join('\n') ?? ''
  expect(text).toContain('No propongas arena ni swarm.')
  expect(text).not.toContain('Propon\u00e9 arena')
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

test("Rule 7: Proactive's posture carries the collaboration sentence", async ($, on) => {
  setup(on)
  await start($)
  const out = await $.command.run(RUN('proactive'))
  const text = out.context?.[0] ?? ''
  expect(text).toContain('Colabor\u00e1 con los workers de implementaci\u00f3n hasta que abran su PR')
  expect(text).toContain('vigil\u00e1 sus issues y PRs en busca de preguntas')
  expect(text).toContain('respond\u00e9 las preguntas de ejecuci\u00f3n donde las hayan hecho')
  expect(text).toContain('llev\u00e1 las de producto e interpretaci\u00f3n al humano y transmit\u00ed la respuesta del mismo modo')
  expect(text).toContain('avisales lo que cambiar\u00eda su trabajo y no pueden ver')
  expect(text).toContain('Nunca los hagas esperar, nunca corrijas su c\u00f3digo, y dej\u00e1 en paz a los revisores')
  expect(text).toContain('Propon\u00e9 arena o swarm temprano, ante se\u00f1ales m\u00e1s d\u00e9biles, antes de que aparezca un problema.')
  expect(text.indexOf('Colabor\u00e1 con los workers de implementaci\u00f3n')).toBeLessThan(text.indexOf('Propon\u00e9 arena o swarm temprano'))
  expect(text).not.toContain('orca-stack avisar')
})

test("#166 Rule 10: Proactive's posture now carries the doorbell clause", async ($, on) => {
  setup(on)
  await start($)
  const clause = 'respond\u00e9 las preguntas de ejecuci\u00f3n donde las hayan hecho y tocales el timbre en su terminal, solo mientras su turno est\u00e9 en curso, con una l\u00ednea que apunte a la respuesta'
  expect((await $.command.run(RUN('proactive'))).context?.[0]).toContain(clause)
  for (const gear of ['lazy', 'medium']) expect((await $.command.run(RUN(gear))).context?.[0]).not.toContain('timbre')
})

test('Rule 1: clear starts on Medium and redraws the band after a Proactive shift', async ($, on) => {
  const h = setup(on)
  await start($)
  await $.command.run(RUN('proactive'))
  h.setSessionId('session-after-clear')

  await $.classic.SessionStart({ source: 'clear' } as never)

  expect((await $.command.run(RUN(''))).text).toBe('Marcha: medium (sin reescritura de esfuerzo)')
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
  expect(text?.text).toContain('repet\u00ed /marcha proactive')
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
  expect((await $.command.run(RUN(''))).text).toBe('Marcha: medium (sin reescritura de esfuerzo)')
  h.setSessionId('recent')
  expect((await $.command.run(RUN(''))).text).toBe('Marcha: lazy (esfuerzo m\u00e1ximo: medium)')
  h.setSessionId('legacy')
  expect((await $.command.run(RUN(''))).text).toBe('Marcha: proactive (esfuerzo m\u00ednimo: xhigh)')
})

test('Rule 6: /marcha keeps its public result after restoring a compacted gear', async ($, on) => {
  setup(on)
  await start($)
  await $.command.run(RUN('proactive'))
  await $.classic.SessionStart({ source: 'compact' } as never)

  expect((await $.command.run(RUN(''))).text).toBe('Marcha: proactive (esfuerzo m\u00ednimo: xhigh)')
})

test("Rule 1: Lazy caps main requests at medium and leaves subagent effort unchanged", async ($, on) => {
  setup(on)
  const requests: Array<{ effort?: string; agentId?: string }> = []
  on('turn.step', async function* (_$, e) {
    requests.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  await start($)
  await $.command.run(RUN('lazy'))

  const main = $.turn.step(STEP('xhigh') as never)
  for await (const _ of main) { /* Drain the response stream. */ }
  await main.result
  const subagent = $.turn.step(STEP('xhigh', 'agent-1') as never)
  for await (const _ of subagent) { /* Drain the response stream. */ }
  await subagent.result

  expect(requests.map(({ effort }) => effort)).toEqual(['medium', 'xhigh'])
  expect(requests[1]?.agentId).toBe('agent-1')
})

test('Rule 2: Lazy never raises a low baseline', async ($, on) => {
  setup(on)
  const turns = observeSteps(on)
  await start($)
  await $.command.run(RUN('lazy'))
  await turns.run($, 'low')

  expect(turns.requests[0]?.effort).toBe('low')
})

test('Rule 3: Proactive raises high to xhigh but preserves max', async ($, on) => {
  const h = setup(on)
  const turns = observeSteps(on)
  await start($)
  await $.command.run(RUN('proactive'))
  await turns.run($, 'high')
  h.setSessionId('max-baseline')
  await start($)
  await $.command.run(RUN('proactive'))
  await turns.run($, 'max')

  expect(turns.requests.map(({ effort }) => effort)).toEqual(['xhigh', 'max'])
})

test('Rule 4: Medium does not rewrite effort', async ($, on) => {
  setup(on)
  const turns = observeSteps(on)
  await start($)
  await $.command.run(RUN('medium'))
  await turns.run($, 'xhigh')

  expect(turns.requests[0]?.effort).toBe('xhigh')
})

test('Rule 5: same-value /effort xhigh disables Lazy rewriting', async ($, on) => {
  setup(on)
  const turns = observeSteps(on)
  let commandOrigin: string | undefined
  on('command.run', { command: 'effort' }, (_$, e) => {
    commandOrigin = e.origin.kind
    return { text: '' }
  })
  await start($)
  await $.command.run(RUN('lazy'))
  await turns.run($, 'xhigh')
  await $.command.run(COMMAND('effort', 'xhigh'))
  await turns.run($, 'xhigh')

  expect(commandOrigin).toBe('composer')
  expect(turns.requests.map(({ effort }) => effort)).toEqual(['medium', 'xhigh'])
})

test('Rule 6: /effort ultracode keeps Lazy rewriting active', async ($, on) => {
  setup(on)
  const turns = observeSteps(on)
  on('command.run', { command: 'effort' }, () => ({ text: '' }))
  await start($)
  await $.command.run(RUN('lazy'))
  await turns.run($, 'xhigh')
  await $.command.run(COMMAND('effort', 'ultracode'))
  await turns.run($, 'xhigh')

  expect(turns.requests.map(({ effort }) => effort)).toEqual(['medium', 'medium'])
})

test('Rule 7: /model updates Lazy baseline to the new model effort', async ($, on) => {
  setup(on)
  const turns = observeSteps(on)
  let commandOrigin: string | undefined
  on('command.run', { command: 'model' }, (_$, e) => {
    commandOrigin = e.origin.kind
    return { text: '' }
  })
  await start($)
  await $.command.run(RUN('lazy'))
  await turns.run($, 'xhigh')
  await $.command.run(COMMAND('model', 'claude-opus-4-1'))
  await turns.run($, 'high', undefined, 'claude-opus-4-1')

  expect(commandOrigin).toBe('composer')
  expect(turns.requests.map(({ effort }) => effort)).toEqual(['medium', 'medium'])
})

test('Rule 8: Proactive shift clears a low manual override and applies its minimum', async ($, on) => {
  setup(on)
  const turns = observeSteps(on)
  on('command.run', { command: 'effort' }, () => ({ text: '' }))
  await start($)
  await $.command.run(RUN('lazy'))
  await turns.run($, 'xhigh')
  await $.command.run(COMMAND('effort', 'low'))
  await $.command.run(RUN('proactive'))
  await turns.run($, 'low')

  expect(turns.requests.at(-1)?.effort).toBe('xhigh')
})

test('Rule 9: /effort override persists when the session resumes', async ($, on) => {
  setup(on)
  const turns = observeSteps(on)
  on('command.run', { command: 'effort' }, () => ({ text: '' }))
  await start($)
  await $.command.run(RUN('lazy'))
  await turns.run($, 'xhigh')
  await $.command.run(COMMAND('effort', 'xhigh'))
  await $.session.compact({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  await $.classic.SessionStart({ source: 'compact' } as never)
  await start($)
  await turns.run($, 'xhigh')

  expect(turns.requests.map(({ effort }) => effort)).toEqual(['medium', 'xhigh'])
})

test("Rule 10: a worker's worktree does not rewrite persisted Lazy gear effort", async ($, on) => {
  setup(on, { git: WORKTREE_GIT, store: { 'marchas:session-1': { gear: 'lazy', shiftedAt: 1 } } })
  const turns = observeSteps(on)
  await start($)
  await turns.run($, 'xhigh')

  expect(turns.requests[0]?.effort).toBe('xhigh')
})

test('Rule 15: /marcha names the effort policy for every gear', async ($, on) => {
  setup(on)
  await start($)

  expect((await $.command.run(RUN('lazy'))).text).toContain('esfuerzo m\u00e1ximo: medium')
  expect((await $.command.run(RUN('medium'))).text).toContain('sin reescritura de esfuerzo')
  expect((await $.command.run(RUN('proactive'))).text).toContain('esfuerzo m\u00ednimo: xhigh')
})

test('Preserve /marcha gear change and posture with the effort label', async ($, on) => {
  setup(on)
  await start($)

  const out = await $.command.run(RUN('lazy'))
  expect(out.text).toContain('Marcha: lazy')
  expect(out.context?.[0]).toContain('Este mensaje de marcha reemplaza cualquier postura de marcha anterior.')
  expect((await $.command.run(RUN(''))).text).toContain('Marcha: lazy')
})
