import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

import { harness } from './harness'

const RUN = (args: string) => ({
  command: 'marcha',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})
const EFFORT = (args: string) => ({
  command: 'effort',
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

// Same shape as marchas.test.ts: the last turn.step handler records the effort that reaches "downstream" (the API request).
const setup = (on: On) => {
  mock.store(on)
  const h = harness(on)
  const requests: Array<{ effort?: string; agentId?: string }> = []
  on('turn.step', async function* (_$, e) {
    requests.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  // The built-in /effort sits below the mod; with empty args it would open the menu (nothing to record here).
  on('command.run', { command: 'effort' }, () => ({ text: '' }))

  return {
    ...h,
    requests,
    step: async ($: EngineInterface, effort: string, agentId?: string) => {
      const stream = $.turn.step(STEP(effort, agentId) as never)
      for await (const _ of stream) { /* Drain the response stream. */ }
      await stream.result
    },
  }
}
const start = ($: EngineInterface) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const efforts = (t: { requests: Array<{ effort?: string }> }) => t.requests.map(r => r.effort)

test('repro #164 live sequence: picker -> xhigh, then /marcha lazy => Lazy still caps at medium', async ($, on) => {
  const t = setup(on)
  await start($)
  await $.command.run(EFFORT('xhigh'))
  await $.command.run(EFFORT('medium'))
  await $.command.run(EFFORT('')) // picker opened; the choice (xhigh) never reaches the mod as args
  await $.command.run(RUN('lazy'))
  await $.command.run(RUN('medium'))
  await $.command.run(RUN('proactive'))
  await $.command.run(RUN('lazy'))
  await t.step($, 'xhigh') // engine's effort is now xhigh (picker choice)

  expect(efforts(t)).toEqual(['medium'])
})

test('control A: typed /effort medium, /marcha lazy, turn effort medium => medium', async ($, on) => {
  const t = setup(on)
  await start($)
  await $.command.run(EFFORT('medium'))
  await $.command.run(RUN('lazy'))
  await t.step($, 'medium')

  expect(efforts(t)).toEqual(['medium'])
})

test('control A2: same live sequence but the xhigh is TYPED (/effort xhigh) instead of picked => medium', async ($, on) => {
  const t = setup(on)
  await start($)
  await $.command.run(EFFORT('xhigh'))
  await $.command.run(EFFORT('medium'))
  await $.command.run(EFFORT('xhigh')) // typed with args: the mod records it
  await $.command.run(RUN('lazy'))
  await $.command.run(RUN('medium'))
  await $.command.run(RUN('proactive'))
  await $.command.run(RUN('lazy'))
  await t.step($, 'xhigh')

  expect(efforts(t)).toEqual(['medium'])
})

test('control B: picker AFTER the last /marcha lazy -> xhigh => xhigh kept (manual /effort wins)', async ($, on) => {
  const t = setup(on)
  await start($)
  await $.command.run(EFFORT('medium'))
  await $.command.run(RUN('lazy'))
  await $.command.run(EFFORT('')) // picker -> xhigh
  await t.step($, 'xhigh')

  expect(efforts(t)).toEqual(['xhigh'])
})

test('Rule 4: opening the menu without changing the level keeps Lazy capping', async ($, on) => {
  const t = setup(on)
  await start($)
  await $.command.run(RUN('lazy'))
  await t.step($, 'xhigh')
  await $.command.run(EFFORT('')) // menu opened, nothing chosen
  await t.step($, 'xhigh')

  expect(efforts(t)).toEqual(['medium', 'medium'])
})

test('Rule 5: /marcha with no args and /marcha foo leave an open menu mark alone', async ($, on) => {
  const t = setup(on)
  await start($)
  await $.command.run(RUN('lazy'))
  await t.step($, 'medium')
  await $.command.run(EFFORT(''))
  await $.command.run(RUN(''))
  await $.command.run(RUN('foo'))
  await t.step($, 'xhigh')

  expect(efforts(t)).toEqual(['medium', 'xhigh'])
})

test('Rule 6: a subagent step does not consume the menu mark', async ($, on) => {
  const t = setup(on)
  await start($)
  await $.command.run(EFFORT('medium'))
  await $.command.run(RUN('lazy'))
  await t.step($, 'medium')
  await $.command.run(EFFORT(''))
  await t.step($, 'xhigh', 'agent-1')
  await t.step($, 'xhigh')

  expect(efforts(t)).toEqual(['medium', 'xhigh', 'xhigh'])
  expect(t.requests[1]?.agentId).toBe('agent-1')
  expect(t.requests[2]?.agentId).toBeUndefined()
})

test('Rule 7: /effort auto counts like the menu', async ($, on) => {
  const t = setup(on)
  await start($)
  await $.command.run(RUN('lazy'))
  await t.step($, 'medium')
  await $.command.run(EFFORT('auto'))
  await t.step($, 'xhigh')

  expect(efforts(t)).toEqual(['medium', 'xhigh'])
})

test('Rule 8: the menu mark survives a resume', async ($, on) => {
  const t = setup(on)
  await start($)
  await $.command.run(EFFORT('medium'))
  await $.command.run(RUN('lazy'))
  await t.step($, 'medium')
  await $.command.run(EFFORT(''))
  t.emptyState() // a resume is a new process
  await start($)
  await t.step($, 'xhigh')

  expect(efforts(t)).toEqual(['medium', 'xhigh'])
})

test('Rule 9: an effort change with no /effort since the last shift is not manual', async ($, on) => {
  const t = setup(on)
  await start($)
  await $.command.run(RUN('lazy'))
  await t.step($, 'medium')
  await t.step($, 'xhigh')

  expect(efforts(t)).toEqual(['medium', 'medium'])
})

test('Rule 9: a consumed menu mark does not make a later silent change manual', async ($, on) => {
  const t = setup(on)
  await start($)
  await $.command.run(RUN('lazy'))
  await t.step($, 'medium')
  await $.command.run(EFFORT(''))
  await t.step($, 'medium') // consumes the mark
  await $.command.run(RUN('lazy'))
  await t.step($, 'xhigh')

  expect(efforts(t)).toEqual(['medium', 'medium', 'medium'])
})

test('Rule 10 (known limit): a menu opened and cancelled after the shift reads a stale menu choice as manual', async ($, on) => {
  const t = setup(on)
  await start($)
  await $.command.run(EFFORT('medium'))
  await $.command.run(EFFORT('')) // menu choice: xhigh
  await $.command.run(RUN('lazy'))
  await $.command.run(EFFORT('')) // menu opened and cancelled
  await t.step($, 'xhigh')

  expect(efforts(t)).toEqual(['xhigh'])
})
