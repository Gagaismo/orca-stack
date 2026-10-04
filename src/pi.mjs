import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { INSTALL_HINTS, PINNED, PI_PACKAGES } from './constants.mjs'
import { isFile, run, which } from './util.mjs'

export const piBinary = L => {
  const onPath = which('pi')
  if (onPath) {
    return onPath
  }
  for (const name of process.platform === 'win32' ? ['pi.cmd', 'pi.exe'] : ['pi']) {
    const managed = path.join(L.piAgent, 'bin', name)
    if (isFile(managed)) {
      return managed
    }
  }

  return null
}

export const piVersion = bin => {
  const result = run(bin, ['--version'], { timeout: 30_000 })
  const match = /\d+\.\d+\.\d+/.exec(result.stdout + result.stderr)

  return result.status === 0 && match ? match[0] : null
}

export const installedPackageVersion = (modulesDir, name) => {
  const file = path.join(modulesDir, name, 'package.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8')).version ?? null
  } catch {
    return null
  }
}

export const piModulesDir = L => path.join(L.piAgent, 'npm', 'node_modules')

export const npmGlobalRoot = () => {
  const npm = which('npm')
  if (!npm) {
    return null
  }
  const result = run(npm, ['root', '-g'], { timeout: 30_000 })

  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] || null : null
}

// Where the gentle-pi skills live, resolved the same way the puente-gentle mod does at runtime:
// Pi's own package dir first, then the npm-global install.
export const resolveGentleSkills = L => {
  const inPi = path.join(piModulesDir(L), 'gentle-pi', 'skills')
  if (existsSync(inPi)) {
    return { dir: inPi, source: 'Pi' }
  }
  const root = npmGlobalRoot()
  if (root) {
    const inGlobal = path.join(root, 'gentle-pi', 'skills')
    if (existsSync(inGlobal)) {
      return { dir: inGlobal, source: 'npm global' }
    }
  }

  return null
}

// The few lines of a failed npm/pi run that say why (npm prints a long cleanup trace first).
export const failureReason = result => {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  const errors = lines.filter(line => /^(npm )?error\b/i.test(line) && !/complete log/i.test(line))

  return (errors.length > 0 ? errors : lines).slice(-3).join(' | ').slice(0, 400)
}

export const printInstallHint = (ctx, key, title) => {
  ctx.say(`  ${title} no está instalado. Instalación oficial:`)
  for (const line of INSTALL_HINTS[key]) {
    ctx.say(`    ${line}`)
  }
}

// Installs pi packages through Pi's own mechanism and gentle-pi globally (for the gentle-shell bin).
export const setupPi = (ctx, { skipPi }) => {
  const L = ctx.L
  ctx.say('\nPi (Gentle Shell)')
  if (skipPi) {
    ctx.say('  omitido por --skip-pi')

    return
  }
  const bin = piBinary(L)
  if (!bin) {
    printInstallHint(ctx, 'pi', 'Pi')
    ctx.say('  Después de instalarlo, volvé a correr este comando para sumar gentle-pi y pi-claude-bridge.')

    return
  }
  const version = piVersion(bin)
  if (version && version !== PINNED.pi) {
    ctx.say(`  aviso: Pi ${version} instalado; este stack se probó con ${PINNED.pi}.`)
  }
  for (const pkg of PI_PACKAGES) {
    const have = installedPackageVersion(piModulesDir(L), pkg.name)
    if (have === pkg.version) {
      ctx.say(`  ${pkg.name}@${pkg.version} ya está instalado`)
      continue
    }
    ctx.act(`ejecuto: pi install npm:${pkg.name}@${pkg.version}${have ? ` (ya tenías la ${have}; no se va a registrar como instalado por orca-stack)` : ''}`)
    if (ctx.dryRun) {
      continue
    }
    const result = run(bin, ['install', `npm:${pkg.name}@${pkg.version}`], { timeout: 300_000 })
    if (result.status === 0) {
      // Only what was absent before this run is ours to remove later.
      if (have === null) {
        ctx.state.pi.packagesInstalled = [...new Set([...ctx.state.pi.packagesInstalled, `${pkg.name}@${pkg.version}`])]
      }
    } else {
      ctx.fail(`falló pi install npm:${pkg.name}@${pkg.version}: ${failureReason(result)}`)
    }
  }

  const npm = which('npm')
  if (!npm) {
    ctx.say('  npm no está en el PATH: no pude instalar gentle-pi global (el comando gentle-shell).')

    return
  }
  const root = npmGlobalRoot()
  const globalVersion = root ? installedPackageVersion(root, 'gentle-pi') : null
  if (globalVersion === PINNED.gentlePi) {
    ctx.say(`  gentle-pi@${PINNED.gentlePi} global ya está instalado (comando gentle-shell)`)

    return
  }
  ctx.act(`ejecuto: npm i -g gentle-pi@${PINNED.gentlePi}${globalVersion ? ` (ya tenías la ${globalVersion}; no se va a registrar como instalado por orca-stack)` : ''}`)
  if (!ctx.dryRun) {
    const result = run(npm, ['i', '-g', `gentle-pi@${PINNED.gentlePi}`], { timeout: 300_000 })
    if (result.status === 0) {
      if (globalVersion === null) {
        ctx.state.pi.npmGlobalInstalled = true
      }
    } else {
      ctx.fail(`falló npm i -g gentle-pi@${PINNED.gentlePi}: ${failureReason(result)}`)
    }
  }
}
