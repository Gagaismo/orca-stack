import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  AUTH_MESSAGE,
  MARCO,
  buildArgs,
  changeName,
  merges,
  parsePiArgs,
  parseStream,
  remember,
  segments,
} from '../hooks/puente'
import { ENTRY, SKILLS, answerStream, line, world } from './harness'
import type { Run } from './harness'

const TOOL = 'mcp__puente-gentle__consultar_gentle_shell'
const AT = new Date(2026, 9, 3, 10, 0).getTime()

const boot = async (
  $: Parameters<Parameters<typeof test>[1] & ((...a: never[]) => unknown)> extends never ? never : any,
) => {
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
}

const setup = (
  on: On,
  run: (argv: readonly string[]) => Run,
  store: Record<string, unknown> = {},
  opts: { exists?: string[]; files?: Record<string, string> } = {},
) => {
  const clock = mock.clock(on, { now: AT })
  mock.store(on, store)
  mock.env(on, { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\tester', OS: 'Windows_NT' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Agent') {
      return {
        result: {
          status: 'completed',
          agentId: 'a',
          content: [{ type: 'text', text: `Propuesta lista. Guardada en sdd/auditoria-cuotas/proposal` }],
        },
      } as never
    }

    return { result: { stdout: 'ok' } } as never
  })

  return { ...world(on, { run, ...opts }), clock }
}

const ok = (text = 'Coincido salvo en X.'): Run => ({ exitCode: 0, stdout: answerStream(text), stderr: '' })
const noAuth: Run = {
  exitCode: 1,
  stdout: line({ type: 'session', version: 3, id: 'gentle-x', cwd: '/x' }),
  stderr: 'No API key found for github-copilot.\n\nUse /login to log into a provider via OAuth or API key.',
}

const consult = ($: any, input: Record<string, string>) =>
  $.tool.call({ tool: TOOL, tool_use_id: 'u', ...input })

const textOf = (out: any): string => out.result

test('the command line carries every flag, the engram env, and runs node on the entry file', async ($, on) => {
  const w = setup(on, () => ok('Mi lectura'))
  await boot($)
  expect(w.tools).toEqual(['consultar_gentle_shell'])
  const out = await consult($, { tema: 'PR 612', planteo: 'contexto', pregunta: '¿riesgos?' })
  expect(JSON.parse(textOf(out))).toEqual({ tema: 'pr-612', respuesta: 'Mi lectura' })

  const call = w.calls[0]!
  expect(call.argv.slice(0, 2)).toEqual(['node', ENTRY])
  const args = call.argv.slice(2)
  expect(args).not.toContain('--no-context-files')
  expect(args.slice(0, 11)).toEqual([
    '-p', '--mode', 'json',
    '--no-skills', '--skill', SKILLS,
    '--session-id', 'gentle-pr-612',
    '--tools', 'read,grep,find,ls', '--append-system-prompt',
  ])
  expect(args).not.toContain('--model')
  expect(args[11]).toBe(MARCO)
  expect(args[12]).toBe('## Planteo\ncontexto\n\n## Pregunta\n¿riesgos?')
  expect(args).not.toContain('--link')
  expect(call.init.env?.ENGRAM_DATA_DIR).toBe('C:\\Users\\tester\\.gentle-shell\\engram')
  // Inherited Orca terminal and stack variables are blanked, so Pi does not report as this pane.
  expect(call.init.env?.ORCA_PANE_KEY).toBe('')
  expect(call.init.env?.ORCA_AGENT_HOOK_ENDPOINT).toBe('')
  expect(call.init.env?.ORCA_STACK_POLICY_PATH).toBe('')
  expect(call.init.stdin).toBe('')
  expect(call.init.timeoutMs).toBe(600000)
  expect(w.toasts).toEqual(['Consultando a Gentle Shell (pr-612)…', 'Gentle Shell respondió (pr-612)'])
})

test('the model comes from the option', { options: { modelo: 'otro/modelo' } }, async ($, on) => {
  const w = setup(on, () => ok())
  await boot($)
  await consult($, { tema: 't', planteo: 'p', pregunta: 'q' })
  expect(w.calls[0]!.argv).toContain('otro/modelo')
})

test('buildArgs is pure and puts the message last', () => {
  const args = buildArgs('x', 'm', 'mensaje')
  expect(args.at(-1)).toBe('mensaje')
  expect(args).toContain('gentle-x')
})

