import path from 'node:path'

import { isPending, isStatus, latestChecks } from './checks.mjs'
import { getCommonDir } from './consultas.mjs'
import { FAMILIES, blockOf, defaultIo, familyOf, loadConfig } from './despacho.mjs'
import { commitOf, markerLines, markerValue, namesCommit, normalizeBody } from './marcas.mjs'
import { closedIssues } from './vigilar.mjs'

// `orca-stack estado`: MAIN.md step 7 on the current head of each PR, read once (S1, #366). Its `--json` output is the
// attestation Gentle Shell's merge guard reads: keep its shape stable.
const USAGE = 'Uso: orca-stack estado [<pr>...] [--json]'
export const PR_VIEW_FIELDS = 'number,headRefOid,body,comments,reviews,files,statusCheckRollup,baseRefName,mergeable,state'
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

// shortcut: everything from here to riskDeny mirrors mods/puente-gentle/hooks/puente.ts (globToRegExp, riskyFile,
// implementerOf, prFacts, reviewsOf, rddRequestOf, rddBudgetStopped, riskDeny) because the CLI cannot import the TypeScript mod. The two
// copies must decide the same; the only additions here are the BOM-tolerant marker reading (#365) and S12's coverage.

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

  return { reviewer: named[1].toLowerCase(), commit, clean: verdict?.toLowerCase() === 'nada', lenses, body }
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
// main-autonomo S2: pi's `Consulta: pi` comment with a line `RDD fuera de presupuesto: <sha> (<stop reason>)` naming this
// head, posted after main's `RDD: <sha> (…)` request for it. A body that is a review is never this comment.
const budgetStopOf = (body, head) => {
  const lines = markerLines(body)
  if (lines.some(line => /^Revisor:/i.test(line) || /^##\s*BLOQUEA\b/i.test(line))) return false
  if (!/^Consulta:\s*pi\b/i.test(lines.find(line => line !== '') ?? '')) return false

  return lines.some(line => namesCommit(/^RDD fuera de presupuesto:\s*`?([0-9a-f]{7,40})`?\s*\([^()]+\)$/i.exec(line.trim())?.[1], head))
}
const rddBudgetStopped = (bodies, head) => bodies.some((body, at) => budgetStopOf(body, head) && rddRequestsOf(bodies.slice(0, at), head).length > 0)
const rddMissing = (n, sha) =>
  `falta un review RDD limpio de pi con la lente risk sobre el commit ${sha} ` +
  'o, si el RDD no entró en el presupuesto, dos reviews limpios de dos familias distintas de la de pi; eso último cuenta solo con un comentario "Consulta: pi" ' +
  `con la línea "RDD fuera de presupuesto: ${sha} (<motivo>)" publicado después de tu pedido RDD: sobre ese commit, y sin él los reviews de otras familias no lo reemplazan. ` +
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

// Why a PR touching a riesgo path cannot merge yet, or undefined (puente.ts riskDeny, over the same facts). A review
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
  const rdd = facts.implementer === 'pi' && config.agentes?.pi?.review === 'rdd'
  const requested = one => one.reviewer === 'pi' && rddRequestsOf(facts.bodies.slice(0, one.at), facts.head).some(lenses => sameLenses(lenses, one.lenses))
  const posted = facts.posted.filter(one => namesCommit(one.commit, facts.head))
  const reviews = posted.filter(one => one.lenses === undefined || (rdd && requested(one)))
  const blocked = reviews.find(review => !review.clean)
  if (blocked !== undefined) {
    return (
      `${prefix} y el review de ${blocked.reviewer} sobre el commit ${sha} tiene bloqueos. ` +
      'En una ruta de riesgo un bloqueo no se salda con "Decidido por main": corregilo y pedí un review nuevo, o pasale la decisión al humano.'
    )
  }
  const counting = reviews.filter(review => review.covered)
  const reviewers = [...new Set(counting.filter(review => review.lenses === undefined).map(review => review.reviewer))]
  const rddReviews = counting.filter(review => review.lenses !== undefined)
  if (rddReviews.some(review => review.lenses.includes('risk'))) return undefined
  if (rdd && !rddBudgetStopped(facts.bodies, facts.head)) {
    const unrequested = posted.some(one => one.reviewer === 'pi' && one.lenses !== undefined && !requested(one))
      ? ' Un review RDD de pi que main no pidió antes, con esas lentes y sobre ese commit (el comentario `RDD: <sha> (<lentes>)` que publica `orca-stack rebote --rdd`), no cuenta.'
      : ''
    const noRisk = rddReviews.length > 0 ? ' El review RDD de pi sobre ese commit no cuenta: no tiene la lente risk.' : ''
    const sinReview = facts.bodies.some(body => /^Sin review:/i.test(normalizeBody(body))) ? ' Un comentario "Sin review:" no cuenta en una ruta de riesgo.' : ''

    return `${prefix} y lo escribió pi en modo RDD: ${rddMissing(n, sha)}${noRisk}${unrequested}${sinReview}`
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
    if (!agents.includes(reviewer)) skipped.push(`${reviewer}: no es un agente del stack`)
    else if (family === undefined && model === undefined) skipped.push(`${reviewer}: no tiene modelo para revisar en agentes.modelos, así que no sé su familia`)
    else if (family === undefined) skipped.push(`${reviewer}: su modelo ${model} no tiene una familia reconocida (agregá su patrón en FAMILIES)`)
    else if (family !== own) covered.add(family)
  }
  if (covered.size >= 2) return undefined

  const usa = config.agentes?.usa ?? []
  const ask = config.agentes?.preguntarAntes ?? []
  const options = new Map()
  for (const agent of agents) {
    const { family } = familyOf(config, agent, 'review')
    if (usa.includes(agent) && blockOf(config, agent, now) === undefined && family !== undefined && family !== own && !covered.has(family)) {
      const current = options.get(family)
      if (current === undefined || (ask.includes(current) && !ask.includes(agent))) options.set(family, agent)
    }
  }
  const have = covered.size === 0 ? 'Hay 0' : `Hay 1 (${[...covered].join(', ')})`
  const notCounted = skipped.length === 0 ? '' : ` No cuento ${skipped.join('; ')}.`
  const missing = 2 - covered.size
  const picks = [...options.values()].slice(0, missing)
  const codexBlocked = usa.includes('codex') && blockOf(config, 'codex', now) !== undefined
  const next =
    picks.length < missing
      ? codexBlocked
        ? ' Esperá a que codex vuelva.'
        : ' Con los agentes disponibles (agentes.usa, sin bloqueos) no alcanzan las familias: decidilo con el humano.'
      : ` Corré ${picks.map(agent => `\`orca-stack revisar ${n} ${agent}\``).join(' y ')}.` +
        picks.filter(agent => ask.includes(agent)).map(agent => ` ${agent} está en preguntarAntes: pedile el OK al humano y agregá --confirmado.`).join('')

  return (
    `${prefix} y lo escribió pi: faltan reviews limpios sobre el commit ${sha} de dos familias de modelo distintas ` +
    `que no sean la de pi (${own ?? '?'}). ${have}.${notCounted}${next}`
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

// The folder a migrations glob lists, up to its first wildcard segment.
const globDir = glob => {
  const fixed = []
  for (const segment of glob.split('/')) {
    if (/[*?[]/.test(segment)) break
    fixed.push(segment)
  }

  return fixed.join('/') || '.'
}

// S11: every migration the PR adds (matches `migraciones.glob` and is not on origin/<base>) must have a number above the
// highest one on origin/<base>; goose rejects them by merge order.
const migrationsOf = (pr, files, base, config, root, io) => {
  const spec = config.migraciones
  if (!isPlain(spec) || typeof spec.glob !== 'string' || typeof spec.numero !== 'string') return { falta: [], fixes: [] }
  const pattern = globToRegExp(spec.glob)
  const ours = files.filter(file => pattern.test(file))
  if (ours.length === 0) return { falta: [], fixes: [] }
  let numero
  try {
    numero = new RegExp(spec.numero)
  } catch {
    return { falta: [`migraciones.numero no es una expresión regular válida: ${spec.numero}`], fixes: [] }
  }
  const fetched = io.sh('git', ['fetch', 'origin', base], { cwd: root })
  const listed = fetched.status === 0 ? io.sh('git', ['ls-tree', '-r', '--name-only', `origin/${base}`, '--', globDir(spec.glob)], { cwd: root }) : fetched
  if (listed.status !== 0) return { falta: [`no pude leer las migraciones de origin/${base}: ${detail(listed)}`], fixes: [] }
  const onBase = listed.stdout.split(/\r?\n/).map(line => line.trim()).filter(file => file && pattern.test(file))
  const numberOf = file => numero.exec(path.posix.basename(file))?.[1]
  const numbers = onBase.map(numberOf).filter(n => n !== undefined && /^\d+$/.test(n)).map(Number)
  if (numbers.length === 0) return { falta: [], fixes: [] }
  const max = Math.max(...numbers)
  const falta = []
  const fixes = []
  let next = max
  for (const file of ours.filter(one => !onBase.includes(one)).sort()) {
    const raw = numberOf(file)
    if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) > max) continue
    next += 1
    const item = `migración ${file} (${Number(raw)}) no es mayor que ${max} en ${base}`
    falta.push(item)
    fixes.push(`${item}: renumerala a ${String(next).padStart(raw.length, '0')} (renombrá el archivo y lo que lo nombre) para que corra después de las de ${base}.`)
  }

  return { falta, fixes }
}

const reviewBody = (head, fixes) =>
  `Revisor: main (migraciones)\nCommit: ${head}\n\n## BLOQUEA\n${fixes.map((fix, i) => `${i + 1}. ${fix}`).join('\n')}\n\n## SUGERENCIAS\nnada`

