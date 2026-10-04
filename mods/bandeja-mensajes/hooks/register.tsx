import type { EngineInterface, Register } from 'claude-code'

import type { Mensaje } from '../types'
import { clock, convention, desktopCandidates, fileName, joinPath, parseDrafts } from './mensajes'
import { loadConfig } from './orca-config'
import type { Host } from './orca-config'

const PANE = 'mensajes'
const CAP = 50
const items = { plugin: 'bandeja-mensajes', key: 'items' } as const

const load = async ($: EngineInterface): Promise<Mensaje[]> => {
  const kept = await $.store.get('mensajes')

  return Array.isArray(kept) ? (kept as Mensaje[]) : []
}

const keep = async ($: EngineInterface, list: Mensaje[]): Promise<void> => {
  await $.store.set('mensajes', list)
  await $.state.set(items, list)
}

// The engine's `$` cannot cross an import: the config module gets these closures instead.
const hostOf = ($: EngineInterface): Host => ({
  home: async () => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
  exists: path => $.fs.exists(path),
  read: path => $.fs.read(path),
  git: argv => $.process.run(argv, { timeoutMs: 10_000 }),
  now: () => $.clock.now(),
})

// The Desktop folder: OneDrive's when it exists (it is the redirected one), else the plain one.
const desktop = async ($: EngineInterface): Promise<string | undefined> => {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (home === undefined || home === '') {
    return undefined
  }
  for (const path of desktopCandidates(home)) {
    if (await $.fs.exists(path)) {
      return path
    }
  }

  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mensajes',
      description: 'Abre la bandeja con los mensajes que redactó Claude para mandar',
    })
    await $.state.set(items, await load($))

    return next(e)
  })

  on('command.run', { command: 'mensajes' }, async $ => {
    await $.state.set(items, await load($))
    await $.ui.open({ id: PANE, title: 'Bandeja de mensajes' })

    return { text: 'Bandeja de mensajes abierta.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const configured = (await loadConfig(hostOf($))).mensajes?.destinatarios
    const recipients = Array.isArray(configured) ? configured.filter(one => typeof one === 'string') : []

    return {
      sections: [
        ...composed.sections,
        { id: 'bandeja-mensajes:convencion', text: convention(recipients), scope: 'session' as const },
      ],
    }
  })

  on('turn.complete', async ($, e, next) => {
    const drafts = e.agentId === undefined ? parseDrafts(e.answer) : []
    if (drafts.length > 0) {
      const now = await $.clock.now()
      let list = await load($)
      ;[...drafts].reverse().forEach((draft, i) => {
        const isKnown = list.some(one => one.to === draft.to && one.text === draft.text)
        list = list.filter(one => !(one.to === draft.to && one.text === draft.text))
        list.unshift({ id: `${now}-${i}`, to: draft.to, text: draft.text, at: now })
        if (!isKnown) {
          $.ui.toast(
            draft.to === ''
              ? 'Mensaje guardado en la bandeja'
              : `Mensaje para ${draft.to} guardado en la bandeja`,
          )
        }
      })
      await keep($, list.slice(0, CAP))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const { value: list = [] } = await $.state.get(items)
    if (list.length === 0) {
      return <Text dimColor>Todavía no hay mensajes. Cuando Claude redacte uno, aparece acá.</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        {list.map(one => (
          <Box key={`row:${one.id}`} flexDirection="column">
            <Text bold>
              {one.to === '' ? 'Sin destinatario' : one.to} · {clock(one.at)}
            </Text>
            <Text>{one.text}</Text>
            <Box gap={2}>
              <Button
                key={`copy:${one.id}`}
                label="Copiar"
                onPress={async press => {
                  const copied = await $.ui.copy({ text: one.text, surface: press.surface })
                  $.ui.toast(copied.isCopied ? 'Copiado' : 'No pude copiar: probá seleccionando el texto')
                }}
              />
              <Button
                key={`save:${one.id}`}
                label="Guardar en el Escritorio"
                onPress={async () => {
                  const folder = await desktop($)
                  if (folder === undefined) {
                    $.ui.toast('No encontré la carpeta Escritorio')
                    return
                  }
                  const path = joinPath(folder, fileName(one.to, one.at))
                  try {
                    await $.fs.write(path, one.text)
                    $.ui.toast(`Guardado en ${path}`)
                  } catch {
                    $.ui.toast(`No pude guardar en ${path}`)
                  }
                }}
              />
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
