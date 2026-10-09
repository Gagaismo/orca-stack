import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  AUTH_MESSAGE,
  MARCO,
  buildArgs,
  changeName,
  globToRegExp,
  implementerOf,
  merges,
  piClaudeConfigDir,
  riskyFile,
  parsePiArgs,
  parseStream,
  remember,
  reviewsOf,
  segments,
} from '../hooks/puente'
import familias from './familias'
import { blockOf, familyOf, mergeConfig } from '../hooks/orca-config'
import type { StackConfig } from '../hooks/orca-config'
import { ENTRY, SKILLS, answerStream, line, world } from './harness'
import type { Run } from './harness'

const TOOL = 'mcp__puente-gentle__consultar_gentle_shell'
// Where the engine resolves the config of the fake repo at /p.
const PROJECT_CONFIG = 'C:\\p\\.orca-stack.json'
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
  opts: { exists?: string[]; files?: Record<string, string>; project?: boolean } = {},
) => {
  const { project, ...rest } = opts
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

  // project: a repo at /p with its own .orca-stack.json (the mod injects text only there).
  const inProject = (argv: readonly string[]): Run =>
    argv[0] === 'git' ? { exitCode: 0, stdout: '/p/.git\n/p\n', stderr: '' } : run(argv)
  const files = project ? { [PROJECT_CONFIG]: '{}', ...rest.files } : rest.files

  return { ...world(on, { ...rest, run: project ? inProject : run, files }), clock }
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
  const w = setup(on, () => ok('Mi lectura'), {}, { project: true })
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
    const w = setup(on, gh(300, 150), {}, { project: true })
    await boot($)
    const denied = await $.tool.call({ tool, command: 'gh pr merge 612 --squash' } as never)
    expect(denied.deny).toBe('PR #612 grande (450 líneas): consultá a Gentle Shell (tema pr-612) antes de mergear.')
    expect(w.calls[0]!.argv).toEqual(['gh', 'pr', 'view', '612', '--json', 'additions,deletions,files,headRefOid,body,comments,reviews'])

    await consult($, { tema: 'pr-612', planteo: 'p', pregunta: 'q' })
    const allowed = await $.tool.call({ tool, command: 'gh pr merge 612 --squash' } as never)
    expect(allowed.deny).toBeUndefined()
  })
}

