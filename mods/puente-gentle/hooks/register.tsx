import type { EngineInterface, Register } from 'claude-code'

import type { Intercambio } from '../types'
import {
  BIG_PR_LINES,
  PLANTEO_SDD,
  PLANTEO_STORED,
  SDD_AGENTS,
  SDD_QUESTION,
  TIMEOUT_MS,
  bigPrReason,
  block,
  buildArgs,
  buildMessage,
  changeName,
  clock,
  consultEnv,
  engramDir,
  hasPiReview,
  interpret,
  joinPath,
  launcherPath,
  loadMemoria,
  merges,
  parsePiArgs,
  piClaudeConfigDir,
  piPrompt,
  prFacts,
  prSize,
  remember,
  riskReason,
  riskyFile,
  section,
  skillsInGlobal,
  skillsInPi,
  slug,
  truncate,
  vista,
} from './puente'
import type { Memoria, Outcome } from './puente'
import { loadConfig } from './orca-config'
import type { Host } from './orca-config'

const PANE = 'gentle'
const TOOL = 'mcp__puente-gentle__consultar_gentle_shell'
const temas = { plugin: 'puente-gentle', key: 'temas' } as const
const sel = { plugin: 'puente-gentle', key: 'sel' } as const

const load = async ($: EngineInterface): Promise<Memoria> => loadMemoria(await $.store.get('temas'))

const publish = async ($: EngineInterface, memoria: Memoria): Promise<void> => {
  const list = vista(memoria)
  await $.state.set(temas, list)
  const current = (await $.state.get(sel)).value
  if (current === undefined || !list.some(one => one.tema === current)) {
    await $.state.set(sel, list[0]?.tema ?? '')
  }
}

// The engine's `$` cannot cross an import: the config module gets these closures instead.
const hostOf = ($: EngineInterface): Host => ({
  home: async () => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
  exists: path => $.fs.exists(path),
  read: path => $.fs.read(path),
  git: argv => $.process.run(argv, { timeoutMs: 10_000 }),
  now: () => $.clock.now(),
})

