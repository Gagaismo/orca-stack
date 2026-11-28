import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { which } from './util.mjs'

// Where the Orca desktop app keeps its data. Read-only: this tool never writes there.
export const orcaDataDir = home => {
  if (process.env.ORCA_STACK_ORCA_DIR) {
    return process.env.ORCA_STACK_ORCA_DIR
  }
  const real = !process.env.ORCA_STACK_HOME
  if (process.platform === 'win32') {
    return path.join(real ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming') : path.join(home, 'AppData', 'Roaming'), 'orca')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'orca')
  }

  return path.join(real ? process.env.XDG_CONFIG_HOME || path.join(home, '.config') : path.join(home, '.config'), 'orca')
}

export const orcaInstalled = home => Boolean(which('orca')) || existsSync(orcaDataDir(home))

// The agent command overrides of every Orca profile: [{ profile, overrides: { claude, codex, antigravity } }].
export const readOrcaOverrides = home => {
  const profiles = path.join(orcaDataDir(home), 'profiles')
  if (!existsSync(profiles)) {
    return null
  }
  const found = []
  for (const name of readdirSync(profiles)) {
    const file = path.join(profiles, name, 'orca-data.json')
    if (!existsSync(file)) {
      continue
    }
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      found.push({ profile: name, overrides: data?.settings?.agentCmdOverrides ?? {} })
    } catch {
      found.push({ profile: name, overrides: null })
    }
  }

  return found
}

// #430: main keeps each worker's worktree card in Orca's sidebar in sync. The card is only a view: a failed or timed-out
// `orca worktree set` prints one warning line and the command goes on with its exit code and output unchanged.
export const setCard = (io, selector, fields) => {
  let res
  try {
    res = io.sh('orca', ['worktree', 'set', '--worktree', selector, ...fields, '--json'])
  } catch (error) {
    res = { status: null, stdout: '', stderr: '', error }
  }
  let body
  try {
    body = JSON.parse(res.stdout)
  } catch {}
  if (res.status === 0 && !res.error && body?.ok !== false) return true
  const why = String(body?.error?.message ?? (res.stderr || (body ? '' : res.stdout) || res.error || `salió con ${res.status}`)).trim().split(/\r?\n/)[0]
  ;(io.err ?? (message => console.error(message)))(`⚠ No pude actualizar la tarjeta de ${selector} en Orca (orca worktree set): ${why}. Sigo.`)

  return false
}

// #431: Orca's managed accounts of one agent. The stack only lists and selects them (never adds one, never reads an
// account's home) and keeps account ids, never emails. pi and other agents have no Orca accounts.
const PROVIDERS = { claude: 'claude', codex: 'codex', agy: 'antigravity' }
const ACCOUNTS_REL = ['orca-stack', 'cuentas.json']
// A quota episode of an agent starts at its first quota stop and ends 5 hours later (the shortest quota window): an
// older record is dropped, so every account counts as having quota again. Within an episode an exhausted account is
// never selected again, so two exhausted accounts never loop.
const EPISODE_MS = 5 * 60 * 60 * 1000

const episodeOf = (io, commonDir, agent) => {
  const file = path.join(commonDir, ...ACCOUNTS_REL)
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  let all = {}
  try {
    all = JSON.parse(io.readFile(file))
  } catch {}
  if (!isRecord(all)) all = {}
  const now = (io.now ?? Date.now)()
  // A record of another shape (hand-edited, or written by another version) counts as no episode, never as a crash.
  const old = all[agent]
  const valid = isRecord(old) && Number.isFinite(old.at) && Array.isArray(old.exhausted) && isRecord(old.resumed)
  const episode = valid && now - old.at <= EPISODE_MS ? old : { at: now, exhausted: [], resumed: {} }
  const save = () => {
    io.mkdirp(path.dirname(file))
    io.writeFile(`${file}.${process.pid}.tmp`, JSON.stringify({ ...all, [agent]: episode }, null, 2) + '\n')
    io.rename(`${file}.${process.pid}.tmp`, file)
  }

  return { episode, save }
}

