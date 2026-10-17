import type { EngineInterface, Register } from 'claude-code'

import type { Gear } from '../types'

const GEARS: Gear[] = ['lazy', 'medium', 'proactive']
const COLORS: Record<Gear, string> = { lazy: 'ide', medium: 'success', proactive: 'warning' }
const KEY_PREFIX = 'marchas:'
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = typeof EFFORTS[number]
const marker = (gear: Gear): string => {
  const effort = {
    lazy: 'esfuerzo m\u00e1ximo: medium',
    medium: 'sin reescritura de esfuerzo',
    proactive: 'esfuerzo m\u00ednimo: xhigh',
  }[gear]

  return `Marcha: ${gear} (${effort})`
}
const sessionKey = async ($: EngineInterface): Promise<string> => `marchas:${await $.session.id()}`
// modo-autonomo's own value: any plugin reads another's `$.state`, only its owner writes it.
const AUTONOMOUS = { plugin: 'modo-autonomo', key: 'isOn' } as const
// Ultracode is per process and `$.state` lasts one: unset (after `/clear`) means the mod cannot see it.
const ULTRACODE = { plugin: 'marchas', key: 'ultracode' } as const
const LAZY_WARNING = 'Modo aut\u00f3nomo en Lazy: los items que no est\u00e9n especificados van a esperar un cambio de marcha.'

const costWarning = (gear: Gear, ultracode: boolean | undefined): string | undefined => {
  const proactive = gear === 'proactive'
  if (!proactive && ultracode !== true) return undefined
  const costs = [
    ...(proactive ? ['la exploraci\u00f3n, las consultas y la vigilancia de Proactive'] : []),
    ...(ultracode === true ? ['el workflow de ultracode para cada tarea sustantiva, sin l\u00edmite de concurrencia'] : []),
  ]
  const blind = proactive && ultracode === undefined ? ' No puedo ver si ultracode est\u00e1 activo.' : ''
  const fixes = [...(ultracode === true ? ['apag\u00e1 ultracode'] : []), ...(proactive ? ['/marcha medium'] : [])]

  return `Modo aut\u00f3nomo, lo que puede costar m\u00e1s sin supervisi\u00f3n: ${costs.join('; ')}.${blind} Para bajarlo: ${fixes.join(' o ')}`
}

// A transcript notice the model never reads; a toast if the notice is refused.
const warn = async ($: EngineInterface, text: string | undefined): Promise<void> => {
  if (text === undefined) return
  const appended = await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => undefined)
  if (appended?.uuid === undefined) $.ui.toast(text)
}

const autonomous = async ($: EngineInterface): Promise<boolean> => (await $.state.get(AUTONOMOUS)).value === true
const isGear = (value: unknown): value is Gear => GEARS.includes(value as Gear)
const isEffort = (value: unknown): value is Effort => EFFORTS.includes(value as Effort)
type GearState = {
  gear: Gear
  shiftedAt: number
  needsReminder?: boolean
  effortBaseline?: Effort
  effortModel?: string
  effortOverride?: boolean
  modelChanged?: boolean
  // `/effort` opened its menu (or ran `auto`) since the last shift: its result never reaches the mod (#194).
  effortPicker?: boolean
}

const gearState = (value: unknown): GearState | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const state = value as Partial<GearState>

  return isGear(state.gear) && typeof state.shiftedAt === 'number'
    ? {
        gear: state.gear,
        shiftedAt: state.shiftedAt,
        needsReminder: state.needsReminder === true,
        ...(isEffort(state.effortBaseline) ? { effortBaseline: state.effortBaseline } : {}),
        ...(typeof state.effortModel === 'string' ? { effortModel: state.effortModel } : {}),
        effortOverride: state.effortOverride === true,
        modelChanged: state.modelChanged === true,
        effortPicker: state.effortPicker === true,
      }
    : undefined
}

const shiftedGear = (value: unknown): Gear | undefined => {
  const state = gearState(value)
  if (state !== undefined) return state.gear

  // Older versions wrote Medium at session start, so legacy Medium is ambiguous.
  return isGear(value) && value !== 'medium' ? value : undefined
}

const pruneOldKeys = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith(KEY_PREFIX)) continue
    const state = gearState(await $.store.get(key))
    if (state !== undefined && now - state.shiftedAt > RETENTION_MS) {
      await $.store.delete(key)
    }
  }
}

