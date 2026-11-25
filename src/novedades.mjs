import path from 'node:path'

import { defaultIo } from './despacho.mjs'
import { getCommonDir } from './repo.mjs'
import { run, sha256, which } from './util.mjs'

export const STATE_REL = ['orca-stack', 'novedades.json']
const USAGE = 'Uso: orca-stack novedades [<nombre>], dentro del clon que sondea la automatización.'
const GH_TIMEOUT_MS = 20_000

// One GraphQL call: the newest issue and PR, and the head and CI state of each open PR, so a comment, a push or a finished check is news.
const QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
issues(first:1,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number updatedAt}}
pullRequests(first:1,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number updatedAt}}
open:pullRequests(first:50,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number headRefOid commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`

const readState = (file, io) => {
  try {
    const parsed = JSON.parse(io.readFile(file))
    return parsed && typeof parsed.ultimas === 'object' && !Array.isArray(parsed.ultimas) ? parsed.ultimas : {}
  } catch {
    return {}
  }
}

const readSnapshot = io => {
  const res = io.sh('gh', ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-f', `query=${QUERY}`], { cwd: io.cwd })
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || String(res.error ?? `gh salió con ${res.status}`)).trim().split('\n')[0])
  let parsed
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    throw new Error('gh no devolvió JSON')
  }
  if (!parsed?.data?.repository) throw new Error(parsed?.errors?.[0]?.message ?? 'la respuesta no trae el repositorio')
  return sha256(JSON.stringify(parsed.data.repository))
}

// The Orca precheck of a polling automation: exit 1 skips the run only when GitHub is provably unchanged.
// Any failure exits 0, so the agent runs and reports it instead of the automation skipping forever.
// gh gets its own limit, well under Orca's 60-second precheck timeout, so a hung gh still reaches the exit-0 path.
const novedadesIo = () => ({
  ...defaultIo(),
  sh: (cmd, args, { cwd } = {}) => run(which(cmd) ?? cmd, args, { cwd, env: process.env, timeout: GH_TIMEOUT_MS }),
})

export const novedadesCommand = async (flags = {}, rest = [], io = novedadesIo()) => {
  const warn = io.err ?? (message => console.error(message))
  const option = Object.entries(flags).find(([, value]) => value !== undefined && value !== false)
  if (rest.length > 1 || option) {
    warn(`novedades: ${option ? `no acepta --${option[0]}` : 'un solo <nombre>'}. ${USAGE} Sigue la automatización para que el agente lo informe.`)
    return 0
  }
  const name = rest[0] ?? 'default'
  let file
  let current
  try {
    file = path.join(getCommonDir(io).commonDir, ...STATE_REL)
    current = readSnapshot(io)
  } catch (error) {
    warn(`novedades: no pude saber si hay novedades (${error.message}): sigue la automatización para que el agente lo informe`)
    return 0
  }
  const ultimas = readState(file, io)
  if (ultimas[name] === current) {
    io.out('novedades: nada nuevo en GitHub desde la última corrida, Orca la saltea')
    return 1
  }
  io.out(Object.hasOwn(ultimas, name) ? 'novedades: hay novedades en GitHub, sigue la automatización' : 'novedades: primera corrida, sigue la automatización')
  try {
    io.mkdirp(path.dirname(file))
    const tmp = `${file}.${process.pid}.tmp`
    io.writeFile(tmp, `${JSON.stringify({ version: 1, ultimas: { ...ultimas, [name]: current } }, null, 2)}\n`)
    io.rename(tmp, file)
  } catch (error) {
    warn(`novedades: no pude guardar ${file} (${error.message}): la próxima corrida tampoco se saltea`)
  }
  return 0
}
