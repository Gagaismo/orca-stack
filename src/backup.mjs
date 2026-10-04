import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

// Backups never live next to the file they protect (a backup inside a skill or mod folder could be loaded
// by an agent). They go to <home>/.orca-stack/backups/<timestamp>/<path relative to home>.
export const backupTarget = (home, stamp, file) => {
  const rel = path.relative(home, file)
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  const sub = inside ? rel : path.join('_external', file.replace(/^[A-Za-z]:/, m => m[0]).replace(/[\\/:]+/g, '_'))
  const base = path.join(home, '.orca-stack', 'backups', stamp, sub)
  let candidate = base
  for (let n = 2; existsSync(candidate); n += 1) {
    candidate = `${base}.${n}`
  }

  return candidate
}

export const copyToBackup = (home, stamp, file) => {
  const target = backupTarget(home, stamp, file)
  mkdirSync(path.dirname(target), { recursive: true })
  copyFileSync(file, target)

  return target
}