test('the JSON stream yields the last assistant text; noise and partial lines are ignored', () => {
  expect(parseStream(answerStream('Hola, listo.')).text).toBe('Hola, listo.')
  const twoTurns =
    line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Voy a leer' }], stopReason: 'toolUse' } }) +
    line({ type: 'tool_execution_end', toolName: 'read', result: { content: [{ type: 'text', text: 'archivo' }] }, isError: false }) +
    'not json\n{"broken"\n' +
    line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Respuesta final' }], stopReason: 'stop' } })
  expect(parseStream(twoTurns)).toEqual({ text: 'Respuesta final' })
  const failed = line({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom' } })
  expect(parseStream(failed).error).toBe('boom')
  const onlyDeltas = line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'abc' } })
  expect(parseStream(onlyDeltas).text).toBe('abc')
})

test('an unauthenticated launch returns the clear Spanish message and stores nothing', async ($, on) => {
  const w = setup(on, () => noAuth)
  await boot($)
  const out = await consult($, { tema: 'pr-9', planteo: 'p', pregunta: 'q' })
  expect(JSON.parse(textOf(out))).toEqual({ tema: 'pr-9', error: AUTH_MESSAGE })
  expect(AUTH_MESSAGE).toBe('Gentle Shell no tiene una cuenta conectada: abrí una terminal, corré pi y usá /login.')
  expect(w.toasts.at(-1)).toBe(AUTH_MESSAGE)
  expect(w.state.get('puente-gentle/temas')?.value).toEqual([])
})

test('exchanges are stored per tema, 20 per tema and 30 temas, newest first', () => {
  let memoria = {}
  for (let i = 0; i < 25; i += 1) {
    memoria = remember(memoria, 'a', { at: i, pregunta: `q${i}`, planteo: '', respuesta: 'r' })
  }
  expect((memoria as any).a).toHaveLength(20)
  expect((memoria as any).a[0].pregunta).toBe('q24')
  for (let i = 0; i < 35; i += 1) {
    memoria = remember(memoria, `t${i}`, { at: 100 + i, pregunta: 'q', planteo: '', respuesta: 'r' })
  }
  const keys = Object.keys(memoria)
  expect(keys).toHaveLength(30)
  expect(keys).not.toContain('a')
  expect(keys).toContain('t34')
})

test('a long planteo is stored truncated', async ($, on) => {
  const w = setup(on, () => ok())
  await boot($)
  await consult($, { tema: 'largo', planteo: 'x'.repeat(5000), pregunta: 'q' })
  const list = w.state.get('puente-gentle/temas')?.value as { tema: string; items: { planteo: string }[] }[]
  expect(list[0]!.items[0]!.planteo.length).toBeLessThan(2100)
})