const homeDir = async ($: EngineInterface): Promise<string> =>
  (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''

const isWindows = async ($: EngineInterface): Promise<boolean> => (await $.env.get('OS')) === 'Windows_NT'

// The launcher: node on the user's own Pi (~/.pi/agent, where Gentle Shell is installed and configured),
// so multi-line arguments survive (a .cmd shim would cut them). Otherwise `pi` from the PATH.
const launcher = async ($: EngineInterface): Promise<string[]> => {
  const home = await homeDir($)
  if (home !== '') {
    const entry = launcherPath(home)
    if (await $.fs.exists(entry)) {
      return ['node', entry]
    }
  }

  return [(await isWindows($)) ? 'pi.cmd' : 'pi']
}

// Gentle Shell's own skills dir, resolved from Pi's install first and the npm-global one second.
// undefined when neither exists: the consult then loads no skills at all.
const gentleSkills = async ($: EngineInterface): Promise<string | undefined> => {
  const home = await homeDir($)
  if (home !== '') {
    const inPi = skillsInPi(home)
    if (await $.fs.exists(inPi)) {
      return inPi
    }
  }
  try {
    const npm = await $.process.run([(await isWindows($)) ? 'npm.cmd' : 'npm', 'root', '-g'], { timeoutMs: 15_000 })
    if (npm.exitCode === 0 && npm.stdout.trim() !== '') {
      const inGlobal = skillsInGlobal(npm.stdout.trim().split('\n')[0] ?? '')
      if (await $.fs.exists(inGlobal)) {
        return inGlobal
      }
    }
  } catch {
    // npm missing: no skills
  }

  return undefined
}

// Personal config only: where Pi's Claude provider gets its credentials (a separate account from this session's).
const claudeConfigDir = async ($: EngineInterface): Promise<string | undefined> => {
  const home = await homeDir($)
  if (home === '') {
    return undefined
  }
  const file = joinPath(home, '.orca-stack', 'config.json')
  try {
    return piClaudeConfigDir((await $.fs.exists(file)) ? await $.fs.read(file) : undefined, home)
  } catch {
    return undefined
  }
}

const consult = async (
  $: EngineInterface,
  modelo: string,
  tema: string,
  planteo: string,
  pregunta: string,
): Promise<Outcome> => {
  $.ui.toast(`Consultando a Gentle Shell (${tema})…`)
  let outcome: Outcome
  try {
    const prefix = await launcher($)
    const skills = await gentleSkills($)
    const run = await $.process.run([...prefix, ...buildArgs(tema, modelo, buildMessage(planteo, pregunta), skills)], {
      env: consultEnv(engramDir(await homeDir($)), await claudeConfigDir($)),
      // Pi in print mode waits for stdin to close: an open stdin hangs it forever.
      stdin: '',
      timeoutMs: TIMEOUT_MS,
    })
    outcome = interpret(run)
  } catch (error) {
    outcome = {
      ok: false,
      error: `No pude lanzar Gentle Shell: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (outcome.ok) {
    const item: Intercambio = {
      at: await $.clock.now(),
      pregunta,
      planteo: truncate(planteo, PLANTEO_STORED),
      respuesta: outcome.respuesta,
    }
    const memoria = remember(await load($), tema, item)
    await $.store.set('temas', memoria)
    await publish($, memoria)
    $.ui.toast(`Gentle Shell respondió (${tema})`)
  } else {
    $.ui.toast(outcome.error)
  }

  return outcome
}

// A plugin tool's result is a string, a content array, or nothing: a plain string is the simplest valid shape.
const textResult = (text: string) => ({ result: text })

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

// Big PRs need a consult before they merge; PRs touching a `riesgo` path need a pi review of their head commit.
const PR_FIELDS = 'additions,deletions,files,headRefOid,comments,reviews'

const gate = async ($: EngineInterface, command: string) => {
  for (const merge of merges(command)) {
    let stdout: string | undefined
    try {
      const argv = ['gh', 'pr', 'view', merge.number, '--json', PR_FIELDS]
      if (merge.repo !== undefined) {
        argv.push('-R', merge.repo)
      }
      const run = await $.process.run(argv, { timeoutMs: 30000 })
      stdout = run.exitCode === 0 ? run.stdout : undefined
    } catch {
      stdout = undefined
    }
    if (stdout === undefined) {
      continue
    }
    const total = prSize(stdout)
    if (total !== undefined && total > BIG_PR_LINES && !(await load($))[`pr-${merge.number}`]?.length) {
      return { deny: bigPrReason(merge.number, total) }
    }
    const globs = (await loadConfig(hostOf($))).riesgo
    const facts = Array.isArray(globs) && globs.length > 0 ? prFacts(stdout) : undefined
    const risky = facts === undefined ? undefined : riskyFile(facts.files, globs ?? [])
    if (facts !== undefined && risky !== undefined && !hasPiReview(facts.bodies, facts.headRefOid)) {
      return { deny: riskReason(merge.number, risky, facts.headRefOid) }
    }
  }

  return undefined
}

export const register: Register = (on, options) => {
  const modelo = str(options['modelo']).trim()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pi',
      description: 'Consulta a Gentle Shell: /pi <tema>: <pregunta>',
    })
    await $.command.register({
      name: 'gentle',
      description: 'Abre el panel con las consultas a Gentle Shell',
    })
    await $.tool.register({
      name: 'consultar_gentle_shell',
      description:
        'Consulta a Gentle Shell (Pi), otro orquestador par con otra metodología, en modo solo lectura. ' +
        'Usalo en puntos de decisión. El planteo va neutral: problema, restricciones, nuestra propuesta y archivos relevantes.',
      inputSchema: {
        type: 'object',
        properties: {
          tema: { type: 'string', description: 'Slug corto del tema, por ejemplo pr-612 o sdd-auditoria. Misma conversación por tema.' },
          planteo: { type: 'string', description: 'Contexto neutral: el problema, las restricciones, nuestra propuesta actual y las rutas relevantes.' },
          pregunta: { type: 'string', description: 'Lo que querés que opine.' },
        },
        required: ['tema', 'planteo', 'pregunta'],
      },
    })
    await publish($, await load($))

    return next(e)
  })

  // The tool the model calls.
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const tema = slug(str(e['tema']))
    const planteo = str(e['planteo'])
    const pregunta = str(e['pregunta'])
    if (tema === '' || planteo.trim() === '' || pregunta.trim() === '') {
      return textResult(JSON.stringify({ error: 'Faltan tema, planteo o pregunta.' }))
    }
    const outcome = await consult($, modelo, tema, planteo, pregunta)

    return textResult(
      JSON.stringify(outcome.ok ? { tema, respuesta: outcome.respuesta } : { tema, error: outcome.error }),
    )
  })

  on('command.run', { command: 'pi' }, async ($, e) => {
    const parsed = parsePiArgs(e.args)
    if (parsed === undefined) {
      return { text: 'Uso: /pi <tema>: <pregunta>  (por ejemplo: /pi pr-612: ¿ves riesgo en este merge?)' }
    }
    // Submitted from a timer so the command returns before the turn starts.
    $.clock.after(0, () => {
      void $.prompt.submit({ text: piPrompt(parsed.tema, parsed.pregunta), asUser: true })
    })

    return { text: `Consultando a Gentle Shell (tema ${parsed.tema})…` }
  })

  on('command.run', { command: 'gentle' }, async $ => {
    await publish($, await load($))
    await $.ui.open({ id: PANE, title: 'Gentle Shell' })

    return { text: 'Panel de Gentle Shell abierto.' }
  })

  // After an SDD proposal or design, Gentle Shell reads it too.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    const type = e.subagent_type ?? ''
    if (!SDD_AGENTS.has(type) || ran.deny !== undefined || ran.isError === true) {
      return ran
    }
    const result = ran.result as { status?: string; content?: { type: string; text?: string }[] } | undefined
    if (result?.status !== 'completed' || !Array.isArray(result.content)) {
      return ran
    }
    const answer = result.content
      .filter(one => one.type === 'text')
      .map(one => one.text ?? '')
      .join('\n')
      .trim()
    if (answer === '') {
      return ran
    }
    let appended: string
    try {
      const tema = changeName(`${e.prompt}\n${e.description}\n${answer}`, await $.clock.now())
      const outcome = await consult(
        $,
        modelo,
        tema,
        `${type} devolvió:\n${truncate(answer, PLANTEO_SDD)}`,
        SDD_QUESTION,
      )
      appended = block(tema, outcome.ok ? outcome.respuesta : outcome.error)
    } catch (error) {
      appended = block('?', `No pude consultar a Gentle Shell: ${error instanceof Error ? error.message : String(error)}`)
    }

    return {
      result: { ...result, content: [...result.content, { type: 'text' as const, text: appended }] },
      ...(ran.context === undefined ? {} : { context: ran.context }),
    } as typeof ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => (await gate($, e.command)) ?? next(e))
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => (await gate($, e.command)) ?? next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const humano = (await loadConfig(hostOf($))).humano

    return {
      sections: [
        ...composed.sections,
        { id: 'puente-gentle:criterio', text: section(typeof humano === 'string' ? humano : ''), scope: 'session' as const },
      ],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const { value: list = [] } = await $.state.get(temas)
    const { value: chosen = '' } = await $.state.get(sel)
    if (list.length === 0) {
      return <Text dimColor>Todavía no hay consultas. Usá /pi o dejá que Claude consulte a Gentle Shell.</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        {list.map(entry => (
          <Box key={`row:${entry.tema}`} flexDirection="column">
            <Button
              key={`tema:${entry.tema}`}
              label={`${entry.tema === chosen ? '▾' : '▸'} ${entry.tema} (${entry.items.length})`}
              onPress={async () => {
                await $.state.set(sel, entry.tema)
              }}
            />
            {entry.tema === chosen
              ? entry.items.slice(0, 10).map((item, i) => (
                  <Box key={`item:${entry.tema}:${i}`} flexDirection="column" marginLeft={2}>
                    <Text bold>
                      {clock(item.at)} · {item.pregunta}
                    </Text>
                    <Text>{item.respuesta}</Text>
                    <Button
                      key={`copy:${entry.tema}:${i}`}
                      label="Copiar respuesta"
                      onPress={async press => {
                        const copied = await $.ui.copy({ text: item.respuesta, surface: press.surface })
                        $.ui.toast(copied.isCopied ? 'Copiado' : 'No pude copiar: probá seleccionando el texto')
                      }}
                    />
                  </Box>
                ))
              : null}
          </Box>
        ))}
      </Box>
    )
  })
}
