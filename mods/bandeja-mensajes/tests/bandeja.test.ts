import { expect, mock, test } from 'claude-code/testing'

import { convention, fileName, parseDrafts } from '../hooks/mensajes'
import { world } from './harness'

const fence = '```'
const ANSWER = [
  'Dale, te dejo los mensajes:',
  '',
  `${fence}mensaje Ana`,
  'Hola Ana, ¿pudiste revisar el flujo?',
  'Gracias.',
  fence,
  '',
  `${fence}mensaje   Grupo Beto `,
  'Mañana 9:00 la reunión.',
  fence,
  '',
  `${fence}mensaje`,
  'Sin destinatario',
  fence,
  '',
  `${fence}ts`,
  'const no = "es un mensaje"',
  fence,
].join('\n')

const turn = (answer: string) => ({
  answer,
  durationMs: 1,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
})

test('parses only mensaje fences, with optional recipient', () => {
  expect(parseDrafts(ANSWER)).toEqual([
    { to: 'Ana', text: 'Hola Ana, ¿pudiste revisar el flujo?\nGracias.' },
    { to: 'Grupo Beto', text: 'Mañana 9:00 la reunión.' },
    { to: '', text: 'Sin destinatario' },
  ])
  expect(parseDrafts('texto ```mensaje Ana no es un bloque``` suelto')).toEqual([])
  expect(parseDrafts('````mensaje Ana\nhola ``` adentro\n````')).toEqual([
    { to: 'Ana', text: 'hola ``` adentro' },
  ])
})

test('file names are safe and stamped', () => {
  const at = new Date(2026, 9, 2, 9, 5).getTime()
  expect(fileName('Ana', at)).toBe('mensaje-Ana-2026-10-02-0905.txt')
  expect(fileName('Grupo: Beto/Samu', at)).toBe('mensaje-Grupo-BetoSamu-2026-10-02-0905.txt')
  expect(fileName('', at)).toBe('mensaje-sin-destinatario-2026-10-02-0905.txt')
})

const setup = (on: Parameters<typeof world>[0], exists: string[]) => {
  const w = world(on)
  const copied: string[] = []
  const written = new Map<string, string>()
  on('prompt.compose', () => ({ sections: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.copy', (_$, e) => {
    copied.push(e.text)

    return { value: { isCopied: true as const } }
  })
  on('fs.exists', (_$, e) => ({ value: exists.includes(e.path) }))
  on('fs.write', (_$, e) => {
    written.set(e.path, e.text)

    return { value: undefined }
  })

  return { ...w, copied, written }
}

test('turn end captures drafts newest first, toasts, dedupes and keeps 50', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  const w = setup(on, [])

  await $.turn.complete(turn(ANSWER))
  expect(w.toasts).toEqual([
    'Mensaje guardado en la bandeja',
    'Mensaje para Grupo Beto guardado en la bandeja',
    'Mensaje para Ana guardado en la bandeja',
  ])
  const items = w.state.get('bandeja-mensajes/items')?.value as { to: string }[]
  expect(items.map(one => one.to)).toEqual(['Ana', 'Grupo Beto', ''])

  // "poneme los mensajes de nuevo": the same blocks again add nothing new.
  await $.turn.complete(turn(ANSWER))
  expect(w.toasts).toHaveLength(3)
  expect(w.state.get('bandeja-mensajes/items')?.value).toHaveLength(3)

  for (let i = 0; i < 60; i += 1) {
    await $.turn.complete(turn(`${fence}mensaje X\nmensaje ${i}\n${fence}`))
  }
  expect(w.state.get('bandeja-mensajes/items')?.value).toHaveLength(50)
})

test('the system prompt explains the convention', async ($, on) => {
  mock.store(on)
  setup(on, [])
  const out = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  expect(out.sections.at(-1)?.text).toContain('```mensaje')
})