test('segments split outside quotes and gh pr merge is only matched as a command', () => {
  expect(segments('a && b || c; d | e\nf')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  expect(merges('gh pr merge 612 --squash')).toEqual([{ number: '612' }])
  expect(merges('git pull && gh pr merge 5 --body "ver 77" ; gh pr merge 6')).toEqual([{ number: '5' }, { number: '6' }])
  expect(merges('gh pr merge https://github.com/o/r/pull/42')).toEqual([{ number: '42' }])
  expect(merges('gh -R o/r pr merge 7')).toEqual([{ number: '7', repo: 'o/r' }])
  expect(merges('grep "gh pr merge" docs/')).toEqual([])
  expect(merges('echo "x; gh pr merge 9"')).toEqual([])
  expect(merges('gh pr merge')).toEqual([])
  expect(merges('gh pr view 612')).toEqual([])
})

const gh = (additions: number, deletions: number): ((argv: readonly string[]) => Run) => argv =>
  argv[0] === 'gh'
    ? { exitCode: 0, stdout: JSON.stringify({ additions, deletions }), stderr: '' }
    : ok()

for (const tool of ['Bash', 'PowerShell'] as const) {
  test(`${tool}: big PR without a consult is denied, with one it passes`, async ($, on) => {
    const w = setup(on, gh(300, 150))
    await boot($)
    const denied = await $.tool.call({ tool, command: 'gh pr merge 612 --squash' } as never)
    expect(denied.deny).toBe('PR #612 grande (450 líneas): consultá a Gentle Shell (tema pr-612) antes de mergear.')
    expect(w.calls[0]!.argv).toEqual(['gh', 'pr', 'view', '612', '--json', 'additions,deletions'])

    await consult($, { tema: 'pr-612', planteo: 'p', pregunta: 'q' })
    const allowed = await $.tool.call({ tool, command: 'gh pr merge 612 --squash' } as never)
    expect(allowed.deny).toBeUndefined()
  })
}

test('small PR, exactly 400, gh failure, no number and other commands pass', async ($, on) => {
  let size: Run = { exitCode: 0, stdout: JSON.stringify({ additions: 100, deletions: 100 }), stderr: '' }
  const w = setup(on, argv => (argv[0] === 'gh' ? size : ok()))
  await boot($)
  const merge = (command: string) => $.tool.call({ tool: 'Bash', command } as never)
  expect((await merge('gh pr merge 5')).deny).toBeUndefined()
  size = { exitCode: 0, stdout: JSON.stringify({ additions: 200, deletions: 200 }), stderr: '' }
  expect((await merge('gh pr merge 5')).deny).toBeUndefined()
  size = { exitCode: 1, stdout: '', stderr: 'gh: not found' }
  expect((await merge('gh pr merge 5')).deny).toBeUndefined()
  size = { exitCode: 0, stdout: 'garbage', stderr: '' }
  expect((await merge('gh pr merge 5')).deny).toBeUndefined()
  const before = w.calls.length
  expect((await merge('gh pr merge')).deny).toBeUndefined()
  expect((await merge('grep "gh pr merge" docs/')).deny).toBeUndefined()
  expect((await merge('git status')).deny).toBeUndefined()
  expect(w.calls.length).toBe(before)
})

test('sdd-propose and sdd-design get the Gentle Shell block appended; other agents do not', async ($, on) => {
  const w = setup(on, () => ok('Yo evitaría el cache.'))
  await boot($)
  const agent = (subagent_type: string) =>
    $.tool.call({ tool: 'Agent', description: 'd', prompt: 'hacé la propuesta', subagent_type } as never) as Promise<any>

  const out = await agent('sdd-propose')
  const texts = out.result.content.map((one: any) => one.text)
  expect(texts[0]).toContain('Propuesta lista')
  expect(texts.at(-1)).toBe('--- Mirada de Gentle Shell (tema sdd-auditoria-cuotas) ---\nYo evitaría el cache.')
  const message = w.calls[0]!.argv.at(-1)!
  expect(message).toContain('Propuesta lista')
  expect(message).toContain('¿Qué ves distinto en esta propuesta/diseño? ¿Qué riesgos o alternativas no estamos viendo?')
  expect(w.calls[0]!.argv).toContain('gentle-sdd-auditoria-cuotas')

  expect((await agent('sdd-design')).result.content).toHaveLength(2)
  const callsBefore = w.calls.length
  expect((await agent('sdd-apply')).result.content).toHaveLength(1)
  expect(w.calls.length).toBe(callsBefore)
})

test('a failed consult appends the error line and never fails the agent call', async ($, on) => {
  setup(on, () => noAuth)
  await boot($)
  const out: any = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'sdd-design' } as never)
  expect(out.deny).toBeUndefined()
  expect(out.result.content.at(-1).text).toBe(`--- Mirada de Gentle Shell (tema sdd-auditoria-cuotas) ---\n${AUTH_MESSAGE}`)
})

test('a throwing process also leaves the agent result intact', async ($, on) => {
  setup(on, () => {
    throw new Error('spawn node ENOENT')
  })
  await boot($)
  const out: any = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'sdd-propose' } as never)
  expect(out.result.content.at(-1).text).toContain('No pude lanzar Gentle Shell')
  expect(out.result.content[0].text).toContain('Propuesta lista')
})

test('change names come from the topic key, the openspec path, or a timestamp', () => {
  expect(changeName('x sdd/mi-cambio/proposal y', AT)).toBe('sdd-mi-cambio')
  expect(changeName('openspec/changes/otro-cambio/design.md', AT)).toBe('sdd-otro-cambio')
  expect(changeName('change: foo_bar', AT)).toBe('sdd-foo_bar')
  expect(changeName('nada', AT)).toBe('sdd-20261003-1000')
})

