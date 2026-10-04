// Pure helpers for the outgoing-message tray.

export type Draft = { to: string; text: string }

// ```mensaje Ana \n ... \n``` (a longer fence is closed by the same length).
const FENCE = /^(`{3,})mensaje[ \t]*([^\n`]*)\n([\s\S]*?)\n\1[ \t]*$/gm

export const parseDrafts = (answer: string): Draft[] =>
  [...answer.matchAll(FENCE)]
    .map(match => ({ to: (match[2] ?? '').trim(), text: (match[3] ?? '').trim() }))
    .filter(draft => draft.text !== '')

// The system-prompt section. Recipients come from the config (`mensajes.destinatarios`); with none
// configured the convention stays generic and any name after `mensaje` is captured.
export const convention = (recipients: readonly string[] = []): string => {
  const names = recipients.map(name => name.trim()).filter(name => name !== '')
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} o ${names.at(-1)}`
  const who = names.length === 0 ? 'a otra persona' : `a otra persona (${list})`
  const example = names[0] ?? 'Nombre'

  return [
    `Cuando redactes un mensaje que el usuario va a mandar ${who},`,
    'ponelo siempre en un bloque de código cuya info string sea `mensaje` seguida del destinatario, por ejemplo:',
    '```mensaje ' + example,
    'Hola, ...',
    '```',
    'Un bloque por mensaje; el contenido del bloque es exactamente el texto a enviar.',
  ].join('\n')
}

const pad = (n: number): string => String(n).padStart(2, '0')

export const stamp = (at: number): string => {
  const d = new Date(at)

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

export const clock = (at: number): string => {
  const d = new Date(at)

  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const fileName = (to: string, at: number): string => {
  const who = to.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-')

  return `mensaje-${who === '' ? 'sin-destinatario' : who}-${stamp(at)}.txt`
}

// Desktop candidates under a home dir, joined with the separator the home already uses.
export const desktopCandidates = (home: string): string[] => {
  const sep = home.includes('\\') ? '\\' : '/'

  return [`${home}${sep}OneDrive${sep}Desktop`, `${home}${sep}Desktop`]
}

export const joinPath = (folder: string, name: string): string =>
  `${folder}${folder.includes('\\') ? '\\' : '/'}${name}`
