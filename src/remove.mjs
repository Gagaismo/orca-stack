import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { createCtx, loadState } from './ctx.mjs'
import { removeBlock } from './marker.mjs'
import { piBinary } from './pi.mjs'
import { parseSettings, removePluginDirs, stringifySettings } from './settings.mjs'
import { homeDir, run, sha256, which } from './util.mjs'

// Removes empty directories below (and including) dir. Returns true when dir is gone.
const pruneEmpty = (dir, dryRun) => {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return false
  }
  let empty = true
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory() && pruneEmpty(full, dryRun)) {
      continue
    }
    empty = false
  }
  if (empty && !dryRun) {
    rmdirSync(dir)
  }

  return empty
}

export const removeCommand = async flags => {
  const home = homeDir()
  const state = loadState(home)
  if (!state) {
    console.log(`No encontré ${path.join(home, '.orca-stack', 'state.json')}: no hay nada que deshacer.`)

    return 0
  }
  const ctx = createCtx({ dryRun: flags.dryRun, home })
  const { dryRun, show } = ctx
  const st = ctx.state
  ctx.say(`orca-stack remove${dryRun ? ' (simulación: no se borra nada)' : ''}\nOrigen: ${home}\n`)

  // 1. Files we installed.
  let removed = 0
  for (const [file, entry] of Object.entries(st.files)) {
    if (st.config && file === st.config.file) {
      continue // handled below: kept when the user edited it
    }
    if (!existsSync(file)) {
      delete st.files[file]
      continue
    }
    const current = sha256(readFileSync(file))
    if (current !== entry.sha256) {
      ctx.backup(file)
    }
    if (entry.existedBefore && entry.backup && existsSync(entry.backup)) {
      ctx.act(`restauro ${show(file)} desde ${show(entry.backup)}`)
      if (!dryRun) {
        writeBack(file, entry.backup)
      }
    } else {
      ctx.act(`borro ${show(file)}`)
      if (!dryRun) {
        unlinkSync(file)
      }
    }
    removed += 1
    if (!dryRun) {
      delete st.files[file]
    }
  }

  // 2. Generated folders the engine wrote inside the mods, then empty dirs we created.
  for (const name of st.mods) {
    const generated = path.join(ctx.L.modsDir, name, '.claude-plugin', 'types')
    if (existsSync(generated)) {
      ctx.act(`borro ${show(generated)} (lo genera Claude Code al cargar el mod)`)
      if (!dryRun) {
        rmSync(generated, { recursive: true, force: true })
      }
    }
  }

  // 3. CLAUDE_CODE_PLUGIN_DIRS entries we added.
  if (st.settings && existsSync(st.settings.file)) {
    const file = st.settings.file
    const original = readFileSync(file, 'utf8')
    const data = parseSettings(original, file)
    const current = data.env?.CLAUDE_CODE_PLUGIN_DIRS
    if (typeof current === 'string') {
      const { value, removed: count } = removePluginDirs(current, st.settings.pluginDirsAdded)
      if (count > 0) {
        if (value === '' && st.settings.createdKey) {
          delete data.env.CLAUDE_CODE_PLUGIN_DIRS
        } else {
          data.env.CLAUDE_CODE_PLUGIN_DIRS = value
        }
        if (st.settings.createdEnv && Object.keys(data.env).length === 0) {
          delete data.env
        }
        ctx.backup(file)
        ctx.act(`quito ${count} entradas de CLAUDE_CODE_PLUGIN_DIRS en ${show(file)}`)
        if (!dryRun) {
          if (st.settings.createdFile && Object.keys(data).length === 0) {
            rmSync(file)
          } else {
            writeBack(file, null, stringifySettings(data, original))
          }
        }
      }
    }
  }

  // 4. Marker block in the global CLAUDE.md.
  if (st.claudeMd && existsSync(st.claudeMd.file)) {
    const file = st.claudeMd.file
    const { text, found } = removeBlock(readFileSync(file, 'utf8'))
    if (found) {
      ctx.backup(file)
      if (text.trim() === '' && st.claudeMd.createdFile) {
        ctx.act(`borro ${show(file)} (lo había creado este instalador)`)
        if (!dryRun) {
          rmSync(file)
        }
      } else {
        ctx.act(`quito el bloque orca-stack de ${show(file)}`)
        if (!dryRun) {
          writeBack(file, null, text)
        }
      }
    }
  }

  // 5. Personal config, only when it is still the file we wrote.
  if (st.config && existsSync(st.config.file)) {
    if (sha256(readFileSync(st.config.file)) === st.config.sha256) {
      ctx.act(`borro ${show(st.config.file)}`)
      if (!dryRun) {
        rmSync(st.config.file)
      }
    } else {
      ctx.say(`  conservo ${show(st.config.file)}: lo editaste después de instalarlo`)
    }
  }

  // 6. Pi packages, only on request: the user may use them outside this stack.
  if (flags.withPi) {
    const bin = piBinary(ctx.L)
    for (const pkg of st.pi.packagesInstalled) {
      const [name] = pkg.split(/@(?=[^@]*$)/)
      ctx.act(`pi remove npm:${name}`)
      if (!dryRun && bin) {
        run(bin, ['remove', `npm:${name}`], { timeout: 120_000 })
      }
    }
    if (st.pi.npmGlobalInstalled && which('npm')) {
      ctx.act('npm rm -g gentle-pi')
      if (!dryRun) {
        run(which('npm'), ['rm', '-g', 'gentle-pi'], { timeout: 120_000 })
      }
    }
  } else if (st.pi.packagesInstalled.length > 0 || st.pi.npmGlobalInstalled) {
    ctx.say('  los paquetes de Pi y gentle-pi global se conservan (usá --with-pi para sacarlos)')
  }

  // 7. Empty directories this installer created (after everything else is gone).
  for (const dir of [...st.dirsCreated].sort((a, b) => b.length - a.length)) {
    pruneEmpty(dir, dryRun)
  }
  for (const name of st.mods) {
    pruneEmpty(path.join(ctx.L.modsDir, name), dryRun)
  }
  for (const root of [ctx.L.claudeSkills, ctx.L.agentsSkills]) {
    for (const name of st.skills) {
      pruneEmpty(path.join(root, name), dryRun)
    }
  }

  // 8. The state file itself.
  if (!dryRun) {
    rmSync(ctx.L.state)
    pruneEmpty(ctx.L.ownDir, false)
  } else {
    ctx.act(`borro ${show(ctx.L.state)}`)
  }
  ctx.say(`\n${dryRun ? 'Se desharían' : 'Deshechos'} ${removed} archivos. Los respaldos *.bak-orca-stack-* se conservan.`)

  return 0
}

// Restores a backup over file, or writes text.
function writeBack(file, backup, text) {
  if (backup) {
    copyFileSync(backup, file)
  } else {
    writeFileSync(file, text)
  }
}
