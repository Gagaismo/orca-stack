#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const parseVersion = text => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim())

  return match ? match.slice(1).map(Number) : null
}

export const compareVersions = (a, b) => {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }

  return 0
}

export const bumpPackageJson = (content, oldV, newV) => {
  const versionRegex = /("version"\s*:\s*")([^"]+)(")/
  const match = versionRegex.exec(content)
  if (!match || match[2] !== oldV) return null

  const allMatches = [...content.matchAll(/"version"\s*:\s*"[^"]+"/g)]
  if (allMatches.length !== 1) return null

  const result = content.replace(versionRegex, `$1${newV}$3`)
  const parsed = JSON.parse(result)
  if (parsed.version !== newV) return null

  return result
}

export const bumpPackageLock = (content, oldV, newV) => {
  let count = 0
  const pkgIdx = content.indexOf('"packages"')
  if (pkgIdx === -1) return null

  const beforePackages = content.slice(0, pkgIdx)
  const afterPackages = content.slice(pkgIdx)

  // 1. Root version: before "packages"
  const rootVersionRegex = /("version"\s*:\s*")([^"]+)(")/
  const rootMatch = rootVersionRegex.exec(beforePackages)
  if (!rootMatch || rootMatch[2] !== oldV) return null
  count++
  const updatedBefore = beforePackages.replace(rootVersionRegex, `$1${newV}$3`)

  // 2. packages[''].version
  const rootPkgStartMatch = /""\s*:\s*\{/.exec(afterPackages)
  if (!rootPkgStartMatch) return null

  const braceStart = rootPkgStartMatch.index + rootPkgStartMatch[0].length - 1
  let depth = 0
  let braceEnd = -1
  for (let i = braceStart; i < afterPackages.length; i++) {
    if (afterPackages[i] === '{') depth++
    else if (afterPackages[i] === '}') {
      depth--
      if (depth === 0) {
        braceEnd = i
        break
      }
    }
  }
  if (braceEnd === -1) return null

  const pkgBody = afterPackages.slice(braceStart, braceEnd + 1)
  const pkgVersionRegex = /("version"\s*:\s*")([^"]+)(")/
  const pkgMatch = pkgVersionRegex.exec(pkgBody)
  if (!pkgMatch || pkgMatch[2] !== oldV) return null
  count++

  const updatedPkgBody = pkgBody.replace(pkgVersionRegex, `$1${newV}$3`)
  const updatedAfter = afterPackages.slice(0, braceStart) + updatedPkgBody + afterPackages.slice(braceEnd + 1)

  if (count !== 2) return null
  const result = updatedBefore + updatedAfter
  const parsed = JSON.parse(result)
  if (parsed.version !== newV || parsed.packages?.['']?.version !== newV) {
    return null
  }

  return result
}

export const bumpMarkdown = (filePath, oldV, newV) => {
  const content = readFileSync(filePath, 'utf8')
  const oldTag = `v${oldV}`
  const newTag = `v${newV}`
  if (!content.includes(oldTag)) {
    throw new Error(`${filePath} does not contain any occurrences of ${oldTag}`)
  }
  const updated = content.replaceAll(oldTag, newTag)
  if (updated.includes(oldTag)) {
    throw new Error(`${filePath} still contains occurrences of ${oldTag}`)
  }
  writeFileSync(filePath, updated, 'utf8')
}

const gitCmd = (repoRoot, args) =>
  spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })

export const runRelease = (versionArg, cwd = process.cwd()) => {
  const rootRes = gitCmd(cwd, ['rev-parse', '--show-toplevel'])
  const repoRoot = rootRes.status === 0 ? path.resolve(rootRes.stdout.trim()) : path.resolve(cwd)

  // Validate version format
  if (!versionArg || !/^\d+\.\d+\.\d+$/.test(versionArg)) {
    console.error(`Refusing: invalid version format "${versionArg ?? ''}". Expected format is X.Y.Z (e.g. 0.7.2).`)

    return 1
  }

  // Check uncommitted changes before touching anything
  const statusRes = gitCmd(repoRoot, ['status', '--porcelain', '--untracked-files=all'])
  if (statusRes.status !== 0) {
    console.error('Refusing: git status failed:\n' + (statusRes.stderr || statusRes.stdout))

    return 1
  }
  if (statusRes.stdout.trim().length > 0) {
    console.error('Refusing: uncommitted changes in working tree:\n' + statusRes.stdout.trim())

    return 1
  }

  // Check current branch is main
  const branchRes = gitCmd(repoRoot, ['branch', '--show-current'])
  const currentBranch = branchRes.stdout.trim()
  if (currentBranch !== 'main') {
    console.error(`Refusing: current branch is "${currentBranch || 'detached HEAD'}", must be "main".`)

    return 1
  }

  // Fetch origin
  const fetchRes = gitCmd(repoRoot, ['fetch', 'origin'])
  if (fetchRes.status !== 0) {
    console.error('Refusing: git fetch failed; cannot prove base is current:\n' + (fetchRes.stderr || fetchRes.stdout).trim())

    return 1
  }

  // Check HEAD == origin/main
  const headRes = gitCmd(repoRoot, ['rev-parse', 'HEAD'])
  const originMainRes = gitCmd(repoRoot, ['rev-parse', 'origin/main'])
  const headRev = headRes.stdout.trim()
  const originMainRev = originMainRes.stdout.trim()
  if (originMainRes.status !== 0 || !originMainRev || headRev !== originMainRev) {
    console.error(`Refusing: HEAD (${headRev}) does not match origin/main (${originMainRev}). Release must build on main equal to origin/main.`)

    return 1
  }

  // Validate version > current package.json version
  const pkgPath = path.join(repoRoot, 'package.json')
  if (!existsSync(pkgPath)) {
    console.error('Refusing: package.json not found.')

    return 1
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (err) {
    console.error('Refusing: could not parse package.json: ' + err.message)

    return 1
  }
  const currentVersion = pkg.version
  if (compareVersions(versionArg, currentVersion) <= 0) {
    console.error(`Refusing: version ${versionArg} must be greater than ${currentVersion}.`)

    return 1
  }

  // Validate branch release-X.Y.Z and tag vX.Y.Z do not exist
  const branchLocal = gitCmd(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/release-${versionArg}`])
  const branchRemote = gitCmd(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/release-${versionArg}`])
  const tagCheck = gitCmd(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/v${versionArg}`])
  if (branchLocal.status === 0 || branchRemote.status === 0) {
    console.error(`Refusing: branch release-${versionArg} already exists.`)

    return 1
  }
  if (tagCheck.status === 0) {
    console.error(`Refusing: tag v${versionArg} already exists.`)

    return 1
  }

  // Create branch release-X.Y.Z
  const checkoutRes = gitCmd(repoRoot, ['checkout', '-b', `release-${versionArg}`])
  if (checkoutRes.status !== 0) {
    console.error(`Refusing: failed to create branch release-${versionArg}:\n` + (checkoutRes.stderr || checkoutRes.stdout))

    return 1
  }

  const abortAndRestore = (reason, tail = '') => {
    console.error(reason)
    if (tail) {
      console.error(tail)
    }

    const checkoutMainRes = gitCmd(repoRoot, ['checkout', '-f', 'main'])
    gitCmd(repoRoot, ['reset', '--hard', 'HEAD'])
    gitCmd(repoRoot, ['clean', '-fd'])
    gitCmd(repoRoot, ['branch', '-D', `release-${versionArg}`])

    const currentBranchRes = gitCmd(repoRoot, ['branch', '--show-current'])
    const statusCleanRes = gitCmd(repoRoot, ['status', '--porcelain', '--untracked-files=all'])
    const branchCheckRes = gitCmd(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/release-${versionArg}`])

    const restoredOnMain = currentBranchRes.status === 0 && currentBranchRes.stdout.trim() === 'main'
    const restoredClean = statusCleanRes.status === 0 && statusCleanRes.stdout.trim() === ''
    const branchDeleted = branchCheckRes.status !== 0
    const checkoutSucceeded = checkoutMainRes.status === 0

    if (!checkoutSucceeded || !restoredOnMain || !restoredClean || !branchDeleted) {
      console.error(
        `RESTORE INCOMPLETE: failed to fully restore the repository to clean main.\n` +
          `Manual commands to restore repository:\n` +
          `  git checkout -f main\n` +
          `  git reset --hard HEAD\n` +
          `  git clean -fd\n` +
          `  git branch -D release-${versionArg}`,
      )

      return 2
    }

    return 1
  }

  try {
    // 4. Bump package.json and package-lock.json
    const pkgContent = readFileSync(pkgPath, 'utf8')
    const updatedPkg = bumpPackageJson(pkgContent, currentVersion, versionArg)
    if (!updatedPkg) {
      return abortAndRestore(`package.json: could not find single "version": "${currentVersion}" line to bump.`)
    }
    writeFileSync(pkgPath, updatedPkg, 'utf8')

    const lockPath = path.join(repoRoot, 'package-lock.json')
    if (!existsSync(lockPath)) {
      return abortAndRestore('package-lock.json not found.')
    }
    const lockContent = readFileSync(lockPath, 'utf8')
    const updatedLock = bumpPackageLock(lockContent, currentVersion, versionArg)
    if (!updatedLock) {
      return abortAndRestore(`package-lock.json: expected exactly two occurrences of version "${currentVersion}" in root and packages[""], but could not find them.`)
    }
    writeFileSync(lockPath, updatedLock, 'utf8')

    // 5. Replace every v<old> in README.md and docs/guia-setup.md
    const readmePath = path.join(repoRoot, 'README.md')
    const guiaPath = path.join(repoRoot, 'docs', 'guia-setup.md')
    if (!existsSync(readmePath) || !existsSync(guiaPath)) {
      return abortAndRestore('README.md or docs/guia-setup.md not found.')
    }
    bumpMarkdown(readmePath, currentVersion, versionArg)
    bumpMarkdown(guiaPath, currentVersion, versionArg)

    // 6. Run node bin/orca-stack.mjs init
    const binPath = path.join(repoRoot, 'bin', 'orca-stack.mjs')
    const initRes = spawnSync(process.execPath, [binPath, 'init'], { cwd: repoRoot, encoding: 'utf8' })
    if (initRes.status !== 0) {
      return abortAndRestore('orca-stack init failed:\n' + (initRes.stderr || initRes.stdout).trim())
    }

    // 7. Run suite from .orca-stack.json
    let suiteCmd = 'npm test && npm run test:mods'
    const orcaConfigPath = path.join(repoRoot, '.orca-stack.json')
    if (existsSync(orcaConfigPath)) {
      try {
        const cfg = JSON.parse(readFileSync(orcaConfigPath, 'utf8'))
        if (cfg?.verificacion?.suite) {
          suiteCmd = cfg.verificacion.suite
        }
      } catch {}
    }
    const suiteRes = spawnSync(suiteCmd, {
      cwd: repoRoot,
      shell: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (suiteRes.status !== 0) {
      const output = (suiteRes.stdout || '') + (suiteRes.stderr || '')
      const lines = output.trim().split(/\r?\n/)
      const tail = lines.slice(-25).join('\n')
      const errorDetail = suiteRes.error ? ` (${suiteRes.error.message})` : ''

      return abortAndRestore(`Suite "${suiteCmd}" failed with exit code ${suiteRes.status}${errorDetail}. Aborting and restoring repo to main.\nTail of output:\n${tail}`)
    }

    // 8. Commit chore: release vX.Y.Z
    gitCmd(repoRoot, ['add', '-u'])
    for (const f of ['AGENTS.md', 'README.md', 'docs/guia-setup.md', 'package.json', 'package-lock.json']) {
      if (existsSync(path.join(repoRoot, f))) {
        gitCmd(repoRoot, ['add', f])
      }
    }
    const commitRes = gitCmd(repoRoot, ['commit', '-m', `chore: release v${versionArg}`])
    if (commitRes.status !== 0) {
      return abortAndRestore('git commit failed:\n' + (commitRes.stderr || commitRes.stdout).trim())
    }

    // 9. Print remaining steps for main
    console.log(`Release v${versionArg} committed on branch release-${versionArg}.\n`)
    console.log('Remaining steps for main:')
    console.log(`- Push:           git push -u origin release-${versionArg}`)
    console.log(`- PR:             gh pr create --base main --head release-${versionArg} --title "chore: release v${versionArg}"`)
    console.log(`- Merge:          Merge the PR once CI checks pass`)
    console.log(`- Tag:            git tag v${versionArg} && git push origin v${versionArg}`)
    console.log(`- GitHub release: gh release create v${versionArg} --title "v${versionArg}"`)
    console.log(`- Verify:         npx github:Gagaismo/orca-stack#v${versionArg} global`)

    return 0
  } catch (err) {
    return abortAndRestore(`Unexpected failure during release: ${err.message}`)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const code = runRelease(process.argv[2])
  process.exit(code)
}