const posture = (gear: Gear): string => {
  const opening = [
    'Este mensaje de marcha reemplaza cualquier postura de marcha anterior.',
    'En tu pr\u00f3ximo mensaje, empez\u00e1 con una l\u00ednea que nombre la marcha y qu\u00e9 cambia ahora.',
  ]
  const body: Record<Gear, string[]> = {
    lazy: [
      'El trabajo ya est\u00e1 especificado: el ticket cumple el contrato y lo que queda es despachar, vigilar y mergear (en modo un-agente, implementarlo). Le\u00e9 el ticket, sus comentarios y el estado del PR. Le\u00e9 c\u00f3digo solo hasta donde lo necesiten los chequeos del contrato, incluido el diff del PR frente a los hallazgos del review y los logs de los checks fallidos (en modo un-agente, hasta ubicar el cambio).',
      'Hac\u00e9 tu propio trabajo inline; los reviews y verificadores requeridos siguen corriendo como subagentes. Corr\u00e9 el verificador independiente y el review de registro en modo un-agente con el esfuerzo que tendr\u00edan sin marcha. Omit\u00ed la investigaci\u00f3n opcional y el desaf\u00edo de premisas de ODD; los disparadores propios del contrato siguen vigentes.',
      'Asum\u00ed los detalles de ejecuci\u00f3n y decilo; una regla o un criterio ambiguo en el ticket significa que est\u00e1 incompleto, no que haya que asumirlo. Quedate dentro del pedido: inform\u00e1 en una l\u00ednea cualquier problema que veas, pero no propongas seguimientos. Narr\u00e1 una l\u00ednea por evento y cerr\u00e1 breve pero completo. No propongas arena ni swarm.',
      'Cuando un item deje de estar especificado (haya que escribir o completar su ticket, la exploraci\u00f3n no entre en un solo lote inline, falle la prueba de reanudaci\u00f3n, un requisito se vuelva problem\u00e1tico o aparezca una decisi\u00f3n de dise\u00f1o), decilo en una l\u00ednea y suger\u00ed subir de marcha en vez de estirarlo. Hasta que alguien cambie la marcha, ese item espera y segu\u00eds con el resto; ninguna regla fija se suspende.',
    ],
    medium: [
      'Trabaj\u00e1 seg\u00fan ODD y el contrato.',
      'Propon\u00e9 arena o swarm cuando un requisito muestre se\u00f1ales de la secci\u00f3n "Arena y swarm" del contrato.',
    ],
    proactive: [
      'Mir\u00e1 m\u00e1s all\u00e1 del pedido. Antes de actuar, hac\u00e9 que subagentes exploren su entorno (llamadores, vecinos, issues abiertos relacionados; primero ADRs y glosario, Engram como pista) para que riesgos y oportunidades aparezcan antes de causar problemas, y reserv\u00e1 tu contexto para orquestar; deleg\u00e1 temprano las unidades independientes.',
      'Propon\u00e9 investigar cada vez que un dato externo afecte una decisi\u00f3n y desafi\u00e1 cada premisa de alto impacto. Adem\u00e1s de las consultas requeridas, consult\u00e1 a Gentle Shell antes de escribir tickets, antes de despachar una tanda y cuando desaf\u00edes una premisa. Propon\u00e9 seguimientos, arreglos cercanos y tickets que valga la pena escribir en tu informe o en el mapa o issue paraguas, nunca en un ticket por despachar, y nunca crees issues.',
      'Colabor\u00e1 con los workers de implementaci\u00f3n hasta que abran su PR: vigil\u00e1 sus issues y PRs en busca de preguntas; respond\u00e9 las preguntas de ejecuci\u00f3n donde las hayan hecho y tocales el timbre en su terminal, solo mientras su turno est\u00e9 en curso, con una l\u00ednea que apunte a la respuesta; llev\u00e1 las de producto e interpretaci\u00f3n al humano y transmit\u00ed la respuesta del mismo modo; avisales lo que cambiar\u00eda su trabajo y no pueden ver. Nunca los hagas esperar, nunca corrijas su c\u00f3digo, y dej\u00e1 en paz a los revisores.',
      'Propon\u00e9 arena o swarm temprano, ante se\u00f1ales m\u00e1s d\u00e9biles, antes de que aparezca un problema.',
      'Cont\u00e1 qu\u00e9 encontraste m\u00e1s all\u00e1 del pedido y por qu\u00e9 importa. Vigil\u00e1 de cerca y propon\u00e9 un handoff antes de que se llene tu contexto.',
    ],
  }

  return [...opening, ...body[gear]].join('\n\n')
}

