import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { INSTALL_HINTS, PINNED, PI_MIN_VERSION, PI_NPM_PACKAGE, PI_PACKAGES } from './constants.mjs'
import { compareVersions } from './drift.mjs'
import { binaryVersion, isFile, run, which } from './util.mjs'

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

// Why the installed Pi cannot run the pinned gentle-pi, or null when it can (or its version is unreadable).
export const piTooOld = version =>
  version !== null && compareVersions(version, PI_MIN_VERSION) < 0
    ? `gentle-pi ${PINNED.gentlePi} necesita Pi ${PI_MIN_VERSION} o más nuevo y tenés Pi ${version}`
    : null

export const installedPackageVersion = (modulesDir, name) => {
  const file = path.join(modulesDir, name, 'package.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8')).version ?? null
  } catch {
    return null
  }
}

export const piModulesDir = L => path.join(L.piAgent, 'npm', 'node_modules')

const REMOTE_SOURCE = /^(npm:|git:|git\+|https?:|ssh:)/

// Packages Pi loads from a local checkout (the user's own fork), by package name (#362). Pi resolves a relative
// entry from the folder of the settings.json that holds it. An unreadable file or entry counts as none.
export const localPiPackages = L => {
  const found = new Map()
  let packages
  try {
    packages = JSON.parse(readFileSync(path.join(L.piAgent, 'settings.json'), 'utf8')).packages
  } catch {
    return found
  }
  for (const entry of Array.isArray(packages) ? packages : []) {
    const source = typeof entry === 'string' ? entry : entry?.source
    if (typeof source !== 'string' || REMOTE_SOURCE.test(source)) {
      continue
    }
    const dir = path.resolve(L.piAgent, source)
    try {
      const { name, version } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (typeof name === 'string' && !found.has(name)) {
        found.set(name, { dir, version: typeof version === 'string' ? version : null })
      }
    } catch {
      // Not a package: Pi loads it as a plain extension file or folder, nothing to compare.
    }
  }

  return found
}

// What global and doctor say about a local checkout: its version against the pinned one.
export const describeCheckout = (pkg, checkout) => {
  const older = checkout.version !== null && compareVersions(checkout.version, pkg.version) < 0

  return {
    label: `${pkg.name} ${checkout.version ?? '(sin versión)'}`,
    older,
    note: older ? `anterior a ${pkg.version}: actualizá tu checkout` : null,
  }
}

// The package-local Gentle AI binary of a local gentle-pi checkout (#364): a clone or a pull skips the postinstall that
// downloads it, and without it pi can neither push nor run an RDD review. Its path and install command come from
// gentle-pi's own runtime/gentle-ai-binary.mjs, so an upstream layout change does not break the check. null when Pi
// loads no local gentle-pi checkout; else { status: 'ok' | 'warn' | 'fail', detail }.
export const gentleAiBinaryCheck = async L => {
  const checkout = localPiPackages(L).get('gentle-pi')
  if (!checkout) {
    return null
  }
  let binary
  let command
  try {
    const binaryModule = await import(pathToFileURL(path.join(checkout.dir, 'runtime', 'gentle-ai-binary.mjs')).href)
    binary = binaryModule.gentleAiBinaryPath(checkout.dir)
    command = binaryModule.GENTLE_AI_INSTALL_RECOVERY_COMMAND
  } catch (error) {
    return { status: 'warn', detail: `no pude preguntarle a ${checkout.dir} dónde va su binario (${String(error?.message ?? error).split('\n')[0]})` }
  }
  if (typeof binary !== 'string' || typeof command !== 'string') {
    return { status: 'warn', detail: `${checkout.dir} no dice dónde va su binario (runtime/gentle-ai-binary.mjs sin gentleAiBinaryPath o GENTLE_AI_INSTALL_RECOVERY_COMMAND)` }
  }
  if (isFile(binary)) {
    return { status: 'ok', detail: binary }
  }

  return { status: 'fail', detail: `falta ${binary}: sin él pi no puede pushear ni correr el review RDD; instalalo con \`cd ${checkout.dir} && ${command}\`` }
}

// Folder of gentle-shell's self-contained install (gentle-shell 4.8.0 docs/bundled-install.md): %LOCALAPPDATA%\gentle-shell on
// Windows, ~/.gentle-shell elsewhere. Under ORCA_STACK_HOME the real LOCALAPPDATA is never read, as in orcaDataDir.
export const bundledShellDir = L =>
  process.platform === 'win32'
    ? path.join((!process.env.ORCA_STACK_HOME && process.env.LOCALAPPDATA) || path.join(L.home, 'AppData', 'Local'), 'gentle-shell')
    : path.join(L.home, '.gentle-shell')

// `current` names the installed version as `<gentle-shell>-<pi>`, e.g. `4.8.0-1.5.2`: {shell, pi}, or null for any other text.
export const parseBundledCurrent = text => {
  const match = /^(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)$/.exec(String(text ?? '').trim())

  return match ? { shell: match[1], pi: match[2] } : null
}

