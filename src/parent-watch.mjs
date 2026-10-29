import { spawnSync } from 'node:child_process'
import { writeSync } from 'node:fs'
import { Worker, isMainThread, workerData } from 'node:worker_threads'

import { run, which } from './util.mjs'

const CHECK_MS = 1000

// MSYS `ps` rows: PID, PPID, PGID, WINPID. A native program a Git Bash shim `exec`s keeps the shim's MSYS pid, so
// its MSYS PPID is the bash that ran the command, the one the Monitor kills. Its Windows parent is a stub that
// outlives that bash, and the stub's own Windows parent is gone from the start, so only this row says who owns us.
const msysRows = text =>
  text.split(/\r?\n/).flatMap(line => {
    const m = /^\D*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), winpid: Number(m[4]) }] : []
  })

const msysPs = () => {
  const ps = which('ps')
  if (!ps) return ''
  const res = run(ps, [], { timeout: 5000 })

  return res.status === 0 ? res.stdout : ''
}

// The Windows pid whose death means nobody reads our output any more: under Git Bash the bash that ran us,
// otherwise our Windows parent. On POSIX the parent itself, watched through process.ppid changing.
export const parentToWatch = ({ platform = process.platform, pid = process.pid, ppid = process.ppid, psOutput = msysPs } = {}) => {
  if (platform !== 'win32') return ppid
  const rows = msysRows(psOutput())
  const me = rows.find(row => row.winpid === pid)
  const owner = me && me.ppid > 1 ? rows.find(row => row.pid === me.ppid) : undefined

  return owner?.winpid ?? ppid
}

export const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// Kills this process and the child it is still waiting on (a gh in a spawnSync), so nothing outlives the watcher. On
// Windows libuv puts every child in a job that ends with this process; POSIX has no such job, so pkill (procps) ends
// them first.
const killTree = (pid, platform) => {
  if (platform !== 'win32') spawnSync('pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore' })
  process.kill(pid, 'SIGKILL')
}

// This same file is the worker's script (see watchParent). It runs in a worker thread: the main thread blocks inside spawnSync for a whole gh call, so its timers cannot notice.
// A slow poll is never a reason to exit; only the watched parent going away is.
if (!isMainThread && workerData?.parentWatch) {
  const { self, watched, platform, label } = workerData.parentWatch
  const lost = () => (platform === 'win32' ? !alive(watched) : process.ppid !== watched)
  setInterval(() => {
    if (!lost()) return
    try {
      writeSync(2, `${label}: el proceso que me lanzó (${watched}) ya no existe; salgo.\n`)
    } catch {}
    killTree(self, platform)
  }, CHECK_MS)
}

// Starts the watch; it never keeps the process alive on its own.
export const watchParent = label => {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { parentWatch: { self: process.pid, watched: parentToWatch(), platform: process.platform, label } },
  })
  worker.unref()

  return worker
}
