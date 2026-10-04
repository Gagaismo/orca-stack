import type { EngineInterface, Register } from 'claude-code'

import type { TableroBoard } from '../types'
import { loadConfig } from './orca-config'
import type { Host } from './orca-config'
import {
  FIELDS,
  GITHUB_REMOTE,
  bandText,
  checksText,
  explainGhFailure,
  parsePrs,
  parseWorktrees,
  prompts,
  relativeTime,
  reviewText,
} from './tablero'

const PANE = 'tablero'
const EVERY_MS = 3 * 60 * 1000
const board = { plugin: 'tablero-despacho', key: 'board' } as const

const empty: TableroBoard = { status: 'unknown', message: '', prs: [], at: 0, hasDespacho: false }

// The engine's `$` cannot cross an import: the config module gets these closures instead.
const hostOf = ($: EngineInterface): Host => ({
  home: async () => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
  exists: path => $.fs.exists(path),
  read: path => $.fs.read(path),
  git: argv => $.process.run(argv, { timeoutMs: 10_000 }),
  now: () => $.clock.now(),
})

const refresh = async ($: EngineInterface): Promise<void> => {
  let hasDespacho = false
  const put = (next: Omit<TableroBoard, 'at' | 'hasDespacho'>) =>
    $.clock.now().then(at => $.state.set(board, { ...next, at, hasDespacho }))

  // Nothing runs outside a git repository with a GitHub remote.
  const repo = await $.session.repo()
  if (repo === null || repo.remote === null || !GITHUB_REMOTE.test(repo.remote)) {
    await put({ status: 'norepo', message: '', prs: [] })
    return
  }
  // The dispatch buttons exist only when the project config declares `despacho`.
  const script = (await loadConfig(hostOf($))).despacho?.script
  hasDespacho = typeof script === 'string' && script.trim() !== ''
  try {
    const gh = await $.process.run(
      ['gh', 'pr', 'list', '--state', 'open', '--limit', '50', '--json', FIELDS],
      { timeoutMs: 20_000 },
    )
    if (gh.exitCode !== 0) {
      const failure = explainGhFailure(gh.stderr)
      await put(
        failure.kind === 'norepo'
          ? { status: 'norepo', message: '', prs: [] }
          : { status: 'error', message: failure.message, prs: [] },
      )
      return
    }
    const git = await $.process.run(['git', 'worktree', 'list', '--porcelain']).catch(() => undefined)
    const worktrees = parseWorktrees(git?.exitCode === 0 ? git.stdout : '')
    await put({ status: 'ok', message: '', prs: parsePrs(gh.stdout, worktrees) })
  } catch {
    await put({
      status: 'error',
      message: 'No pude correr gh: ¿está instalado y en el PATH?',
      prs: [],
    })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tablero',
      description: 'Abre el tablero de PRs, checks, reviews y worktrees',
    })
    // Off the start-up path: the first read must not hold the session back.
    $.clock.after(0, () => void refresh($))
    $.clock.every(EVERY_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'tablero' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Tablero de despacho' })
    await refresh($)

    return { text: 'Tablero de despacho abierto.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value = empty } = await $.state.get(board)
    if (e.props.hasSurvey || value.status !== 'ok' || value.prs.length === 0) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>{bandText(value.prs)} </Text>
        <Button
          key="open"
          label="Tablero"
          onPress={async () => {
            await $.ui.open({ id: PANE, title: 'Tablero de despacho' })
            await refresh($)
          }}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const { value = empty } = await $.state.get(board)
    const now = await $.clock.now()
    const send = (text: string) => $.prompt.submit({ text, asUser: true })

    const body =
      value.status === 'norepo' ? (
        <Text dimColor>Este directorio no es un repo de git con remoto en GitHub.</Text>
      ) : value.status === 'error' ? (
        <Text color="red">{value.message}</Text>
      ) : value.status !== 'ok' ? (
        <Text dimColor>Cargando…</Text>
      ) : value.prs.length === 0 ? (
        <Text dimColor>No hay PRs abiertos.</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {value.prs.map(pr => (
            <Box key={`pr:${pr.number}`} flexDirection="column">
              <Text bold>
                #{pr.number} {pr.title}
                {pr.isDraft ? ' (borrador)' : ''}
              </Text>
              <Text dimColor>
                {pr.branch} · {pr.author} · {relativeTime(pr.updatedAt, now)}
              </Text>
              <Text
                color={pr.checks.state === 'fail' ? 'red' : pr.checks.state === 'ok' ? 'green' : undefined}
              >
                checks {checksText(pr.checks)} · {reviewText(pr.review)}
                {pr.worktree === undefined ? '' : ` · worktree ${pr.worktree}`}
              </Text>
              <Box gap={2}>
                {value.hasDespacho ? (
                  <Button
                    key={`review:${pr.number}`}
                    label="Revisar con agy"
                    onPress={() => send(prompts.review(pr.number))}
                  />
                ) : null}
                <Button
                  key={`status:${pr.number}`}
                  label="Ver estado"
                  onPress={() => send(prompts.status(pr.number))}
                />
                <Button
                  key={`gentle:${pr.number}`}
                  label="Consultar a Gentle Shell"
                  onPress={() => send(prompts.gentle(pr.number))}
                />
                <Button
                  key={`merge:${pr.number}`}
                  label="Mergear"
                  onPress={() => send(prompts.merge(pr.number))}
                />
              </Box>
            </Box>
          ))}
        </Box>
      )

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={2}>
          <Text dimColor>
            {value.at === 0 ? 'Sin datos todavía' : `Actualizado ${relativeTime(value.at, now)}`}
          </Text>
          <Button key="refresh" label="Actualizar" onPress={() => refresh($)} />
        </Box>
        {body}
      </Box>
    )
  })
}
