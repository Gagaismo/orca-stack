import type { EngineInterface, Register } from 'claude-code'

import type { Gear } from '../types'

const GEARS: Gear[] = ['lazy', 'medium', 'proactive']
const COLORS: Record<Gear, string> = { lazy: 'ide', medium: 'success', proactive: 'warning' }
const KEY_PREFIX = 'marchas:'
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const marker = (gear: Gear): string => `Marcha: ${gear}`
const sessionKey = async ($: EngineInterface): Promise<string> => `marchas:${await $.session.id()}`
const isGear = (value: unknown): value is Gear => GEARS.includes(value as Gear)
type GearState = { gear: Gear; shiftedAt: number; needsReminder?: boolean }

const gearState = (value: unknown): GearState | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const state = value as Partial<GearState>

  return isGear(state.gear) && typeof state.shiftedAt === 'number'
    ? { gear: state.gear, shiftedAt: state.shiftedAt, needsReminder: state.needsReminder === true }
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
    medium: ['Trabaj\u00e1 seg\u00fan ODD y el contrato.'],
    proactive: [
      'Mir\u00e1 m\u00e1s all\u00e1 del pedido. Antes de actuar, hac\u00e9 que subagentes exploren su entorno (llamadores, vecinos, issues abiertos relacionados; primero ADRs y glosario, Engram como pista) para que riesgos y oportunidades aparezcan antes de causar problemas, y reserv\u00e1 tu contexto para orquestar; deleg\u00e1 temprano las unidades independientes.',
      'Propon\u00e9 investigar cada vez que un dato externo afecte una decisi\u00f3n y desafi\u00e1 cada premisa de alto impacto. Adem\u00e1s de las consultas requeridas, consult\u00e1 a Gentle Shell antes de escribir tickets, antes de despachar una tanda y cuando desaf\u00edes una premisa. Propon\u00e9 seguimientos, arreglos cercanos y tickets que valga la pena escribir en tu informe o en el mapa o issue paraguas, nunca en un ticket por despachar, y nunca crees issues.',
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (!(await enabled($))) {
      return next(e)
    }
    await $.command.register({ name: 'marcha', description: 'Muestra o cambia la marcha de main', argumentHint: '[lazy|medium|proactive]' })
    await pruneOldKeys($)

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
    await $.store.set(await sessionKey($), { gear, shiftedAt: await $.clock.now(), needsReminder: false } satisfies GearState)

    return { text: marker(gear), context: [posture(gear)] }
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
      gear,
      shiftedAt: state?.shiftedAt ?? await $.clock.now(),
      needsReminder: false,
    } satisfies GearState)

    return {
      ...result,
      additionalContext: [...(result.additionalContext ?? []), posture(gear)],
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await enabled($))) {
      return next(e)
    }
    const { Text } = $.ui.resolve(e)
    const gear = await currentGear($)
    const state = gearState(await $.store.get(await sessionKey($)))
    const label = gear[0].toUpperCase() + gear.slice(1)
    const text = state?.needsReminder === true ? `${label} - repet\u00ed /marcha ${gear}` : label

    return <Text color={COLORS[gear]}>{text}</Text>
  })
}
