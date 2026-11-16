import path from 'node:path'

import { defaultIo, getRemoteOrigin, launchInWorktree, leftover, loadConfig, piProfileFor, piProfileLines, writePin } from './despacho.mjs'
import { readAsset, render } from './templates.mjs'
import { samePath } from './util.mjs'
import { markUmbrellaBaseline } from './vigilar.mjs'

// `orca-stack planificar <umbrella>` (#370): the planning session of an umbrella issue runs in its own Orca worktree
// (so it has a card) on docs/<slug>, never in main's checkout, and pi is launched there interactively: the human drives
// grill-with-docs, to-spec and to-tickets. main learns the session published its tickets from `vigilar --paraguas`.
const USAGE = 'Uso: orca-stack planificar <issue-paraguas> [--perfil-pi <nombre>] [--dry-run].'
const SLUG_MAX = 50

// The branch name of an umbrella: its title in lowercase ASCII words joined by dashes, accents dropped.
export const slugOf = title => String(title ?? '')
  .normalize('NFD')
  .replace(/\p{M}/gu, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, SLUG_MAX)
  .replace(/-+$/, '')

const ok = (res, what) => {
  if (res.status !== 0) throw new Error(`${what} falló: ${(res.stderr || res.stdout || String(res.error)).trim()}`)

  return res
}
const parseJson = (res, what) => {
  try {
    return JSON.parse(res.stdout)
  } catch {
    throw new Error(`${what} no devolvió JSON: ${(res.stderr || res.stdout).trim().split('\n')[0]}`)
  }
}
const worktreeOf = json => {
  const result = json?.result ?? json
  const tree = result?.worktree ?? result

  return { path: tree?.path ?? tree?.worktreePath, branch: typeof tree?.branch === 'string' ? tree.branch.replace(/^refs\/heads\//, '') : undefined }
}

export const renderPlanningBrief = vars => render(readAsset('stack', 'brief-planificacion.md'), vars)

export const planificarCommand = async (flags = {}, umbrella, io = defaultIo()) => {
  const dryRun = flags.dryRun === true
  const say = io.out
  const warn = io.err ?? say
  const raw = String(umbrella ?? '').trim().replace(/^#/, '')
  if (!/^\d+$/.test(raw)) throw new Error(USAGE)
  const n = String(Number(raw))

  const git = io.sh('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], { cwd: io.cwd })
  if (git.status !== 0) throw new Error('Corré este comando dentro del checkout principal de un repo git.')
  const [gitDir, commonDir, top] = git.stdout.split(/\r?\n/).map(line => line.trim())
  if (!samePath(gitDir, commonDir)) throw new Error('Esto es un worktree: corré el comando desde el checkout principal del repo (la sesión de main).')
  const root = path.resolve(top)
  const repo = path.basename(root)
  const config = loadConfig(io.home, root)
  if (config.setup !== 'completo') throw new Error(`El setup de orca-stack está pendiente en ${repo}: hacelo con la skill orca-setup antes de planificar.`)
  const base = config.ramaBase
  if (typeof base !== 'string' || base === '') throw new Error('Falta ramaBase en la configuración del repo.')

  // The umbrella is read and judged before anything changes.
  const issue = parseJson(ok(io.sh('gh', ['issue', 'view', n, '--json', 'number,title,state,body'], { cwd: root }), 'gh issue view'), 'gh issue view')
  if (String(issue.state ?? '').toUpperCase() !== 'OPEN') throw new Error(`El issue paraguas #${n} está cerrado: no planifico sobre él.`)
  const title = String(issue.title ?? '').trim()
  const slug = slugOf(title)
  if (slug === '') throw new Error(`El issue paraguas #${n} no tiene un título del que salga la rama docs/<slug>: ponele título y repetí.`)
  const wanted = `docs/${slug}`
  const name = `${repo}-planificacion-${n}`
  const briefPath = path.join(io.home, 'orca', 'briefs', `${name}.md`)
  const startRef = `origin/${base}`
  const remote = getRemoteOrigin(root, io)
  const profile = piProfileFor({ flag: flags.perfilPi, config, home: io.home, commonDir, io })
  const skills = io.gentleSkills(io.home)
  if (!skills) throw new Error('No encuentro las skills de gentle-pi (Pi ni npm global): corré `orca-stack global`.')

  // One planning session per umbrella: a worktree on the branch or with the name (a prunable one is gone), or an Orca
  // worktree linked to the umbrella, refuses a second one.
  const listed = ok(io.sh('git', ['worktree', 'list', '--porcelain'], { cwd: root }), 'git worktree list').stdout
  const entries = listed.split(/\r?\n\s*\r?\n/).filter(entry => !/^prunable\b/m.test(entry))
  const baseName = value => String(value).replace(/\\/g, '/').split('/').pop()
  if (entries.some(entry => [...entry.matchAll(/^worktree (.+)$/gm)].some(([, value]) => baseName(value) === name) || new RegExp(`^branch refs/heads/${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(entry))) {
    throw new Error(`Ya hay un worktree para la planificación de #${n} (${name} o la rama ${wanted}): revisalo con \`orca worktree ps\`.`)
  }
  const ps = io.sh('orca', ['worktree', 'ps', '--json'])
  if (ps.status === 0) {
    const live = (parseJson(ps, 'orca worktree ps').result?.worktrees ?? []).find(w => baseName(w.path ?? '') === name || (w.repo === repo && w.linkedIssue === Number(n)))
    if (live) throw new Error(`Ya hay un worktree para la planificación de #${n} en Orca: ${live.path}.`)
  } else if (!dryRun) {
    throw new Error(`Orca no contesta (orca worktree ps): ${(ps.stderr || ps.stdout).trim()}`)
  } else say('⚠ Orca no contesta: no pude comprobar si ya hay una sesión de planificación.')

  const act = (cmd, argv, opts = {}) => {
    say(`${dryRun ? '[simulación] ' : ''}${cmd} ${argv.map(a => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)

    return dryRun ? { status: 0, stdout: '', stderr: '' } : ok(io.sh(cmd, argv, opts), `${cmd} ${argv[0]}`)
  }
  if (!dryRun) {
    const fetched = io.sh('git', ['fetch', 'origin'], { cwd: root })
    if (fetched.status !== 0) throw new Error(`git fetch origin falló, no creé nada: ${(fetched.stderr || fetched.stdout || String(fetched.error)).trim()}`)
  }

  const left = { assigned: false, worktree: null, brief: null }
  try {
    const created = act('orca', ['worktree', 'create', '--name', name, '--branch', wanted, '--base-branch', startRef, '--issue', n, '--no-parent', '--json'])
    let worktree = '<worktree>'
    let branch = wanted
    if (!dryRun) {
      const tree = worktreeOf(parseJson(created, 'orca worktree create'))
      if (!tree.path) throw new Error('orca worktree create no devolvió la ruta del worktree.')
      worktree = tree.path
      left.worktree = worktree
      // Orca adds a numeric suffix to a branch name that is taken: the brief names the branch it really got.
      branch = tree.branch ?? wanted
      if (branch !== wanted) warn(`⚠ Orca creó la rama ${branch} en lugar de ${wanted} (el nombre estaba tomado).`)
    }
    say(`${dryRun ? '[simulación] ' : ''}Rama: ${branch}`)

    if (profile) for (const line of piProfileLines(profile)) say(`${dryRun ? '[simulación] ' : ''}${line}`)
    if (profile && !profile.global && !dryRun) writePin(io, worktree, commonDir, profile.name)
    const brief = renderPlanningBrief({ UMBRELLA: n, TITLE: title, REPO: repo, REMOTE_REPO: remote.ownerRepo, BRANCH: branch, BASE: base })
    say(`${dryRun ? '[simulación] ' : ''}brief -> ${briefPath}`)
    if (!dryRun) {
      io.mkdirp(path.dirname(briefPath))
      io.writeFile(briefPath, brief)
      left.brief = briefPath
      try {
        const known = markUmbrellaBaseline(n, io, warn)
        if (known.length > 0) say(`Sub-issues que #${n} ya tenía (vigilar --paraguas no los avisa): ${known.map(k => `#${k}`).join(', ')}`)
      } catch (error) {
        warn(`⚠ No pude marcar los sub-issues que #${n} ya tenía; vigilar --paraguas puede avisarlos como nuevos: ${error.message}`)
      }
    }
    await launchInWorktree({
      agent: 'pi', mode: 'ticket', worktree, briefPath, brief, session: name, config, win: io.win, home: io.home, skills,
      piModel: profile?.model, piThinking: profile?.thinking, repositoryRoot: root, io, dryRun,
      piSessionAfter: (io.now ?? Date.now)(), issue: n, interactive: true,
    })
    say(`Vigilá la publicación de los tickets con: orca-stack vigilar --paraguas ${n}`)

    return 0
  } catch (error) {
    if (!dryRun) say(leftover(left, n, base))
    throw error
  }
}
