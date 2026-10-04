import type { EngineInterface, Register } from 'claude-code'


// The session uses a 1-hour prompt cache; the API does not expose the TTL here.
const TTL_MS = 60 * 60 * 1000
const WARN_MS = 10 * 60 * 1000
const TICK_MS = 60 * 1000

const lastAt = { plugin: 'reloj-cache', key: 'lastAt' } as const
const hasWarned = { plugin: 'reloj-cache', key: 'hasWarned' } as const

export const minutesLeft = (leftMs: number): number => Math.ceil(leftMs / 60_000)

const refresh = async ($: EngineInterface): Promise<void> => {
  const { value: at = null } = await $.state.get(lastAt)
  if (at === null) {
    $.ui.status(undefined)
    return
  }
  const left = TTL_MS - ((await $.clock.now()) - at)
  if (left <= 0) {
    $.ui.status('caché: vencida')
    return
  }
  $.ui.status(`caché: ${minutesLeft(left)} min`)
  const { value: warned = false } = await $.state.get(hasWarned)
  if (left <= WARN_MS && !warned) {
    await $.state.set(hasWarned, true)
    $.ui.toast('Caché por vencer en 10 min')
  }
}

const touch = async ($: EngineInterface): Promise<void> => {
  await $.state.set(lastAt, await $.clock.now())
  await $.state.set(hasWarned, false)
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'compactar-ya',
      description: 'Compacta la conversación ahora, antes de que venza el caché',
    })
    $.clock.every(TICK_MS, () => void refresh($))
    await refresh($)

    return next(e)
  })

  // Every model request of the main loop refreshes the cache entry.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await touch($)
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await touch($)
    }

    return next(e)
  })

  // session.compact is refused inside a command.run dispatch, so the command
  // answers at once and the compaction runs from a timer, a dispatch of its own.
  on('command.run', { command: 'compactar-ya' }, $ => {
    $.clock.after(0, () => {
      void (async () => {
        try {
          const result = await $.session.compact({})
          if ('skip' in result && result.skip !== undefined) {
            $.ui.toast(`No se compactó: ${result.skip}. Probá con /compact.`)
            return
          }
          await touch($)
          $.ui.toast('Conversación compactada')
        } catch {
          $.ui.toast('No pude compactar desde acá: corré /compact.')
        }
      })()
    })

    return { text: 'Compactando la conversación…' }
  })
}
