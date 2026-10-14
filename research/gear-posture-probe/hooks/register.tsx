import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// Throwaway probe for map #118, ticket #153. Never in mods/, never released.
const DIR = 'C:/Users/lautaro/AppData/Local/Temp/claude/C--Users-lautaro-Documents-orca-stack/5b9fc20e-4724-40be-bd9b-a7d530cb9d62/scratchpad/gear-probe-data'
const LOG = DIR + '/log.jsonl'
const MODE = DIR + '/mode.txt' // comma list: compose, command, perturn, context
const GEAR = DIR + '/gear.txt' // lazy | medium | proactive
const ULTRA = DIR + '/ultra.txt' // non-empty: run `/effort ultracode` at session.start

const gearAtom = atom({ plugin: 'gear-probe', key: 'gear' } as const, '')

const POSTURE: Record<string, string> = {
  lazy: [
    'POSTURA-PROBE lazy. Gear: Lazy.',
    'Carry out work that is already specified: dispatch tickets that are ready, watch their PRs, merge when the merge condition holds, or implement a specified ticket in single-agent mode.',
    'Do not explore beyond what the next step needs, do not research, do not propose work beyond the request, and keep narration to one line per step.',
    'When an item stops being specified (an open product question, a missing rule, an unclear failure), suggest an upshift for that item in one line and leave it waiting until someone shifts; keep going with the rest.',
    'Fixed rules do not change with the gear: permissions, merge conditions, one-way doors, asking before irreversible actions, never answering for the human.',
  ].join('\n'),
  medium: [
    'POSTURA-PROBE medium. Gear: Medium.',
    'Work as the baseline: explore proportionately to the request, delegate by the triggers of the workflow, consult the peer at the decision points the project names, and ask the human only for real product decisions.',
    'Fixed rules do not change with the gear: permissions, merge conditions, one-way doors, asking before irreversible actions, never answering for the human.',
  ].join('\n'),
  proactive: [
    'POSTURA-PROBE proactive. Gear: Proactive.',
    'Explore through subagents before deciding, so the main context stays thin; read the surrounding code, the tickets around the one at hand and the history of the area.',
    'Propose work beyond the request when it improves quality, outside the dispatchable tickets, and say why in one line each.',
    'Consult the peer orchestrator at the named moments: choosing between approaches, after a design, before merging a large PR, and when a bug cause is still unclear after one attempt.',
    'Collaborate with dispatched workers from dispatch until their PR opens: answer execution questions where they were asked, relay product and interpretation questions to the human, and tell workers what they cannot see.',
    'Consider arena or swarm when a requirement looks problematic, before the problem shows up and after it, and propose it to the human; never run an arena without the human OK.',
    'Fixed rules do not change with the gear: permissions, merge conditions, one-way doors, asking before irreversible actions, never answering for the human.',
  ].join('\n'),
}

async function opt($: any, p: string): Promise<string> {
  return (await $.fs.exists(p)) ? String(await $.fs.read(p)).trim() : ''
}

// Hooks run concurrently: chain the read-modify-write so rows never interleave.
let queue: Promise<void> = Promise.resolve()
function log($: any, row: object): Promise<void> {
  const line = JSON.stringify({ t: Date.now(), ...row }) + '\n'
  queue = queue.then(async () => {
    const old = (await $.fs.exists(LOG)) ? await $.fs.read(LOG) : ''
    await $.fs.write(LOG, old + line)
  }).catch(() => {})
  return queue
}