test('/mensajes lists stored messages; Copiar and Guardar act on them', async ($, on) => {
  const at = new Date(2026, 9, 2, 9, 5).getTime()
  mock.store(on, { mensajes: [{ id: 'a', to: 'Ana', text: 'Hola Ana', at }] })
  mock.env(on, { USERPROFILE: 'C:\\Users\\tester' })
  const w = setup(on, ['C:\\Users\\tester\\Desktop'])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })

  const out = await $.command.run({
    command: 'mensajes',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(out.text).toBe('Bandeja de mensajes abierta.')

  const ui = await $.ui.mount({
    plugin: 'bandeja-mensajes',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'mensajes',
    props: {
      title: 'Bandeja de mensajes',
      isFocused: false,
      bodyColumns: 80,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  expect((await ui.find({ type: 'Text', text: /Ana/ }))?.text).toContain('Ana · 02/10 09:05')

  await ui.press({ key: 'copy:a' })
  expect(w.copied).toEqual(['Hola Ana'])
  expect(w.toasts.at(-1)).toBe('Copiado')

  await ui.press({ key: 'save:a' })
  const path = 'C:\\Users\\tester\\Desktop\\mensaje-Ana-2026-10-02-0905.txt'
  expect(w.written.get(path)).toBe('Hola Ana')
  expect(w.toasts.at(-1)).toBe(`Guardado en ${path}`)
  await ui.unmount()
})

test('Guardar prefers the OneDrive Desktop and uses the first folder that exists', async ($, on) => {
  const at = new Date(2026, 9, 2, 9, 5).getTime()
  mock.store(on, { mensajes: [{ id: 'a', to: 'Ana', text: 'Hola', at }] })
  mock.env(on, { USERPROFILE: 'C:\\Users\\tester' })
  const w = setup(on, ['C:\\Users\\tester\\OneDrive\\Desktop', 'C:\\Users\\tester\\Desktop'])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  const props = {
    title: 't',
    isFocused: false,
    bodyColumns: 80,
    placement: 'inline' as const,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  }
  const ui = await $.ui.mount({
    plugin: 'bandeja-mensajes',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'mensajes',
    props,
  })
  await ui.press({ key: 'save:a' })
  expect([...w.written.keys()]).toEqual([
    'C:\\Users\\tester\\OneDrive\\Desktop\\mensaje-Ana-2026-10-02-0905.txt',
  ])
  await ui.unmount()
})

test('the convention is generic without recipients and names them when configured', () => {
  const generic = convention()
  expect(generic).toContain('a otra persona,')
  expect(generic).toContain('```mensaje Nombre')
  expect(generic).not.toMatch(/Ana|Beto/)
  expect(convention(['Ana'])).toContain('a otra persona (Ana),')
  expect(convention(['Ana', 'Beto', 'el grupo'])).toContain('(Ana, Beto o el grupo)')
  expect(convention(['Ana', 'Beto'])).toContain('```mensaje Ana')
})

test('the system prompt takes the recipients from the layered config', async ($, on) => {
  mock.store(on)
  world(on)
  on('prompt.compose', () => ({ sections: [] }))
  mock.env(on, { HOME: '/home/u' })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '/r/.git\n/r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  const norm = (path: string): string => path.replace(/^[A-Za-z]:/, '').split(String.fromCharCode(92)).join('/')
  const layers: Record<string, unknown> = {
    '/r/.orca-stack.json': { mensajes: { destinatarios: ['Ana'] } },
    '/r/.orca-stack.local.json': { mensajes: { destinatarios: ['Ana', 'Beto'] } },
  }
  on('fs.exists', (_$, e) => ({ value: norm(e.path) in layers }))
  on('fs.read', (_$, e) => ({ value: JSON.stringify(layers[norm(e.path)]) }))
  const out = await $.prompt.compose({
    model: 'm',
    promptModel: 'm',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  // the local layer replaces the committed array
  expect(out.sections.at(-1)?.text).toContain('(Ana o Beto)')
})