// The self-contained install: null when its `current` is absent, else { dir, file, shell, pi } with shell null when
// `current` is unreadable. `current` is a text file on Windows and a symlink to versions/<id> elsewhere. Never throws.
export const readBundledShell = L => {
  const dir = bundledShellDir(L)
  const file = path.join(dir, 'current')
  let text
  try {
    text = lstatSync(file).isSymbolicLink() ? path.basename(readlinkSync(file)) : readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return null
    }
    text = ''
  }
  const parsed = parseBundledCurrent(text)

  return { dir, file, shell: parsed?.shell ?? null, pi: parsed?.pi ?? null }
}

export const npmGlobalRoot = () => {
  const npm = which('npm')
  if (!npm) {
    return null
  }
  const result = run(npm, ['root', '-g'], { timeout: 30_000 })

  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] || null : null
}

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

const warnNewer = (ctx, version) => {
  if (version && version !== PINNED.pi) {
    ctx.say(`  aviso: Pi ${version} instalado; este stack se probó con ${PINNED.pi}.`)
  }
}

// A Pi older than PINNED.pi is updated with `pi update --self`, which only goes to the latest Pi, so any version at or
// above the pin passes; a newer one is never downgraded (#304 rules 2a and 2c). False when Pi is still too old.
const pinnedPi = (ctx, bin) => {
  const version = binaryVersion(bin)
  if (version === null || compareVersions(version, PINNED.pi) >= 0) {
    warnNewer(ctx, version)

    return true
  }
  ctx.act('ejecuto: pi update --self')
  if (ctx.dryRun) {
    return true
  }
  const result = run(bin, ['update', '--self'], { timeout: 300_000 })
  const updated = binaryVersion(bin)
  if (updated !== null && compareVersions(updated, PINNED.pi) >= 0) {
    warnNewer(ctx, updated)

    return true
  }
  const why = piTooOld(updated) ?? `Pi ${updated ?? version} sigue siendo anterior a ${PINNED.pi} después de pi update --self`
  ctx.fail(`${why}${result.status === 0 ? '' : ` (${failureReason(result)})`}: no instalo los paquetes de Pi. Actualizá Pi con el instalador oficial:`)
  for (const line of INSTALL_HINTS.pi) {
    ctx.say(`    ${line}`)
  }
  ctx.say('  Después de actualizarlo, volvé a correr este comando.')

  return false
}

// A missing Pi is installed at PINNED.pi with npm, the exact version instead of the remote install script (#304 rule 2b).
// Returns the Pi binary (just 'pi' under --dry-run), or null when it could not.
const installPi = ctx => {
  const npm = which('npm')
  if (!npm) {
    printInstallHint(ctx, 'pi', 'Pi')
    ctx.say('  Después de instalarlo, volvé a correr este comando para sumar gentle-pi y pi-claude-bridge.')

    return null
  }
  const spec = `${PI_NPM_PACKAGE}@${PINNED.pi}`
  ctx.act(`ejecuto: npm install -g --ignore-scripts ${spec}`)
  if (ctx.dryRun) {
    return 'pi'
  }
  const result = run(npm, ['install', '-g', '--ignore-scripts', spec], { timeout: 300_000 })
  if (result.status !== 0) {
    ctx.fail(`falló npm install -g ${spec}: ${failureReason(result)}`)

    return null
  }
  // Absent before this run, so it is ours to remove later.
  ctx.state.pi.piInstalled = true
  const bin = piBinary(ctx.L)
  if (!bin) {
    ctx.fail(`npm instaló ${spec}, pero pi no está en el PATH: sumá la carpeta de \`npm prefix -g\` al PATH y volvé a correr este comando.`)
  }

  return bin
}

// Installs Pi when it is missing or older than the pin, its packages through Pi's own mechanism and gentle-pi globally
// (for the gentle-shell bin), unless gentle-shell's self-contained install provides that bin (#359).
export const setupPi = (ctx, { skipPi }) => {
  const L = ctx.L
  ctx.say('\nPi (Gentle Shell)')
  if (skipPi) {
    ctx.say('  omitido por --skip-pi')

    return
  }
  const found = piBinary(L)
  const bin = found ? (pinnedPi(ctx, found) ? found : null) : installPi(ctx)
  if (!bin) {
    return
  }
  const local = localPiPackages(L)
  for (const pkg of PI_PACKAGES) {
    const checkout = local.get(pkg.name)
    if (checkout) {
      // The user's own checkout of the package: installing the npm one would load both (#362).
      const { label, note } = describeCheckout(pkg, checkout)
      ctx.say(`  ${label}: uso tu checkout local en ${checkout.dir}${note ? ` (${note})` : ''}`)
      continue
    }
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

  const bundled = readBundledShell(L)
  if (bundled?.shell) {
    if (compareVersions(bundled.shell, PINNED.gentlePi) >= 0) {
      ctx.say(`  encontré gentle-shell ${bundled.shell} autocontenido en ${bundled.dir}: no instalo gentle-pi global con npm`)
    } else {
      ctx.fail(`gentle-shell ${bundled.shell} autocontenido es anterior a ${PINNED.gentlePi}: ejecutá gentle-shell upgrade`)
    }

    return
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
