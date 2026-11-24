import path from 'node:path'

import { getCommonDir } from './consultas.mjs'
import { defaultIo } from './despacho.mjs'
import { sha256 } from './util.mjs'

export const STATE_REL = ['orca-stack', 'novedades.json']
const USAGE = 'Uso: orca-stack novedades [<nombre>], dentro del clon que sondea la automatización.'

// One GraphQL call: the newest issue and PR, and the head and CI state of each open PR, so a comment, a push or a finished check is news.
const QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
issues(first:1,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number updatedAt}}
pullRequests(first:1,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number updatedAt}}
open:pullRequests(first:50,states:OPEN){nodes{number headRefOid commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`

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
export const novedadesCommand = async (flags = {}, rest = [], io = defaultIo()) => {
  if (rest.length > 1) throw new Error(USAGE)
  const name = rest[0] ?? 'default'
  const warn = io.err ?? (message => console.error(message))
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
  io.out(name in ultimas ? 'novedades: hay novedades en GitHub, sigue la automatización' : 'novedades: primera corrida, sigue la automatización')
  try {
    io.mkdirp(path.dirname(file))
    io.writeFile(`${file}.tmp`, `${JSON.stringify({ version: 1, ultimas: { ...ultimas, [name]: current } }, null, 2)}\n`)
    io.rename(`${file}.tmp`, file)
  } catch (error) {
    warn(`novedades: no pude guardar ${file} (${error.message}): la próxima corrida tampoco se saltea`)
  }
  return 0
}