const account = (io, args) => {
  let res
  try {
    res = io.sh('orca', ['account', ...args, '--json'])
  } catch (error) {
    res = { status: null, stdout: '', stderr: '', error }
  }
  let body
  try {
    body = JSON.parse(res.stdout)
  } catch {}
  if (res.status === 0 && !res.error && body && body.ok !== false) return body.result ?? {}
  const why = String(body?.error?.message ?? (res.stderr || res.stdout || res.error || `salió con ${res.status}`)).trim().split(/\r?\n/)[0]
  throw new Error(`orca account ${args[0]} falló: ${why}`)
}

// After a quota stop of `agent` on `issue`: { line } when the worker can resume on another account of the same agent,
// { error } (one line) when Orca could not list or select, and {} when no account is left; the last two leave the agent
// blocked as today. Only a worker relaunched after the episode's switch ran on the selected account; any other (a
// worker of the old account, or the same stop told twice before `reanudar`) resumes on it with no new select. A new
// select keeps the workers still pending, so `reanudar` relaunches them on the newly selected account. No line ever points
// to an account the episode lists as exhausted. `launchedNow` (despachar) says the worker just ran on the active account and the
// caller relaunches it; otherwise the issue stays pending until `reanudar` relaunches it.
export const switchAccount = (io, commonDir, agent, issue, { launchedNow = false } = {}) => {
  const provider = PROVIDERS[agent]
  if (!provider) return {}
  const { episode: ep, save } = episodeOf(io, commonDir, agent)
  const key = String(issue)
  try {
    const listed = account(io, ['list', '--agent', provider])[provider] ?? {}
    const active = listed.activeAccountId == null ? null : String(listed.activeAccountId)
    if (launchedNow || ep.to === undefined || ep.to !== active || ep.resumed[key] === false) {
      if (active !== null) ep.exhausted = [...new Set([...ep.exhausted, active])]
      const to = (listed.accounts ?? []).map(entry => String(entry?.id ?? '')).find(id => id !== '' && !ep.exhausted.includes(id))
      if (to === undefined) {
        save()
        return {}
      }
      account(io, ['select', '--agent', provider, '--account', to])
      Object.assign(ep, { from: active ?? 'system', to, resumed: Object.fromEntries(Object.entries(ep.resumed).filter(([, pending]) => pending)) })
    } else if (ep.exhausted.includes(active)) {
      // A stop on the selected account after it was exhausted (a worker launched on it, or a pending stop told again):
      // no account is left, so the worker is blocked and is no longer pending a relaunch.
      delete ep.resumed[key]
      save()
      return {}
    }
    ep.resumed[key] = !launchedNow
    save()

    return { line: `cuenta cambiada: ${agent} ${ep.from} → ${ep.to}` }
  } catch (error) {
    return { error: error.message }
  }
}

// Whether `reanudar` must relaunch `issue` after an account switch (a paused session keeps its account); `done` clears it.
// Never toward an account the episode already lists as exhausted: the agent is blocked as today.
export const pendingAfterSwitch = (io, commonDir, agent, issue, done = false) => {
  const { episode, save } = episodeOf(io, commonDir, agent)
  if (episode.resumed[String(issue)] !== true || episode.exhausted.includes(episode.to)) return false
  if (done) {
    episode.resumed[String(issue)] = false
    save()
  }

  return true
}

// #521: Orca sets agentIdentity on `orca terminal show` once the wrapper has booted a recognized TUI agent.
export const terminalRecognized = (io, handle, agent) => {
  if (!handle) return false
  let res
  try {
    res = io.sh('orca', ['terminal', 'show', '--terminal', handle, '--json'])
  } catch {
    return false
  }
  if (!res || res.status !== 0) return false
  let body
  try {
    body = JSON.parse(res.stdout)
  } catch {
    return false
  }
  if (body?.ok === false) return false
  const identity = body?.result?.terminal?.agentIdentity
  return typeof identity === 'string' && identity.trim().toLowerCase().split('/')[0] === agent
}