const mainCheckout = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const result = await $.process.run(
      ['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
      { timeoutMs: 10_000 },
    )
    if (result.exitCode !== 0) {
      return undefined
    }
    const [gitDir, commonDir, top] = result.stdout.split(/\r?\n/).map(path => path.trim())
    const slashed = (path: string | undefined): string => (path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (gitDir === undefined || commonDir === undefined || slashed(gitDir).toLowerCase() !== slashed(commonDir).toLowerCase()) {
      return undefined
    }
    const common = slashed(commonDir)

    return common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : slashed(top)
  } catch {
    return undefined
  }
}

const enabled = async ($: EngineInterface): Promise<boolean> => {
  const root = await mainCheckout($)
  if (root === undefined) {
    return false
  }
  if (!(await $.fs.exists(`${root}/.orca-stack.json`)) && !(await $.fs.exists(`${root}/.orca-stack.local.json`))) {
    return false
  }
  try {
    const agentsPath = `${root}/AGENTS.md`
    if (!(await $.fs.exists(agentsPath))) {
      return false
    }
    const agents = await $.fs.read(agentsPath)
    const contract = /<!-- orca-stack:begin -->([\s\S]*?)<!-- orca-stack:end -->/i.exec(agents)?.[1]

    return contract !== undefined && /^#{1,6}\s+Marchas\s*$/mi.test(contract)
  } catch {
    return false
  }
}

const currentGear = async ($: EngineInterface): Promise<Gear> => {
  const stored = await $.store.get(await sessionKey($))

  return shiftedGear(stored) ?? 'medium'
}

const saveEffortState = async ($: EngineInterface, value: unknown, changes: Partial<GearState>): Promise<void> => {
  const state = gearState(value)
  await $.store.set(await sessionKey($), {
    gear: shiftedGear(value) ?? 'medium',
    shiftedAt: state?.shiftedAt ?? await $.clock.now(),
    needsReminder: state?.needsReminder ?? false,
    ...state,
    ...changes,
  } satisfies GearState)
}

