import { repoWorktrees } from './worker-terminals.mjs'
import { isPending, isStatus, latestChecks } from './checks.mjs'
import { FAMILIES, WORKER_AGENTS, crossFamilyReviewers, defaultIo, familyOf, loadConfig, rddFallbackFor, rosterOf } from './despacho.mjs'
import { commitOf, markerLines, markerValue, namesCommit, normalizeBody } from './marcas.mjs'
import { baseMigrations, migrationSpec, openReservations, orderBlockers, rawNumberOf } from './migraciones.mjs'
import { setCard } from './orca.mjs'
import { getCommonDir } from './repo.mjs'
import { closedIssues } from './vigilar.mjs'

// `orca-stack estado`: MAIN.md step 7 on the current head of each PR, read once (S1, #366). Its `--json` output is the
// attestation Gentle Shell's merge guard reads: keep its shape stable.
const USAGE = 'Uso: orca-stack estado [<pr>...] [--json]'
export const PR_VIEW_FIELDS = 'number,headRefOid,headRefName,body,comments,reviews,files,statusCheckRollup,baseRefName,mergeable,state,url'
const CHECK_GREEN = ['SUCCESS', 'SKIPPED', 'NEUTRAL']
const EMPTY_LIST = new Set(['', '-', 'nada', 'ninguno', 'ninguna'])

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const detail = res => (res.stderr || res.stdout || String(res.error ?? '')).trim().split(/\r?\n/)[0]
const parse = res => {
  try {
    return JSON.parse(res.stdout)
  } catch {
    return undefined
  }
}

// Source of truth for riesgo path matching, review parsing, RDD requests and riskDeny (#391), with BOM-tolerant marker
// reading (#365), S12's coverage and #465's out-of-budget marker.

// Minimal glob: * and ? stay inside one path segment, ** crosses segments, `**/` may match nothing, a trailing / means
// "everything under".
export const globToRegExp = glob => {
  const g = glob.endsWith('/') ? `${glob}**` : glob
  let out = ''
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i]
    if (ch === '*' && g[i + 1] === '*') {
      i += 1
      if (g[i + 1] === '/') {
        i += 1
        out += '(?:.*/)?'
      } else {
        out += '.*'
      }
    } else if (ch === '*') {
      out += '[^/]*'
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }

  return new RegExp(`^${out}$`)
}

export const riskyFile = (files, globs) => {
  const patterns = (globs ?? []).filter(one => typeof one === 'string' && one.trim() !== '').map(one => globToRegExp(one.trim()))

  return files.find(file => patterns.some(pattern => pattern.test(file.replace(/\\/g, '/'))))
}

const implementerOf = body => markerValue(body, 'Implementador')?.split(/\s+/)[0]?.toLowerCase() || undefined

// Comments and reviews in the order they were posted (createdAt, submittedAt); without a time on every item, comments
// then reviews, as gh lists them.
const bodiesOf = pr => {
  const posted = [...(pr.comments ?? []), ...(pr.reviews ?? [])]
  const timeOf = one => Date.parse(String(one?.createdAt ?? one?.submittedAt ?? ''))
  const ordered = posted.every(one => !Number.isNaN(timeOf(one))) ? [...posted].sort((a, b) => timeOf(a) - timeOf(b)) : posted

  return ordered.map(one => one?.body).filter(body => typeof body === 'string')
}