const modes = async ($: any) => (await opt($, MODE)).split(',').map(s => s.trim()).filter(Boolean)
const posture = async ($: any) => POSTURE[(await opt($, GEAR)) || 'medium'] ?? POSTURE.medium
const hits = (s: string) => /ultracode|dynamic workflow/i.test(s)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'marcha', description: 'Probe: shift gear', argumentHint: '<lazy|medium|proactive>' })
    const s: any = await $.settings.read()
    const settingsHits = Object.fromEntries(Object.entries(s).filter(([k]) => /ultra|workflow|effort/i.test(k)))
    const { value: stateGear } = await $.state.get({ plugin: 'gear-probe', key: 'gear' })
    await log($, { ev: 'start', sid: await $.session.id(), settingsHits, stateGear: stateGear ?? null, input: e })
    const gear = (await opt($, GEAR)) || 'medium'
    $.ui.status(`probe marcha: ${gear}`)
    if (await opt($, ULTRA)) {
      try {
        const res = await $.command.run({ command: 'effort', args: 'ultracode' })
        await log($, { ev: 'ultra.run', res })
      } catch (err) {
        await log($, { ev: 'ultra.run', err: String(err) })
      }
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    await log($, { ev: 'end', reason: e.reason, sessionId: e.sessionId, resume: e.resume })
    return next(e)
  })

  on('command.run', { command: 'marcha' }, async ($, e) => {
    const gear = e.args.trim() || 'medium'
    await $.fs.write(GEAR, gear)
    await update($, gearAtom, () => gear)
    const sid = await $.session.id()
    await $.store.set(`gear:${sid}`, gear)
    $.ui.status(`probe marcha: ${gear}`)
    const m = await modes($)
    await log($, { ev: 'marcha', sid, gear, modes: m })
    return m.includes('command')
      ? { text: `Marcha: ${gear}`, context: [POSTURE[gear] ?? POSTURE.medium] }
      : { text: `Marcha: ${gear}` }
  })

  // Observe the built-in /effort: does a mod see `/effort ultracode` when it runs?
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const r = await next(e)
    await log($, { ev: 'effort.cmd', args: e.args, text: r?.text ?? null })
    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const ids = r.sections.map(x => `${x.id}:${x.scope}:${x.text.length}`)
    const ultraIds = r.sections.filter(x => hits(x.text)).map(x => x.id)
    await log($, { ev: 'compose', traits: e.traits, tools: e.tools.filter(t => /workflow|agent/i.test(t)), ids, ultraIds })
    const m = await modes($)
    if (!m.includes('compose')) {
      await log($, { ev: 'compose.skip', modes: m })
      return r
    }
    const text = await posture($)
    const id = m.includes('idpergear') ? `gear-probe:postura-${(await opt($, GEAR)) || 'medium'}` : 'gear-probe:postura'
    await log($, { ev: 'compose.add', id, head: text.slice(0, 40), len: text.length })
    return { sections: [...r.sections, { id, text, scope: 'session' as const }] }
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    await log($, { ev: 'context', names: r.blocks.map(b => `${b.name}:${b.text.length}`) })
    if (!(await modes($)).includes('context')) return r
    return { blocks: [...r.blocks, { name: 'gearPosture', text: await posture($) }] }
  })

  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    const text = (r as any)?.text ?? ''
    await log($, { ev: 'attach', type: (e as any).type, len: text ? text.length : null, ultra: text ? hits(text) : false, head: text ? String(text).slice(0, 160) : null })
    return r
  })

  // Before each turn: on a gear change, drop the engine's cached section answers.
  let lastGear: string | null = null
  on('prompt.submit', async ($, e, next) => {
    const gear = (await opt($, GEAR)) || 'medium'
    const m = await modes($)
    if (lastGear !== null && gear !== lastGear && m.includes('invalidate')) {
      $.ui.invalidate('prompt.section')
      await log($, { ev: 'invalidate', from: lastGear, to: gear })
    }
    if (lastGear !== null && gear !== lastGear && m.includes('context')) {
      $.ui.invalidate('prompt.context')
      await log($, { ev: 'invalidate.context', from: lastGear, to: gear })
    }
    lastGear = gear
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r: any = await next(e)
    const m = await modes($)
    await log($, { ev: 'classic.SessionStart', source: (e as any).source, sid: await $.session.id(), reinject: m.includes('reinject') })
    if (!m.includes('reinject')) return r
    return { ...r, additionalContext: [...(r?.additionalContext ?? []), await posture($)] }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r: any = await next(e)
    if (!(await modes($)).includes('perturn')) return r
    return { ...r, additionalContext: [...(r?.additionalContext ?? []), await posture($)] }
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (!e.agentId) {
      const sid = await $.session.id()
      const { value: stateGear } = await $.state.get({ plugin: 'gear-probe', key: 'gear' })
      await log($, { ev: 'step', sid, keys: Object.keys(e), index: e.index, messageCount: e.messageCount, effort: e.effort ?? null, stateGear: stateGear ?? null, storeGear: (await $.store.get(`gear:${sid}`)) ?? null, usage: r?.usage ?? null })
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const gear = (await read($, gearAtom)) || 'medium'
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color={gear === 'lazy' ? 'suggestion' : gear === 'proactive' ? 'warning' : 'success'} bold>Marcha: {gear}</Text>
        <Box>
          <Text color="suggestion">Lazy(suggestion) </Text>
          <Text color="permission">Lazy(permission) </Text>
          <Text color="blue">Lazy(blue) </Text>
          <Text color="success">Medium(success) </Text>
          <Text color="green">Medium(green) </Text>
          <Text color="warning">Proactive(warning) </Text>
          <Text color="yellow">Proactive(yellow) </Text>
          <Text color="#FFBF00">Proactive(#FFBF00)</Text>
        </Box>
      </Box>
    )
  })
}