export const register: Register = on => {
  on('turn.step', async function* ($, e, next) {
    if (!(await enabled($)) || e.agentId !== undefined || !isEffort(e.effort)) {
      return yield* next(e)
    }
    const key = await sessionKey($)
    const value = await $.store.get(key)
    const gear = shiftedGear(value)
    if (gear === undefined) return yield* next(e)
    const state = gearState(value)
    const changedModel = state?.modelChanged === true || (state?.effortModel !== undefined && state.effortModel !== e.model)
    const changedEffort = state?.effortBaseline !== undefined && state.effortBaseline !== e.effort
    const baseline = changedModel || changedEffort ? e.effort : state?.effortBaseline ?? e.effort
    // A changed effort is manual only if `/effort` opened its menu since the last shift; one main step consumes the mark.
    const effortOverride = changedModel
      ? state?.effortOverride ?? false
      : state?.effortOverride === true || (changedEffort && state?.effortPicker === true)
    await $.store.set(key, {
      gear,
      shiftedAt: state?.shiftedAt ?? await $.clock.now(),
      needsReminder: state?.needsReminder ?? false,
      effortBaseline: baseline,
      effortModel: e.model,
      effortOverride,
      modelChanged: false,
      effortPicker: false,
    } satisfies GearState)
    if (gear === 'medium' || effortOverride) return yield* next(e)

    const effort = gear === 'lazy'
      ? EFFORTS.indexOf(baseline) > EFFORTS.indexOf('medium') ? 'medium' : baseline
      : EFFORTS.indexOf(baseline) < EFFORTS.indexOf('xhigh') ? 'xhigh' : baseline

    return yield* next({ ...e, effort })
  })

  on('session.start', async ($, e, next) => {
    if (!(await enabled($))) {
      return next(e)
    }
    await $.command.register({ name: 'marcha', description: 'Muestra o cambia la marcha de main', argumentHint: '[lazy|medium|proactive]' })
    await pruneOldKeys($)
    // A new process, a resume included, starts with ultracode off; a hot reload keeps what it saw.
    if ((await $.state.get(ULTRACODE)).value === undefined) await $.state.set(ULTRACODE, false)

    return next(e)
  })

  on('command.run', { command: 'marcha' }, async ($, e) => {
    if (!(await enabled($))) {
      return { text: '' }
    }
    const args = e.args.trim().toLowerCase()
    if (args === '') {
      return { text: marker(await currentGear($)) }
    }
    if (!GEARS.includes(args as Gear)) {
      return { text: 'Marchas disponibles: lazy|medium|proactive' }
    }
    const gear = args as Gear
    const before = await currentGear($)
    const key = await sessionKey($)
    const previous = gearState(await $.store.get(key))
    await $.store.set(key, {
      ...previous,
      gear,
      shiftedAt: await $.clock.now(),
      needsReminder: false,
      effortOverride: false,
      modelChanged: previous?.modelChanged ?? false,
      effortPicker: false,
    } satisfies GearState)
    if (gear === 'proactive' && before !== 'proactive' && await autonomous($)) {
      await warn($, costWarning(gear, (await $.state.get(ULTRACODE)).value))
    }

    return { text: marker(gear), context: [posture(gear)] }
  })

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const effort = e.args.trim().toLowerCase()
    const active = await enabled($)
    if (active && e.origin.kind === 'composer' && isEffort(effort)) {
      const key = await sessionKey($)
      const value = await $.store.get(key)
      await saveEffortState($, value, {
        effortBaseline: effort,
        effortOverride: true,
        modelChanged: false,
      })
    } else if (active && e.origin.kind === 'composer' && effort !== 'ultracode') {
      await saveEffortState($, await $.store.get(await sessionKey($)), { effortPicker: true })
    }
    const result = await next(e)
    if (active && effort === 'ultracode') {
      const { value: before } = await $.state.get(ULTRACODE)
      await $.state.set(ULTRACODE, true)
      if (before !== true && await autonomous($)) await warn($, costWarning(await currentGear($), true))
    }

    return result
  })

  // The latest ultracode attachment tells its state; a resume asks the history's again, ending on exit (#153).
  on('prompt.attachment', { type: ['ultra_effort_enter', 'ultra_effort_exit'] }, async ($, e, next) => {
    if (await enabled($)) await $.state.set(ULTRACODE, e.type === 'ultra_effort_enter')

    return next(e)
  })

  // modo-autonomo answers /autonomo itself, so the mod watches its write instead of the command.
  on('state.set', { plugin: 'modo-autonomo', key: 'isOn' }, async ($, e, next) => {
    const wasOn = await autonomous($)
    const result = await next(e)
    const landed = 'value' in result && result.value.isSet
    if (e.value !== true || wasOn || !landed || !(await enabled($))) return result
    const gear = await currentGear($)
    await warn($, gear === 'lazy' ? LAZY_WARNING : undefined)
    await warn($, costWarning(gear, (await $.state.get(ULTRACODE)).value))

    return result
  })

  on('command.run', { command: 'model' }, async ($, e, next) => {
    if (await enabled($) && e.origin.kind === 'composer') {
      const value = await $.store.get(await sessionKey($))
      await saveEffortState($, value, { modelChanged: true })
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!(await enabled($)) || ('skip' in result && result.skip !== undefined)) {
      return result
    }
    const key = await sessionKey($)
    const value = await $.store.get(key)
    const gear = shiftedGear(value)
    if (gear === undefined) return result
    const state = gearState(value)
    await $.store.set(key, {
      ...state,
      gear,
      shiftedAt: state?.shiftedAt ?? await $.clock.now(),
      needsReminder: true,
    } satisfies GearState)

    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (!(await enabled($)) || e.source !== 'compact') return result
    const key = await sessionKey($)
    const value = await $.store.get(key)
    const gear = shiftedGear(value)
    if (gear === undefined) return result
    const state = gearState(value)
    await $.store.set(key, {
      ...state,
      gear,
      shiftedAt: state?.shiftedAt ?? await $.clock.now(),
      needsReminder: false,
    } satisfies GearState)

    return {
      ...result,
      additionalContext: [...(result.additionalContext ?? []), posture(gear)],
    }
  })

  // The gear sits with the mode labels at the right of the prompt footer, beside whatever the
  // engine and other plugins draw there, so it never competes for the one band above the prompt.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const modes = await next(e)
    if (!(await enabled($))) {
      return modes
    }
    const { Box, Text } = $.ui.resolve(e)
    const gear = await currentGear($)
    const state = gearState(await $.store.get(await sessionKey($)))
    const label = gear[0].toUpperCase() + gear.slice(1)
    const text = state?.needsReminder === true ? `${label} - repet\u00ed /marcha ${gear}` : label

    return (
      <Box gap={1}>
        <Text color={COLORS[gear]}>{text}</Text>
        {modes}
      </Box>
    )
  })
}