test('small PR, exactly 400, gh failure, no number and other commands pass', async ($, on) => {
  let size: Run = { exitCode: 0, stdout: JSON.stringify({ additions: 100, deletions: 100 }), stderr: '' }
  const w = setup(on, argv => (argv[0] === 'gh' ? size : ok()), {}, { project: true })
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

test('outside an orca-stack project a big PR merges: there is no consult tool to satisfy the gate', async ($, on) => {
  const w = setup(on, gh(300, 150))
  await boot($)
  expect(w.tools).toEqual([])
  expect((await $.tool.call({ tool: 'Bash', command: 'gh pr merge 612 --squash' } as never)).deny).toBeUndefined()
})

test('a repo with only .orca-stack.local.json has the tool, the criterio section and the big-PR gate', async ($, on) => {
  const local = { [PROJECT_CONFIG.replace('.orca-stack.json', '.orca-stack.local.json')]: '{}' }
  const inRepo = (argv: readonly string[]): Run =>
    argv[0] === 'git' ? { exitCode: 0, stdout: '/p/.git\n/p\n', stderr: '' } : gh(300, 150)(argv)
  const w = setup(on, inRepo, {}, { files: local })
  await boot($)
  expect(w.tools).toEqual(['consultar_gentle_shell'])
  expect((await compose($)).sections.map((one: { id: string }) => one.id)).toEqual(['puente-gentle:criterio'])
  const denied = await $.tool.call({ tool: 'Bash', command: 'gh pr merge 612 --squash' } as never)
  expect(denied.deny).toContain('grande (450 líneas)')
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
  setup(on, () => ok(), {}, { project: true })
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

test('without orca-stack config there is no criterio section and no tool; the commands stay', async ($, on) => {
  const w = setup(on, () => ok())
  await boot($)
  expect(w.tools).toEqual([])
  expect(w.registered).toEqual(['pi', 'gentle'])
  expect((await compose($)).sections).toEqual([])
})

test('a repo that is not a git checkout has no project config either', async ($, on) => {
  const w = setup(on, () => ok(), {}, { files: { [PROJECT_CONFIG]: '{}' } })
  await boot($)
  expect(w.tools).toEqual([])
  expect((await compose($)).sections).toEqual([])
})

test('with .orca-stack.json both the tool and the criterio section are there', async ($, on) => {
  const w = setup(on, () => ok(), {}, { project: true })
  await boot($)
  expect(w.tools).toEqual(['consultar_gentle_shell'])
  expect((await compose($)).sections.map((one: { id: string }) => one.id)).toEqual(['puente-gentle:criterio'])
})

test('the human name comes from the personal config layer, with a neutral fallback', async ($, on) => {
  const personal = 'C:\\Users\\tester\\.orca-stack\\config.json'
  const w = setup(on, () => ok(), {}, { project: true, files: { [personal]: JSON.stringify({ humano: 'Ana' }) } })
  await boot($)
  expect((await compose($)).sections.at(-1)?.text).toContain('mostrale a Ana las dos posturas')
  expect(w.gits.length).toBeGreaterThan(0)
})

test('without a name the section talks to "el usuario"', async ($, on) => {
  setup(on, () => ok(), {}, { project: true })
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

const BS = String.fromCharCode(92)

test('globToRegExp: * stays in a segment, ** crosses them, **/ may match nothing, a trailing / is a prefix', () => {
  const m = (glob: string, path: string) => globToRegExp(glob).test(path)
  expect(m('src/auth/**', 'src/auth/login/form.ts')).toBe(true)
  expect(m('src/auth/*', 'src/auth/login/form.ts')).toBe(false)
  expect(m('**/migrations/**', 'db/migrations/001.sql')).toBe(true)
  expect(m('**/migrations/**', 'migrations/001.sql')).toBe(true)
  expect(m('package-lock.json', 'package-lock.json')).toBe(true)
  expect(m('package-lock.json', 'xpackage-lock.json')).toBe(false)
  expect(m('*.lock', 'yarn.lock')).toBe(true)
  expect(m('db/m?.sql', 'db/m1.sql')).toBe(true)
  expect(m('deploy/', 'deploy/a/b.yml')).toBe(true)
  expect(m('a.b+c', 'a.b+c')).toBe(true)
  expect(m('a.b', 'axb')).toBe(false)
  const win = ['db', 'migrations', '1.sql'].join(BS)
  expect(riskyFile(['x.ts', win], ['**/migrations/**'])).toBe(win)
  expect(riskyFile(['x.ts'], ['', '  '])).toBeUndefined()
})

test('reviewsOf wants Revisor and the head commit among the first lines of one body, and reads ## BLOQUEA', () => {
  const oid = 'abc1234def5678abc1234def5678abc1234def56'
  expect(reviewsOf([`Revisor: pi\nCommit: ${oid}\n\n## BLOQUEA\nnada`], oid)).toEqual([{ reviewer: 'pi', clean: true }])
  expect(reviewsOf(['Revisor: AGY\r\nSuite: npm test en verde\r\nCommit: abc1234\r\n\r\n## BLOQUEA\r\n\r\nNada\r\n'], oid)).toEqual([{ reviewer: 'agy', clean: true }])
  expect(reviewsOf([`Revisor: agy\nCommit: ${oid}\n\n## BLOQUEA\n1. \`a.ts:3\` (introducido, concreta): x`], oid)).toEqual([{ reviewer: 'agy', clean: false }])
  expect(reviewsOf([`Revisor: agy\nCommit: ${oid}`], oid)).toEqual([{ reviewer: 'agy', clean: false }]) // no verdict is not clean
  expect(reviewsOf(['Revisor: pi\nCommit: 1111111\n## BLOQUEA\nnada'], oid)).toEqual([])
  expect(reviewsOf(['Revisor: pi\n## BLOQUEA\nnada'], oid)).toEqual([])
  expect(reviewsOf([`Revisor: pi\n\n\n\n\n\nCommit: ${oid}`], oid)).toEqual([])
  expect(reviewsOf(['Revisor: pi', `Commit: ${oid}\n## BLOQUEA\nnada`], oid)).toEqual([]) // both lines must be in one body
})

// The same cases src/despacho.mjs (revisar) is tested with: both sides must read the line alike.
test('implementerOf reads the line the way revisar does', () => {
  expect(implementerOf('x\nImplementador: agy\n')).toBe('agy')
  expect(implementerOf('Implementador:   AGY  \n')).toBe('agy')
  expect(implementerOf('implementador: Codex-CC')).toBe('codex-cc')
  expect(implementerOf('sin línea')).toBeUndefined()
})

const OID = 'abc1234def5678abc1234def5678abc1234def56'
// The engine may resolve paths for the host OS: offer the config under every spelling.
const RISK_CONFIG = JSON.stringify({ riesgo: ['**/migrations/**', 'package-lock.json'] })
const RISK_FILES = {
  'C:/w/repo/.orca-stack.json': RISK_CONFIG,
  [['C:', 'w', 'repo', '.orca-stack.json'].join(BS)]: RISK_CONFIG,
  '/w/repo/.orca-stack.json': RISK_CONFIG,
}
const pr =
  (paths: string[], extra: Record<string, unknown> = {}): ((argv: readonly string[]) => Run) =>
  argv =>
    argv[0] === 'gh'
      ? {
          exitCode: 0,
          stdout: JSON.stringify({
            additions: 10,
            deletions: 5,
            files: paths.map(path => ({ path })),
            headRefOid: OID,
            body: 'Implementador: claude\n\n## Summary\nx',
            comments: [],
            reviews: [],
            ...extra,
          }),
          stderr: '',
        }
      : argv[0] === 'git'
        ? { exitCode: 0, stdout: 'C:/w/repo/.git\nC:/w/repo\n', stderr: '' }
        : ok()

for (const tool of ['Bash', 'PowerShell'] as const) {
  test(`${tool}: a PR touching a riesgo path needs a pi review of its head commit`, async ($, on) => {
    const w = setup(on, pr(['src/a.ts', 'db/migrations/001.sql']), {}, { files: RISK_FILES })
    await boot($)
    const denied = await $.tool.call({ tool, command: 'gh pr merge 7 --squash' } as never)
    expect(denied.deny).toBe(
      'PR #7 toca una ruta de riesgo (db/migrations/001.sql): falta un review de pi sobre el commit abc1234. Corré `orca-stack revisar 7 pi` y mergeá cuando el review esté limpio.',
    )
    expect(w.calls[0]!.argv.slice(0, 5)).toEqual(['gh', 'pr', 'view', '7', '--json'])
  })
}

test('riesgo: a pi review on the head commit (review body or comment) lets it through; an old commit does not', async ($, on) => {
  let extra: Record<string, unknown> = { reviews: [{ body: `Revisor: pi\nCommit: ${OID}\n\n## BLOQUEA\nnada` }] }
  setup(on, argv => pr(['package-lock.json'], extra)(argv), {}, { files: RISK_FILES })
  await boot($)
  const merge = () => $.tool.call({ tool: 'Bash', command: 'gh pr merge 7' } as never)
  expect((await merge()).deny).toBeUndefined()
  extra = { comments: [{ body: 'Revisor: pi\nCommit: abc1234\n\n## BLOQUEA\nnada' }] }
  expect((await merge()).deny).toBeUndefined()
  extra = { reviews: [{ body: 'Revisor: pi\nCommit: 0000000\n\n## BLOQUEA\nnada' }] }
  expect((await merge()).deny).toContain('falta un review de pi')
  // The PR body is not a review, even when it starts like one.
  extra = { body: `Revisor: pi\nCommit: ${OID}\n\n## BLOQUEA\nnada\n\nImplementador: claude` }
  expect((await merge()).deny).toContain('falta un review de pi')
})

const clean = (agent: string) => ({ body: `Revisor: ${agent}\nCommit: ${OID}\n\n## BLOQUEA\nnada` })

// The project layer under every spelling the engine may resolve, with extra keys on top of riesgo.
const riskFiles = (extra: Record<string, unknown>) => {
  const text = JSON.stringify({ riesgo: ['**/migrations/**', 'package-lock.json'], ...extra })

  return { 'C:/w/repo/.orca-stack.json': text, [['C:', 'w', 'repo', '.orca-stack.json'].join(BS)]: text, '/w/repo/.orca-stack.json': text }
}
const piPr = (reviews: () => { body: string }[]) => (argv: readonly string[]) => pr(['package-lock.json'], { body: 'Implementador: pi', reviews: reviews() })(argv)
const PREFIX = 'PR #7 toca una ruta de riesgo (package-lock.json) y lo escribió pi: faltan reviews limpios sobre el commit abc1234 de dos familias de modelo distintas que no sean la de pi (claude).'

test('riesgo: a PR pi wrote needs clean reviews from two model families other than claude', async ($, on) => {
  let reviews: { body: string }[] = []
  const usa = ['claude', 'agy', 'codex', 'codex-cc', 'pi']
  setup(on, piPr(() => reviews), {}, { files: riskFiles({ agentes: { usa, modelos: { codex: { revisar: { modelo: 'deepseek-v4' } } } } }) })
  await boot($)
  const merge = async () => (await $.tool.call({ tool: 'Bash', command: 'gh pr merge 7' } as never)).deny
  // codex reviews on an unknown model and codex-cc has none: only agy is a known family besides pi's.
  expect(await merge()).toBe(`${PREFIX} Hay 0. Con los agentes disponibles (agentes.usa, sin bloqueos) no alcanzan las familias: decidilo con el humano.`)
  reviews = [clean('claude'), clean('agy'), clean('codex'), clean('codex-cc'), clean('gemini-cli')]
  expect(await merge()).toBe(
    `${PREFIX} Hay 1 (gemini). No cuento codex: su modelo deepseek-v4 no tiene una familia reconocida (agregá su patrón en FAMILIES); ` +
      'codex-cc: no tiene modelo para revisar en agentes.modelos, así que no sé su familia; gemini-cli: no es un agente del stack. ' +
      'Con los agentes disponibles (agentes.usa, sin bloqueos) no alcanzan las familias: decidilo con el humano.',
  )
})

test('riesgo: with default models a PR pi wrote is cleared by agy and codex, and claude does not count', async ($, on) => {
  let reviews: { body: string }[] = []
  setup(on, piPr(() => reviews), {}, { files: riskFiles({ agentes: { usa: ['claude', 'agy', 'codex', 'codex-cc', 'pi'], preguntarAntes: ['codex'], modelos: { 'codex-cc': 'gpt-6-luna' } } }) })
  await boot($)
  const merge = async () => (await $.tool.call({ tool: 'Bash', command: 'gh pr merge 7' } as never)).deny
  // codex and codex-cc are both gpt here: the one that needs no OK is suggested.
  expect(await merge()).toBe(`${PREFIX} Hay 0. Corré \`orca-stack revisar 7 agy\` y \`orca-stack revisar 7 codex-cc\`.`)
  reviews = [clean('claude'), clean('agy')]
  expect(await merge()).toBe(`${PREFIX} Hay 1 (gemini). Corré \`orca-stack revisar 7 codex-cc\`.`)
  reviews = [clean('agy'), clean('codex')]
  expect(await merge()).toBeUndefined()
})

test('riesgo: families follow agentes.modelos; blocked agents and preguntarAntes shape the advice', async ($, on) => {
  let reviews: { body: string }[] = [clean('agy')]
  const config = {
    agentes: { usa: ['claude', 'agy', 'codex', 'codex-cc', 'pi'], preguntarAntes: ['codex-cc'], modelos: { 'codex-cc': { revisar: { modelo: 'z-ai/glm-5.3-flash' } } } },
    guardia: { bloquear: [{ agente: 'codex', hasta: '2099-01-01', motivo: 'sin cuota' }] },
  }
  setup(on, piPr(() => reviews), {}, { files: riskFiles(config) })
  await boot($)
  const merge = async () => (await $.tool.call({ tool: 'Bash', command: 'gh pr merge 7' } as never)).deny
  expect(await merge()).toBe(
    `${PREFIX} Hay 1 (gemini). Corré \`orca-stack revisar 7 codex-cc\`. codex-cc está en preguntarAntes: pedile el OK al humano y agregá --confirmado.`,
  )
  reviews = [clean('agy'), clean('codex-cc')]
  expect(await merge()).toBeUndefined()
})

test('riesgo: when the agents in use cannot reach two families, the deny says so', async ($, on) => {
  setup(on, piPr(() => []), {}, { files: riskFiles({ agentes: { usa: ['claude', 'agy', 'pi'] } }) })
  await boot($)
  const denied = await $.tool.call({ tool: 'Bash', command: 'gh pr merge 7' } as never)
  expect(denied.deny).toBe(`${PREFIX} Hay 0. Con los agentes disponibles (agentes.usa, sin bloqueos) no alcanzan las familias: decidilo con el humano.`)
})

test('guardia.bloquear adds up across the layers; every other list is still replaced', () => {
  const personal = { guardia: { bloquear: [{ agente: 'codex', hasta: '2026-10-29' }] }, agentes: { usa: ['claude'] } }
  const local = { guardia: { bloquear: [{ agente: 'agy', hasta: '2026-11-01' }], modeloClaude: 'x' }, agentes: { usa: ['agy'] } }
  const merged = mergeConfig(personal, undefined, local)
  expect(merged.guardia?.bloquear?.map(rule => rule.agente)).toEqual(['codex', 'agy'])
  expect(merged.guardia?.modeloClaude).toBe('x')
  expect(merged.agentes?.usa).toEqual(['agy'])
  expect(mergeConfig(personal, { guardia: { modeloClaude: 'y' } }).guardia).toEqual({ bloquear: personal.guardia.bloquear, modeloClaude: 'y' })
})

// shared/familias.json, copied here by sync-shared: src/despacho.mjs answers the same cases in test/units.test.mjs.
test('familyOf and blockOf answer shared/familias.json', () => {
  for (const c of familias.familyOf) {
    expect([c.agent, c.mode, familyOf(c.config as StackConfig, c.agent, c.mode as 'ticket' | 'review').family ?? null]).toEqual([c.agent, c.mode, c.family])
  }
  for (const c of familias.blockOf) {
    expect(blockOf({ guardia: { bloquear: c.rules } }, c.agent, new Date(c.now).getTime()) ?? null).toBe(c.result)
  }
})

test('riesgo: a review of the head commit with blockers stops the merge even next to clean ones', async ($, on) => {
  const blocked = { body: `Revisor: agy\nCommit: ${OID}\n\n## BLOQUEA\n1. \`db/x.sql:1\` (introducido, concreta): borra datos.` }
  setup(on, pr(['package-lock.json'], { reviews: [clean('pi'), blocked] }), {}, { files: RISK_FILES })
  await boot($)
  const denied = await $.tool.call({ tool: 'Bash', command: 'gh pr merge 7' } as never)
  expect(denied.deny).toBe(
    'PR #7 toca una ruta de riesgo (package-lock.json) y el review de agy sobre el commit abc1234 tiene bloqueos. ' +
      'En una ruta de riesgo un bloqueo no se salda con "Decidido por main": corregilo y pedí un review nuevo, o pasale la decisión al humano.',
  )
})

test('riesgo: a missing or unknown Implementador stops the merge with what to add', async ($, on) => {
  let body = '## Summary\nx'
  setup(on, argv => pr(['package-lock.json'], { body, reviews: [clean('pi')] })(argv), {}, { files: RISK_FILES })
  await boot($)
  const merge = async () => (await $.tool.call({ tool: 'Bash', command: 'gh pr merge 7' } as never)).deny
  const expected =
    'PR #7 toca una ruta de riesgo (package-lock.json) y su body no tiene una línea "Implementador: <agente>" con uno de claude, agy, codex, codex-cc, pi: ' +
    'sin ella no sé quién puede revisarlo. Agregala con `gh pr edit 7 --body-file <archivo>`.'
  expect(await merge()).toBe(expected)
  body = 'Implementador: gpt'
  expect(await merge()).toBe(expected)
})

test('riesgo: untouched paths and an odd gh answer pass', async ($, on) => {
  let run = pr(['src/a.ts'])
  setup(on, argv => run(argv), {}, { files: RISK_FILES })
  await boot($)
  const merge = () => $.tool.call({ tool: 'Bash', command: 'gh pr merge 7' } as never)
  expect((await merge()).deny).toBeUndefined()
  run = pr(['package-lock.json'], { files: 'nope' })
  expect((await merge()).deny).toBeUndefined()
})

test('riesgo: the size rule still comes first and is unchanged', async ($, on) => {
  setup(on, pr(['db/migrations/1.sql'], { additions: 500, deletions: 0 }), {}, { files: RISK_FILES })
  await boot($)
  const denied = await $.tool.call({ tool: 'Bash', command: 'gh pr merge 7' } as never)
  expect(denied.deny).toContain('grande (500 líneas)')
})

test('piClaudeConfigDir reads only agentes.pi.claudeConfigDir and expands ~', () => {
  const cfg = (dir: unknown) => JSON.stringify({ agentes: { pi: { claudeConfigDir: dir } } })
  expect(piClaudeConfigDir(cfg(['D:', 'claude-pi'].join(BS)), 'x')).toBe(['D:', 'claude-pi'].join(BS))
  expect(piClaudeConfigDir(cfg('~/.claude-pi'), ['C:', 'Users', 't'].join(BS))).toBe(['C:', 'Users', 't', '.claude-pi'].join(BS))
  expect(piClaudeConfigDir(cfg('~'), '/home/t')).toBe('/home/t')
  for (const bad of [undefined, '', 'no json', cfg(''), cfg(3), JSON.stringify({ agentes: {} })]) {
    expect(piClaudeConfigDir(bad, '/home/t')).toBeUndefined()
  }
})

test('with agentes.pi.claudeConfigDir the consult runs pi with CLAUDE_CONFIG_DIR', async ($, on) => {
  const file = ['C:', 'Users', 'tester', '.orca-stack', 'config.json'].join(BS)
  const dir = ['C:', 'Users', 'tester', '.claude-pi'].join(BS)
  const w = setup(on, () => ok('hola'), {}, { files: { [file]: JSON.stringify({ agentes: { pi: { claudeConfigDir: dir } } }) } })
  await boot($)
  await consult($, { tema: 'a', planteo: 'p', pregunta: 'q' })
  expect(w.calls[0]!.init.env?.CLAUDE_CONFIG_DIR).toBe(dir)
})

test('without that key the consult does not set CLAUDE_CONFIG_DIR', async ($, on) => {
  const w = setup(on, () => ok('hola'))
  await boot($)
  await consult($, { tema: 'a', planteo: 'p', pregunta: 'q' })
  expect(w.calls[0]!.init.env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
})