// One PR against MAIN.md step 7 on its current head.
const evaluate = (pr, config, root, io, now) => {
  const n = pr.number
  const head = String(pr.headRefOid ?? '').toLowerCase()
  const sha7 = head.slice(0, 7)
  const falta = []
  if (pr.state !== 'OPEN') falta.push(pr.state === 'MERGED' ? 'el PR está mergeado' : 'el PR está cerrado')
  else if (String(pr.mergeable ?? '').toUpperCase() === 'CONFLICTING') falta.push('el PR está en conflicto con la base')

  const implementer = implementerOf(pr.body)
  const rdd = implementer === 'pi' && config.agentes?.pi?.review === 'rdd'
  const riesgo = Array.isArray(config.riesgo) ? config.riesgo : []
  const files = (pr.files ?? []).map(file => file?.path).filter(file => typeof file === 'string')
  const risky = riskyFile(files, riesgo)
  const bodies = bodiesOf(pr)
  const posted = bodies.flatMap((body, at) => {
    const review = reviewOf(body)
    return review ? [{ ...review, at, covered: coverageOf(body, riesgo).counts }] : []
  })
  const requested = one => one.reviewer === 'pi' && rddRequestsOf(bodies.slice(0, one.at), head).some(lenses => sameLenses(lenses, one.lenses))
  // An RDD review main did not ask for on this head is not a review at all (puente.ts): it neither counts nor blocks.
  const reviews = posted.filter(one => one.lenses === undefined || (rdd && requested(one)))
  const onHead = reviews.filter(one => namesCommit(one.commit, head))
  const marks = (marker, enabled = true) => (enabled ? bodies.flatMap((body, at) => (markerValue(body, marker) === undefined ? [] : [{ at, commit: commitOf(body) }])) : [])
  const mainMarks = [...marks('Verificado por main'), ...marks('Decidido por main')]
  const mainOnHead = mainMarks.filter(mark => namesCommit(mark.commit, head))
  const sinReview = marks('Sin review', rdd)
  const sinOnHead = sinReview.filter(mark => namesCommit(mark.commit, head))

  // (a) and (b)
  if (implementer === undefined || !FAMILIES.agents.includes(implementer)) {
    falta.push('(a) el body del PR no tiene una línea Implementador: <agente>')
  } else {
    const unsettled = onHead.filter(one => !one.clean && !mainOnHead.some(mark => mark.at > one.at))
    for (const one of unsettled) falta.push(`(a) el review de ${one.reviewer} sobre ${sha7} tiene bloqueos`)
    // pi's own RDD review counts when main asked for it (only those are in `reviews`).
    const counted = onHead.filter(one => one.clean && (one.reviewer !== implementer || one.lenses !== undefined))
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
      } else {
        falta.push(`(a) falta un review sin bloqueos sobre ${sha7} de alguien que no sea ${implementer}${rdd ? ' (o un review RDD pedido con RDD:, o un Sin review:)' : ''}`)
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
  const migrations = migrationsOf(pr, files, pr.baseRefName || config.ramaBase || 'main', config, root, io)
  falta.push(...migrations.falta)

  const shown = onHead.map(one => `${one.lenses ? `${one.reviewer}(RDD:${[...one.lenses].sort().join(',')})` : one.reviewer}@${sha7}${one.clean ? '' : ':bloquea'}`)
  if (mainOnHead.length > 0) shown.push(`main@${sha7}`)
  if (sinOnHead.length > 0) shown.push(`sin-review@${sha7}`)
  if (rdd) {
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

export const estadoCommand = async (flags = {}, items = [], io = defaultIo()) => {
  const warn = io.err ?? (message => console.error(message))
  const raw = (items ?? []).map(item => String(item).trim().replace(/^#/, ''))
  if (raw.some(item => !/^\d+$/.test(item))) throw new Error(USAGE)
  const { root } = getCommonDir(io)
  const config = loadConfig(io.home, root)
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
  const states = numbers.map(n => {
    const res = io.sh('gh', ['pr', 'view', String(n), '--json', PR_VIEW_FIELDS], { cwd: root })
    const pr = res.status === 0 ? parse(res) : undefined
    if (!isPlain(pr) || typeof pr.headRefOid !== 'string') throw new Error(`No pude leer el PR #${n} con gh pr view: ${detail(res)}`)

    return evaluate(pr, config, root, io, now)
  })
  if (flags.json) {
    // One PR named: one object (the guard's attestation); several, or every open one: an array.
    io.out(JSON.stringify(raw.length > 0 && numbers.length === 1 ? states[0].result : states.map(state => state.result)))
    for (const state of states) for (const line of state.fix) warn(line)
  } else {
    for (const state of states) for (const line of [state.line, ...state.fix]) io.out(line)
  }

  return states.every(state => state.result.ok) ? 0 : 1
}
