import type { EngineInterface, Register } from 'claude-code'

const isOn = { plugin: 'modo-autonomo', key: 'isOn' } as const
const goal = { plugin: 'modo-autonomo', key: 'goal' } as const
const nudges = { plugin: 'modo-autonomo', key: 'nudges' } as const

export const DEFAULT_GOAL = 'producción'
export const DONE_TOKEN = '[AUTONOMO-LISTO]'
export const MAX_NUDGES = 3

export const instructions = (target: string): string =>
  [
    `Modo autónomo activo. Meta: ${target}.`,
    'Trabajá de forma autónoma hasta alcanzar la meta, sin esperar a que el usuario te empuje.',
    'Mantené un Monitor corriendo para vigilar los PRs, las reviews y los workers despachados.',
    'Cuando una review vuelve sin bloqueos, mergeá y desplegá.',
    'No frenes a pedir confirmaciones que el usuario ya autorizó en este modo.',
    'Pará solo ante decisiones que son genuinamente del usuario: credenciales, gastar plata, mensajes a clientes o acciones destructivas.',
    `Cuando la meta esté cumplida, escribí exactamente ${DONE_TOKEN} en tu mensaje final para apagar el modo.`,
  ].join('\n')

export const reminder = (target: string): string =>
  `Modo autónomo activo (meta: ${target}). No te detengas: seguí con el siguiente paso, revisá los monitores y avanzá hacia la meta. Si ya la alcanzaste, escribí exactamente ${DONE_TOKEN} en tu mensaje final.`

const show = async ($: EngineInterface): Promise<void> => {
  const { value: on = false } = await $.state.get(isOn)
  const { value: target = DEFAULT_GOAL } = await $.state.get(goal)
  $.ui.status(on ? `AUTÓNOMO → ${target}` : undefined)
}

const turnOff = async ($: EngineInterface): Promise<void> => {
  await $.state.set(isOn, false)
  await $.state.set(nudges, 0)
  await show($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'autonomo',
      description: 'Modo autónomo hasta la meta (producción por defecto); /autonomo off lo apaga',
      argumentHint: '[meta | off]',
    })
    await show($)

    return next(e)
  })

  on('command.run', { command: 'autonomo' }, async ($, e) => {
    const args = e.args.trim()
    if (args.toLowerCase() === 'off') {
      await turnOff($)

      return { text: 'Modo autónomo apagado.' }
    }
    const target = args === '' ? DEFAULT_GOAL : args
    await $.state.set(isOn, true)
    await $.state.set(goal, target)
    await $.state.set(nudges, 0)
    await show($)

    return { text: `Modo autónomo activado → ${target}. Para apagarlo: /autonomo off.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const { value: active = false } = await $.state.get(isOn)
    if (!active) {
      return composed
    }
    const { value: target = DEFAULT_GOAL } = await $.state.get(goal)

    return {
      sections: [
        ...composed.sections,
        { id: 'modo-autonomo:instrucciones', text: instructions(target), scope: 'session' as const },
      ],
    }
  })

  // Any tool call proves progress: the run of automatic continuations starts over.
  on('tool.call', async ($, e, next) => {
    await $.state.set(nudges, 0)

    return next(e)
  })

  // The equivalent of a Stop hook that blocks with a reason.
  on('classic.Stop', async ($, e, next) => {
    const { value: active = false } = await $.state.get(isOn)
    if (!active) {
      return next(e)
    }
    if ((e.last_assistant_message ?? '').includes(DONE_TOKEN)) {
      await turnOff($)
      $.ui.toast('Modo autónomo: meta alcanzada')

      return next(e)
    }
    // Paused on a monitor or a cron that will wake the session: that is not a stop to fight.
    if ((e.background_tasks?.length ?? 0) > 0 || (e.session_crons?.length ?? 0) > 0) {
      return next(e)
    }
    const { value: used = 0 } = await $.state.get(nudges)
    if (used >= MAX_NUDGES) {
      await $.state.set(nudges, 0)
      $.ui.toast('Modo autónomo: me detuve, revisá')

      return next(e)
    }
    await $.state.set(nudges, used + 1)
    const { value: target = DEFAULT_GOAL } = await $.state.get(goal)

    return { block: reminder(target) }
  })
}