// A review: `Revisor: <agent>` and `Commit: <sha>` among the first five lines of one body. Clean: the first non-empty
// line after `## BLOQUEA` is `nada`. `Revisor: <agent> (RDD: <lens>, …)` is an RDD review and carries its lenses.
const reviewOf = body => {
  const lines = markerLines(body)
  const named = lines.slice(0, 5).map(line => /^Revisor:\s*(\S+)(?:\s+\(RDD:\s*([^()]*)\))?$/i.exec(line)).find(match => match !== null)
  const commit = commitOf(body, { within: 5 })
  if (!named || !commit) return undefined
  const at = lines.findIndex(line => /^##\s*BLOQUEA\b/i.test(line))
  const verdict = at < 0 ? undefined : lines.slice(at + 1).find(line => line !== '')
  const lenses = named[2] === undefined ? undefined : named[2].split(',').map(lens => lens.trim().toLowerCase()).filter(lens => lens !== '')

  return { reviewer: named[1].toLowerCase(), commit, clean: verdict?.toLowerCase() === 'nada', verdict, lenses, body }
}

const blockerReason = review => {
  if (!/^nada/i.test(review.verdict ?? '') || review.clean) return 'tiene bloqueos'
  const chars = Array.from(review.verdict)
  const verdict = chars.length > 80 ? chars.slice(0, 80).join('') + '\u2026' : review.verdict
  return `no dice "nada" solo en ## BLOQUEA: "${verdict}"`
}

// main's `RDD: <sha> (<lentes>)` request for this head, its lenses sorted, or undefined. A body that is a review is no
// request.
const rddRequestOf = (body, head) => {
  const lines = markerLines(body)
  if (lines.some(line => /^Revisor:/i.test(line) || /^##\s*BLOQUEA\b/i.test(line))) return undefined
  const match = /^RDD:\s*`?([0-9a-f]{7,40})`?\s*\(([^()]*)\)$/i.exec(lines.find(line => line !== '') ?? '')
  if (match === null || !namesCommit(match[1], head)) return undefined

  return match[2].split(',').map(lens => lens.trim().toLowerCase()).filter(lens => lens !== '').sort()
}
const rddRequestsOf = (bodies, head) => bodies.flatMap(body => {
  const lenses = rddRequestOf(body, head)
  return lenses === undefined ? [] : [lenses]
})
// #465 S3: pi's comment whose first line is `RDD fuera de presupuesto: <sha> (<stop reason>)` naming this head, posted
// after main's `RDD: <sha> (…)` request for it. A body that is a review is never this comment.
const budgetStopOf = (body, head) => {
  const lines = markerLines(body)
  if (lines.some(line => /^Revisor:/i.test(line) || /^##\s*BLOQUEA\b/i.test(line))) return false

  return namesCommit(/^RDD fuera de presupuesto:\s*`?([0-9a-f]{7,40})`?\s*\([^()]+\)$/i.exec((lines.find(line => line !== '') ?? '').trim())?.[1], head)
}
const rddBudgetStopped = (bodies, head) => bodies.some((body, at) => budgetStopOf(body, head) && rddRequestsOf(bodies.slice(0, at), head).length > 0)
const rddMissing = (n, sha) =>
  `falta un review RDD limpio de pi con la lente risk sobre el commit ${sha} ` +
  'o, si el RDD no entró en el presupuesto, un review limpio de un agente del roster de otra familia distinta de la de pi; eso último cuenta solo con un comentario cuya primera línea es ' +
  `"RDD fuera de presupuesto: ${sha} (<motivo>)", publicado después de tu pedido RDD: sobre ese commit, y sin él los reviews de otras familias no lo reemplazan. ` +
  `Corré \`orca-stack rebote ${n} --rdd risk\` (podés sumar lentes).`
const sameLenses = (a, b) => [...(a ?? [])].sort().join(',') === [...(b ?? [])].sort().join(',')

// S12: a review counts only when it read every riesgo path. A `## Cobertura` section lists `Sin leer:` paths (on its line,
// comma-separated, or as bullets under it); a review that calls itself partial (`parcial`) without that section never
// counts. A review that does not count still blocks with its findings.
export const coverageOf = (body, riesgo) => {
  const lines = markerLines(body)
  const at = lines.findIndex(line => /^##\s*Cobertura\b/i.test(line))
  if (at < 0) return /\bparcial\b/i.test(body) ? { counts: false, why: 'es parcial y no tiene ## Cobertura' } : { counts: true }
  const unread = []
  let listing = false
  for (const line of lines.slice(at + 1)) {
    if (/^##\s/.test(line)) break
    const label = /^Sin leer:\s*(.*)$/i.exec(line)
    if (label) {
      listing = true
      unread.push(...label[1].split(','))
    } else if (listing && /^[-*]\s+/.test(line)) {
      unread.push(line.replace(/^[-*]\s+/, ''))
    } else if (line !== '') {
      listing = false
    }
  }
  const paths = unread.map(one => one.trim().replace(/^`|`$/g, '').trim()).filter(one => !EMPTY_LIST.has(one.toLowerCase()))
  const file = riskyFile(paths, riesgo)

  return file === undefined ? { counts: true } : { counts: false, why: `no leyó ${file}, que es de riesgo` }
}

const revisarSuggestion = (n, config, candidates) => {
  if (candidates.length === 0) return ''
  const ask = Array.isArray(config.agentes?.preguntarAntes) ? config.agentes.preguntarAntes.map(a => String(a).toLowerCase()) : []
  const pick = candidates[0]
  const askNote = ask.includes(pick) ? ` ${pick} está en preguntarAntes: pedile el OK al humano y agregá --confirmado.` : ''

  return `Corré \`orca-stack revisar ${n} ${pick}\`.${askNote}`
}

const rddReviewNotes = (posted, rddReviews, requested) => {
  const unrequested = posted.some(one => one.reviewer === 'pi' && one.lenses !== undefined && !requested(one))
    ? ' Un review RDD de pi que main no pidió antes, con esas lentes y sobre ese commit (el comentario `RDD: <sha> (<lentes>)` que publica `orca-stack rebote --rdd`), no cuenta.'
    : ''
  const noRisk = rddReviews.length > 0 ? ' El review RDD de pi sobre ese commit no cuenta: no tiene la lente risk.' : ''

  return `${noRisk}${unrequested}`
}

const isCrossFamilyPiReview = (config, reviewer) => {
  if (!WORKER_AGENTS.includes(reviewer)) return false
  const own = familyOf(config, 'pi', 'ticket').family
  const { family } = familyOf(config, reviewer, 'review')

  return family !== undefined && family !== own
}

// Why a PR touching a riesgo path cannot merge yet, or undefined (#391: estado is the single source). A review
// that S12 does not count still blocks, but never covers.
const riskDeny = (n, file, facts, config, now) => {
  const sha = facts.head.slice(0, 7)
  const prefix = `PR #${n} toca una ruta de riesgo (${file})`
  const agents = FAMILIES.agents
  if (facts.implementer === undefined || !agents.includes(facts.implementer)) {
    return (
      `${prefix} y su body no tiene una línea "Implementador: <agente>" con uno de ${agents.join(', ')}: ` +
      `sin ella no sé quién puede revisarlo. Agregala con \`gh pr edit ${n} --body-file <archivo>\`.`
    )
  }
  const roster = rosterOf(config, now)
  const candidates = crossFamilyReviewers(config, facts.implementer, roster)
  const rdd = facts.implementer === 'pi' && config.agentes?.pi?.review === 'rdd'
  const rddFallback = rddFallbackFor(config, facts.implementer, now)
  const rddAllowed = rdd || rddFallback
  const requested = one => one.reviewer === 'pi' && rddRequestsOf(facts.bodies.slice(0, one.at), facts.head).some(lenses => sameLenses(lenses, one.lenses))
  const posted = facts.posted.filter(one => namesCommit(one.commit, facts.head))
  const reviews = posted.filter(one => one.lenses === undefined || (rddAllowed && requested(one)))
  const blocked = reviews.find(review => !review.clean)
  if (blocked !== undefined) {
    return (
      `${prefix} y el review de ${blocked.reviewer} sobre el commit ${sha} ${blockerReason(blocked)}. ` +
      'En una ruta de riesgo un bloqueo no se salda con "Decidido por main": corregilo y pedí un review nuevo, o pasale la decisión al humano.'
    )
  }
  const counting = reviews.filter(review => review.covered)
  const reviewers = [...new Set(counting.filter(review => review.lenses === undefined).map(review => review.reviewer))]
  const rddReviews = counting.filter(review => review.lenses !== undefined)
  if (rddReviews.some(review => review.lenses.includes('risk'))) return undefined
  if (rdd && !rddBudgetStopped(facts.bodies, facts.head)) {
    const sinReview = facts.bodies.some(body => /^Sin review:/i.test(normalizeBody(body))) ? ' Un comentario "Sin review:" no cuenta en una ruta de riesgo.' : ''

    return `${prefix} y lo escribió pi en modo RDD: ${rddMissing(n, sha)}${rddReviewNotes(posted, rddReviews, requested)}${sinReview}`
  }
  if (facts.implementer !== 'pi') {
    return reviewers.includes('pi')
      ? undefined
      : `${prefix}: falta un review de pi sobre el commit ${sha}. Corré \`orca-stack revisar ${n} pi\` y mergeá cuando el review esté limpio.`
  }

  const own = familyOf(config, 'pi', 'ticket').family
  const covered = new Set()
  const skipped = []
  for (const reviewer of reviewers) {
    const { family, model } = familyOf(config, reviewer, 'review')
    if (!WORKER_AGENTS.includes(reviewer)) skipped.push(`${reviewer}: no es un agente worker del stack`)
    else if (family === undefined && model === undefined) skipped.push(`${reviewer}: no tiene modelo para revisar en agentes.modelos, así que no sé su familia`)
    else if (family === undefined) skipped.push(`${reviewer}: su modelo ${model} no tiene una familia reconocida (agregá su patrón en FAMILIES)`)
    else if (family !== own) covered.add(family)
  }
  if (covered.size >= 1) return undefined

  const notCounted = skipped.length === 0 ? '' : ` No cuento ${skipped.join('; ')}.`
  if (candidates.length > 0) {
    return (
      `${prefix} y lo escribió pi: falta un review limpio sobre el commit ${sha} de un agente del roster ` +
      `de otra familia de modelo distinta de la de pi (${own ?? '?'}).${notCounted} ` +
      revisarSuggestion(n, config, candidates)
    )
  }
  if (rdd && rddBudgetStopped(facts.bodies, facts.head)) {
    return `${prefix} y lo escribió pi: el review RDD se detuvo por presupuesto y no hay otro agente de otra familia disponible en el roster (${own ?? '?'}): decidilo con el humano.${notCounted}`
  }
  if (!rddFallback) {
    return `${prefix} y lo escribió pi: falta un review limpio sobre el commit ${sha} de otra familia distinta de la de pi (${own ?? '?'}), pero falta agentes.usa en la config.${notCounted}`
  }

  return (
    `${prefix} y lo escribió pi: no hay otro agente de otra familia disponible en el roster; ` +
    `falta un review RDD limpio de pi con la lente risk sobre el commit ${sha}.${notCounted} ` +
    `Corré \`orca-stack rebote ${n} --rdd risk\` (podés sumar lentes).${rddReviewNotes(posted, rddReviews, requested)}`
  )
}

// MAIN.md step 7 (c): the latest row of every check finished SUCCESS, SKIPPED or NEUTRAL; none is pending.
const ciOf = rollup => {
  const checks = latestChecks(rollup).map(entry => entry.check)
  const name = check => (isStatus(check) ? check.context : check.name)
  const green = check => (isStatus(check) ? check.state === 'SUCCESS' : check.status === 'COMPLETED' && CHECK_GREEN.includes(check.conclusion))
  if (checks.length === 0) return { ci: 'pending', falta: '(c) el head no tiene checks' }
  const red = checks.filter(check => !isPending(check) && !green(check))
  if (red.length > 0) return { ci: 'red', falta: `(c) CI roja: ${red.map(check => `${name(check)}=${isStatus(check) ? check.state : check.conclusion || check.status}`).join(', ')}` }
  const pending = checks.filter(isPending)
  if (pending.length > 0) return { ci: 'pending', falta: `(c) CI pendiente: ${pending.map(name).join(', ')}` }

  return { ci: 'green' }
}

// S11: every migration the PR adds (matches `migraciones.glob` and is not on origin/<base>) must have a number above the
// highest one on origin/<base>; goose rejects them by merge order. main-autonomo-2 S2: and it waits for every other open
// PR, or open reservation of another issue, that holds a lower number than this PR's lowest added one.
const migrationsOf = (pr, files, base, config, root, io, ctx) => {
  const spec = config.migraciones
  if (!isPlain(spec) || typeof spec.glob !== 'string' || typeof spec.numero !== 'string') return { falta: [], fixes: [] }
  const pattern = globToRegExp(spec.glob)
  const ours = files.filter(file => pattern.test(file))
  if (ours.length === 0) return { falta: [], fixes: [] }
  let parsed
  try {
    parsed = migrationSpec(config)
  } catch (error) {
    return { falta: [error.message], fixes: [] }
  }
  const fetched = io.sh('git', ['fetch', 'origin', base], { cwd: root })
  const listed = fetched.status === 0 ? baseMigrations(parsed, base, root, io) : { error: detail(fetched) }
  if (listed.error !== undefined) return { falta: [`no pude leer las migraciones de origin/${base}: ${listed.error}`], fixes: [] }
  const onBase = listed.files
  const numbers = onBase.map(file => rawNumberOf(parsed, file)).filter(n => n !== undefined).map(Number)
  const added = ours.filter(one => !onBase.includes(one)).sort()
  const falta = []
  const fixes = []
  if (numbers.length > 0) {
    const max = Math.max(...numbers)
    let next = max
    for (const file of added) {
      const raw = rawNumberOf(parsed, file)
      if (raw === undefined || Number(raw) > max) continue
      next += 1
      const item = `migración ${file} (${Number(raw)}) no es mayor que ${max} en ${base}`
      falta.push(item)
      fixes.push(`${item}: renumerala a ${String(next).padStart(raw.length, '0')} (renombrá el archivo y lo que lo nombre) para que corra después de las de ${base}.`)
    }
  }

  const numbered = added.flatMap(file => {
    const raw = rawNumberOf(parsed, file)
    return raw === undefined ? [] : [{ file, numero: Number(raw) }]
  })
  if (numbered.length === 0) return { falta, fixes }
  const mine = numbered.reduce((low, one) => (one.numero < low.numero ? one : low))
  const open = ctx.openPrs()
  if (open.error !== undefined) return { falta: [...falta, `no pude listar los PRs abiertos para ordenar las migraciones: ${open.error}`], fixes }
  const reservations = ctx.reservations()
  if (reservations.error !== undefined) return { falta: [...falta, reservations.error], fixes }
  const others = open.prs.map(one => ({
    number: one?.number,
    body: one?.body,
    added: (one?.files ?? [])
      .map(file => file?.path)
      .filter(file => typeof file === 'string' && parsed.pattern.test(file) && !onBase.includes(file))
      .map(file => rawNumberOf(parsed, file))
      .filter(raw => raw !== undefined)
      .map(Number),
  }))
  const selfIssue = closedIssues(pr.body)[0]
  falta.push(...orderBlockers({ mine, selfIssue, selfPr: pr.number, others, reservas: reservations.reservas }))

  return { falta, fixes }
}

// The other open PRs and the open reservations, read once per estado run and only when a PR adds a migration.
const migrationContext = (commonDir, root, io) => {
  let prs
  let reservas
  return {
    openPrs: () => {
      if (prs === undefined) {
        const res = io.sh('gh', ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,body,files', '--limit', '100'], { cwd: root })
        const listed = res.status === 0 ? parse(res) : undefined
        prs = Array.isArray(listed) ? { prs: listed } : { error: detail(res) || 'gh pr list no devolvió una lista' }
      }

      return prs
    },
    reservations: () => {
      if (reservas === undefined) reservas = openReservations({ commonDir, root, io })

      return reservas
    },
  }
}

const reviewBody = (head, fixes) =>
  `Revisor: main (migraciones)\nCommit: ${head}\n\n## BLOQUEA\n${fixes.map((fix, i) => `${i + 1}. ${fix}`).join('\n')}\n\n## SUGERENCIAS\nnada`

// One PR against MAIN.md step 7 on its current head.
// #377: a repo that merges on green CI without reviews says so with `"reviewParaMerge": false`. The Gentle Shell guard
// trusts this attestation, so the key is read only from the .orca-stack.json committed on the PR's base branch on
// GitHub, never from the (agent-writable) checkout; any failure keeps the full step 7.
// The repository comes from the PR's own url, so the config read and the PR read cannot point at different repos.
export const baseConfigOf = (pr, base, root, io) => {
  const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(String(pr.url ?? ''))?.[1] ?? '{owner}/{repo}'
  const res = io.sh('gh', ['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/.orca-stack.json?ref=${encodeURIComponent(base)}`], { cwd: root })
  if (res.status !== 0) return undefined
  try {
    const parsed = JSON.parse(res.stdout)
    return isPlain(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const evaluate = (pr, config, root, io, now, ctx) => {
  const n = pr.number
  const head = String(pr.headRefOid ?? '').toLowerCase()
  const sha7 = head.slice(0, 7)
  const falta = []
  if (pr.state !== 'OPEN') falta.push(pr.state === 'MERGED' ? 'el PR está mergeado' : 'el PR está cerrado')
  else if (String(pr.mergeable ?? '').toUpperCase() === 'CONFLICTING') falta.push('el PR está en conflicto con la base')

  const implementer = implementerOf(pr.body)
  const hasConfiguredRoster = Array.isArray(config.agentes?.usa)
  const roster = rosterOf(config, now)
  const candidates = implementer ? crossFamilyReviewers(config, implementer, roster) : []
  const rdd = implementer === 'pi' && config.agentes?.pi?.review === 'rdd'
  const rddFallback = rddFallbackFor(config, implementer, now)
  const rddAllowed = rdd || rddFallback
  // #377: the waiver and, while it applies, the committed riesgo come from the base branch on GitHub (an agent can empty
  // riesgo in its checkout, not on the protected base).
  const committed = baseConfigOf(pr, pr.baseRefName || config.ramaBase || 'main', root, io)
  const waived = committed?.reviewParaMerge === false
  const riesgo = [...new Set([...(Array.isArray(config.riesgo) ? config.riesgo : []), ...(waived && Array.isArray(committed.riesgo) ? committed.riesgo : [])])]
  const files = (pr.files ?? []).map(file => file?.path).filter(file => typeof file === 'string')
  const risky = riskyFile(files, riesgo)
  const bodies = bodiesOf(pr)
  const posted = bodies.flatMap((body, at) => {
    const review = reviewOf(body)
    return review ? [{ ...review, at, covered: coverageOf(body, riesgo).counts }] : []
  })
  const requested = one => one.reviewer === 'pi' && rddRequestsOf(bodies.slice(0, one.at), head).some(lenses => sameLenses(lenses, one.lenses))
  // An RDD review main did not ask for on this head is not a review at all (#391): it neither counts nor blocks.
  const reviews = posted.filter(one => one.lenses === undefined || (rddAllowed && requested(one)))
  const onHead = reviews.filter(one => namesCommit(one.commit, head))
  const marks = (marker, enabled = true) => (enabled ? bodies.flatMap((body, at) => (markerValue(body, marker) === undefined ? [] : [{ at, commit: commitOf(body) }])) : [])
  const mainMarks = [...marks('Verificado por main'), ...marks('Decidido por main')]
  const mainOnHead = mainMarks.filter(mark => namesCommit(mark.commit, head))
  const sinReview = marks('Sin review', rdd)
  const sinOnHead = sinReview.filter(mark => namesCommit(mark.commit, head))

  // (a) and (b); with #377's waiver only an unsettled blocker on the head and ## Evidencia remain.
  if (waived) {
    for (const one of onHead.filter(one => !one.clean && !mainOnHead.some(mark => mark.at > one.at))) falta.push(`(a) el review de ${one.reviewer} sobre ${sha7} ${blockerReason(one)}`)
    if (!/^##\s*Evidencia\b/im.test(normalizeBody(pr.body))) falta.push('(a) reviewParaMerge: false en la base necesita ## Evidencia en el body del PR')
  } else if (implementer === undefined || !FAMILIES.agents.includes(implementer)) {
    falta.push('(a) el body del PR no tiene una línea Implementador: <agente>')
  } else {
    const unsettled = onHead.filter(one => !one.clean && !mainOnHead.some(mark => mark.at > one.at))
    for (const one of unsettled) falta.push(`(a) el review de ${one.reviewer} sobre ${sha7} ${blockerReason(one)}`)
    // pi's own RDD review counts when main asked for it (only those are in `reviews`); non-RDD reviews on a pi PR must come from a cross-family worker (#488).
    const counted = onHead.filter(one => one.clean && (one.lenses !== undefined || (implementer === 'pi' ? isCrossFamilyPiReview(config, one.reviewer) : one.reviewer !== implementer)))
    const evidence = /^##\s*Evidencia\b/im.test(normalizeBody(pr.body))
    const satisfied = counted.some(one => one.covered) || mainOnHead.length > 0 || (sinOnHead.length > 0 && evidence)
    if (!satisfied && unsettled.length === 0) {
      const latest = new Map()
      for (const one of reviews) if (one.reviewer !== implementer && !namesCommit(one.commit, head)) latest.set(one.reviewer, one.commit)
      const staleSin = sinReview.filter(mark => mark.commit && !namesCommit(mark.commit, head)).at(-1)
      if (sinOnHead.length > 0) {
        falta.push('(a) el Sin review: necesita ## Evidencia en el body del PR')
      } else if (latest.size > 0 || staleSin) {
        for (const [reviewer, commit] of latest) falta.push(`(b) el review de ${reviewer} nombra el commit ${commit.slice(0, 7)}, no el head ${sha7}`)
        if (staleSin) falta.push(`(b) el Sin review: nombra el commit ${staleSin.commit.slice(0, 7)}, no el head ${sha7}`)
      } else if (rddFallback && !rdd) {
        falta.push(`(a) falta un review RDD limpio de pi sobre ${sha7} (no hay otro agente de otra familia disponible en el roster). Corré \`orca-stack rebote ${n} --rdd risk\` (podés sumar lentes).`)
      } else {
        const suggestion = !rdd && hasConfiguredRoster ? revisarSuggestion(n, config, candidates) : ''
        falta.push(`(a) falta un review sin bloqueos sobre ${sha7} de alguien que no sea ${implementer}${rdd ? ' (o un review RDD pedido con RDD:, o un Sin review:)' : ''}${suggestion ? `. ${suggestion}` : ''}`)
        for (const one of counted) falta.push(`(a) el review de ${one.reviewer} ${coverageOf(one.body, riesgo).why}: no cuenta`)
      }
    }
  }

  // (c)
  const ci = ciOf(pr.statusCheckRollup)
  if (ci.falta) falta.push(ci.falta)

  // (d)
  if (risky !== undefined) {
    const denied = riskDeny(n, risky, { head, implementer, bodies, posted }, config, now)
    if (denied !== undefined) falta.push(`(d) ${denied}`)
  }

  // S11
  const migrations = migrationsOf(pr, files, pr.baseRefName || config.ramaBase || 'main', config, root, io, ctx)
  falta.push(...migrations.falta)

  const shown = onHead.map(one => `${one.lenses ? `${one.reviewer}(RDD:${[...one.lenses].sort().join(',')})` : one.reviewer}@${sha7}${one.clean ? '' : ':bloquea'}`)
  if (mainOnHead.length > 0) shown.push(`main@${sha7}`)
  if (sinOnHead.length > 0) shown.push(`sin-review@${sha7}`)
  if (rddAllowed) {
    const asked = bodies.flatMap((body, at) => {
      const lenses = rddRequestOf(body, head)
      return lenses && !onHead.some(one => one.lenses && one.at > at && sameLenses(one.lenses, lenses)) ? [`rdd-pedido(${lenses.join(',')})@${sha7}`] : []
    })
    shown.push(...new Set(asked))
  }
  const stale = reviews.length > 0 || mainMarks.length > 0 || sinReview.length > 0
  const review = shown.length > 0 ? shown.join(',') : stale ? 'stale' : 'missing'
  const issue = closedIssues(pr.body)[0]

  return {
    result: { pr: n, head, ok: falta.length === 0, falta, merge: typeof config.merge === 'string' ? config.merge : null },
    line: `#${n} ${issue ? `#${issue}` : '-'} ${implementer ?? '-'} head=${sha7} ci=${ci.ci} review=${review} riesgo=${risky === undefined ? 'no' : 'yes'} falta=${falta.join('; ')}`,
    fix: migrations.fixes.length > 0 ? [`Comentario para publicar en el PR #${n} (gh pr comment ${n} --body-file <archivo>), para rebotarlo con orca-stack rebote ${n}:`, reviewBody(head, migrations.fixes)] : [],
  }
}

// #430: the worktree on an open PR's head branch gets the PR linked on its Orca card and the status in-review, once: a
// card already linked to that PR gets no call. Warnings go to stderr so the --json attestation keeps its shape.
const linkCards = (prs, root, io, warn) => {
  const open = prs.filter(pr => pr.state === 'OPEN' && typeof pr.headRefName === 'string' && pr.headRefName !== '')
  if (open.length === 0) return
  let ours
  try {
    ours = repoWorktrees(root, io)
  } catch (error) {
    warn(`⚠ No pude leer los worktrees para actualizar las tarjetas en Orca: ${error.message}. Sigo.`)
    return
  }
  for (const pr of open) {
    const hit = ours.find(({ branch }) => branch === pr.headRefName)
    if (!hit || Number(hit.row.linkedPR?.number ?? hit.row.linkedPR) === pr.number) continue
    setCard(io, `path:${hit.row.path}`, ['--pr', String(pr.number), '--workspace-status', 'in-review'])
  }
}

export const estadoCommand = async (flags = {}, items = [], io = defaultIo()) => {
  const warn = io.err ?? (message => console.error(message))
  const raw = (items ?? []).map(item => String(item).trim().replace(/^#/, ''))
  if (raw.some(item => !/^\d+$/.test(item))) throw new Error(USAGE)
  const { commonDir, root } = getCommonDir(io)
  const config = loadConfig(io.home, root)
  const ctx = migrationContext(commonDir, root, io)
  let numbers = [...new Set(raw.map(item => Number(item)))]
  if (numbers.length === 0) {
    const base = config.ramaBase
    if (typeof base !== 'string' || base === '') throw new Error('Falta ramaBase en la configuración del repo.')
    const res = io.sh('gh', ['pr', 'list', '--state', 'open', '--base', base, '--json', 'number', '--limit', '100'], { cwd: root })
    const listed = res.status === 0 ? parse(res) : undefined
    if (!Array.isArray(listed)) throw new Error(`No pude listar los PRs abiertos sobre ${base} con gh pr list: ${detail(res)}`)
    numbers = listed.map(one => one.number).filter(Number.isInteger).sort((a, b) => a - b)
    if (numbers.length === 0) {
      io.out(flags.json ? '[]' : `No hay PRs abiertos sobre ${base}.`)

      return 0
    }
  }
  const now = (io.now ?? Date.now)()
  const read = []
  const states = numbers.map(n => {
    const res = io.sh('gh', ['pr', 'view', String(n), '--json', PR_VIEW_FIELDS], { cwd: root })
    const pr = res.status === 0 ? parse(res) : undefined
    if (!isPlain(pr) || typeof pr.headRefOid !== 'string') throw new Error(`No pude leer el PR #${n} con gh pr view: ${detail(res)}`)
    read.push(pr)

    return evaluate(pr, config, root, io, now, ctx)
  })
  linkCards(read, root, io, warn)
  if (flags.json) {
    // One PR named: one object (the guard's attestation); several, or every open one: an array.
    io.out(JSON.stringify(raw.length > 0 && numbers.length === 1 ? states[0].result : states.map(state => state.result)))
    for (const state of states) for (const line of state.fix) warn(line)
  } else {
    for (const state of states) for (const line of [state.line, ...state.fix]) io.out(line)
  }

  return states.every(state => state.result.ok) ? 0 : 1
}
