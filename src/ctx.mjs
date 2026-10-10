import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { backupTarget } from './backup.mjs'
import { layout, sha256, timestamp, tilde, packageVersion } from './util.mjs'

export const emptyState = () => ({
  schema: 1,
  tool: 'orca-stack',
  version: packageVersion(),
  installedAt: new Date().toISOString(),
  files: {}, // absolute path -> { sha256, backup, existedBefore }
  dirsCreated: [],
  mods: [],
  skills: [],
  settings: null, // { file, pluginDirsAdded, createdFile, createdEnv, createdKey }
  claudeMd: null, // { file, createdFile }
  codexAgentsMd: null, // { file, createdFile }: the codex ASCII block, Windows only
  config: null, // { file, sha256 }
  pi: { packagesInstalled: [], npmGlobalInstalled: false },
  backups: [],
})

export const loadState = home => {
  const file = layout(home).state
  if (!existsSync(file)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} está dañado (no es JSON). Revisalo o borralo antes de seguir.`)
  }
}

// The effect layer: every write goes through here so --dry-run can narrate instead of act.
export const createCtx = ({ dryRun = false, force = false, home, out = console.log } = {}) => {
  const L = layout(home)
  const stamp = timestamp()
  const state = loadState(home) ?? emptyState()
  state.version = packageVersion()
  const before = JSON.stringify(state)
  const prefix = dryRun ? '[simulación] ' : ''
  const show = p => tilde(p, home)

  const ctx = {
    dryRun,
    force,
    home,
    L,
    state,
    skipped: [], // files that already existed, were not ours and were left alone
    failures: 0, // steps that printed a ✖
    say: msg => out(msg),
    act: msg => out(`${prefix}${msg}`),
    show,

    fail(msg) {
      ctx.failures += 1
      out(`  ✖ ${msg}`)
    },

    // Copies a file into ~/.orca-stack/backups/<stamp>/ before it is modified. Returns the backup path.
    backup(file) {
      if (!existsSync(file)) {
        return null
      }
      const target = backupTarget(home, stamp, file)
      ctx.act(`respaldo de ${show(file)} -> ${show(target)}`)
      if (!dryRun) {
        mkdirSync(path.dirname(target), { recursive: true })
        copyFileSync(file, target)
        state.backups.push(target)
      }

      return target
    },

    // mkdir -p remembering the topmost directory that did not exist, so remove can prune it.
    ensureDir(dir) {
      if (existsSync(dir)) {
        return
      }
      let top = dir
      while (!existsSync(path.dirname(top)) && path.dirname(top) !== top) {
        top = path.dirname(top)
      }
      if (!dryRun) {
        mkdirSync(dir, { recursive: true })
        if (!state.dirsCreated.includes(top)) {
          state.dirsCreated.push(top)
        }
      }
    },

    // Writes a file we own. status: 'created' | 'updated' | 'unchanged' | 'skipped'.
    // A file that exists, differs and is not ours is left alone unless --force.
    writeOwned(file, content, { mode, label } = {}) {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
      const hash = sha256(data)
      const exists = existsSync(file)
      const current = exists ? readFileSync(file) : null
      const prev = state.files[file]
      if (current && sha256(current) === hash) {
        // Identical: claim it (an earlier aborted run may have left it orphaned).
        if (!dryRun) {
          state.files[file] = prev
            ? { ...prev, sha256: hash }
            : { sha256: hash, backup: null, existedBefore: true }
        }

        return 'unchanged'
      }
      if (exists && !prev && !force) {
        ctx.skipped.push(file)
        out(`  ⚠ ${show(file)} ya existe y no es de orca-stack: lo dejo como está (usá --force para reemplazarlo, con respaldo)`)

        return 'skipped'
      }
      const status = exists ? 'updated' : 'created'
      ctx.act(`${exists ? 'actualizo' : 'creo'} ${label ?? show(file)}`)
      if (dryRun) {
        return status
      }
      const backup = exists ? ctx.backup(file) : null
      ctx.ensureDir(path.dirname(file))
      writeFileSync(file, data)
      if (mode) {
        chmodSync(file, mode)
      }
      state.files[file] = {
        sha256: hash,
        backup: prev ? prev.backup : backup,
        existedBefore: prev ? prev.existedBefore : exists,
      }

      return status
    },

    // Writes a text file we do not own (CLAUDE.md, settings.json): backup first, never tracked as a plain file.
    writeShared(file, content, label) {
      const exists = existsSync(file)
      ctx.act(`${exists ? 'actualizo' : 'creo'} ${label ?? show(file)}`)
      if (dryRun) {
        return { backup: null, created: !exists }
      }
      const backup = exists ? ctx.backup(file) : null
      ctx.ensureDir(path.dirname(file))
      writeFileSync(file, content)

      return { backup, created: !exists }
    },

    save() {
      if (dryRun) {
        return false
      }
      ctx.ensureDir(path.dirname(L.state))
      if (JSON.stringify(state) === before && existsSync(L.state)) {
        return false
      }
      writeFileSync(L.state, JSON.stringify(state, null, 2) + '\n')

      return true
    },
  }

  return ctx
}