test('/pi parses "tema: pregunta", derives a slug otherwise, and shows usage when empty', async ($, on) => {
  expect(parsePiArgs('pr-612: ¿ves riesgo?')).toEqual({ tema: 'pr-612', pregunta: '¿ves riesgo?' })
  expect(parsePiArgs('¿Conviene separar la cuota del PR?')).toEqual({
    tema: 'conviene-separar-la-cuota',
    pregunta: '¿Conviene separar la cuota del PR?',
  })
  expect(parsePiArgs('   ')).toBeUndefined()

  const w = setup(on, () => ok())
  const clock = w.clock
  await boot($)
  const run = (args: string) =>
    $.command.run({ command: 'pi', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect((await run('')).text).toContain('Uso: /pi <tema>: <pregunta>')
  expect((await run('sdd-auditoria: ¿está bien el corte?')).text).toBe('Consultando a Gentle Shell (tema sdd-auditoria)…')
  await clock.advance(1)
  await clock.settle()
  expect(w.submitted).toEqual([
    'Consultá a Gentle Shell (tema sdd-auditoria) sobre: ¿está bien el corte?. Usá consultar_gentle_shell con un planteo neutral y después mostrame las dos posturas.',
  ])
})

test('the system prompt gets one session section, last', async ($, on) => {
  setup(on, () => ok())
  await boot($)
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const last = out.sections.at(-1)!
  expect(last.scope).toBe('session')
  expect(last.text).toContain('consultar_gentle_shell')
  expect(last.text).toContain('las dos posturas')
})

test('/gentle lists temas, expands the chosen one and copies an answer', async ($, on) => {
  const seeded = {
    uno: [{ at: AT, pregunta: 'pregunta uno', planteo: 'p', respuesta: 'respuesta uno' }],
    dos: [{ at: AT + 60000, pregunta: 'pregunta dos', planteo: 'p', respuesta: 'respuesta dos' }],
  }
  const w = setup(on, () => ok(), { temas: seeded })
  await boot($)
  const out = await $.command.run({ command: 'gentle', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(out.text).toBe('Panel de Gentle Shell abierto.')
  let ui = await $.ui.mount({
    plugin: 'puente-gentle',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'gentle',
    props: { title: 'Gentle Shell', isFocused: false, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /respuesta dos/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /respuesta uno/ })).toBeUndefined()
  await ui.press({ key: 'tema:uno' })
  expect(w.state.get('puente-gentle/sel')?.value).toBe('uno')
  // The real engine redraws on the state change; the test world does not subscribe, so remount.
  await ui.unmount()
  ui = await $.ui.mount({
    plugin: 'puente-gentle',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'gentle',
    props: { title: 'Gentle Shell', isFocused: false, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /respuesta uno/ })).toBeDefined()
  await ui.press({ key: 'copy:uno:0' })
  expect(w.copied).toEqual(['respuesta uno'])
  await ui.unmount()
})

const compose = ($: any) =>
  $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })

test('the human name comes from the personal config layer, with a neutral fallback', async ($, on) => {
  const personal = 'C:\\Users\\tester\\.orca-stack\\config.json'
  const w = setup(on, () => ok(), {}, { files: { [personal]: JSON.stringify({ humano: 'Ana' }) } })
  await boot($)
  expect((await compose($)).sections.at(-1)?.text).toContain('mostrale a Ana las dos posturas')
  expect(w.calls.length).toBeGreaterThan(0)
})

test('without a name the section talks to "el usuario"', async ($, on) => {
  setup(on, () => ok())
  await boot($)
  expect((await compose($)).sections.at(-1)?.text).toContain('mostrale al usuario las dos posturas')
})

test('the skills dir falls back to the npm-global install, then to no skills at all', async ($, on) => {
  const global = 'C:\\npm-global\\node_modules\\gentle-pi\\skills'
  const w = setup(
    on,
    argv => (argv[0] === 'npm.cmd' ? { exitCode: 0, stdout: 'C:\\npm-global\\node_modules\n', stderr: '' } : ok()),
    {},
    { exists: [ENTRY, global] },
  )
  await boot($)
  await consult($, { tema: 'a', planteo: 'p', pregunta: 'q' })
  const piCall = w.calls.find(call => call.argv[0] === 'node')!
  expect(piCall.argv).toContain(global)
})

test('with no Gentle Shell skills anywhere the consult still runs, without --skill', async ($, on) => {
  const w = setup(on, argv => (argv[0] === 'npm.cmd' ? { exitCode: 1, stdout: '', stderr: 'x' } : ok()), {}, { exists: [ENTRY] })
  await boot($)
  await consult($, { tema: 'a', planteo: 'p', pregunta: 'q' })
  const piCall = w.calls.find(call => call.argv[0] === 'node')!
  expect(piCall.argv).toContain('--no-skills')
  expect(piCall.argv).not.toContain('--skill')
})
