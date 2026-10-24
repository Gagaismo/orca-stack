import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, describe, test } from 'node:test'

import { alive, parentToWatch } from '../src/parent-watch.mjs'
import { CURSOR_REL } from '../src/vigilar.mjs'
import { BIN, cleanup, tempDir } from './helpers.mjs'

const WIN = process.platform === 'win32'
const SHA = 'abc1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

// gh answers like GitHub for issue 7 with one open PR #70 whose CI is pending; with FAKE_GH_SLOW it hangs, as a gh poll
// that is still running when the Monitor stops, and records the pid vigilar spawned (on Windows the cmd.exe of gh.cmd,
// standing in for gh.exe) and its own. The slow one leaves the temp dir first: on Windows it is a grandchild of
// vigilar, outside the libuv job, so it outlives vigilar until the after hook kills it, and its cwd would keep the dir
// locked. orca always fails (no worktrees).
const FAKE_GH = `import { writeFileSync } from 'node:fs'
import os from 'node:os'
const args = process.argv.slice(2)
if (process.env.FAKE_GH_SLOW) {
  process.chdir(os.tmpdir())
  writeFileSync(process.env.FAKE_GH_SLOW, ${WIN ? '`${process.ppid} ${process.pid}`' : '`${process.pid} ${process.pid}`'})
  setTimeout(() => {}, 120000)
} else if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify([{ number: 70, state: 'OPEN', headRefName: 'b', headRefOid: '${SHA}', mergedAt: null, body: '', closingIssuesReferences: [{ number: 7 }], statusCheckRollup: [], mergeable: 'MERGEABLE' }]))
} else {
  console.log('{}')
}
`

const tool = (bin, name, script) => {
  if (WIN) {
    writeFileSync(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "%~dp0${script}" %*\r\n`)
  } else {
    writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${script}" "$@"\n`)
    chmodSync(path.join(bin, name), 0o755)
  }
}

const setup = () => {
  const dir = tempDir('vigilar-parent')
  const repo = path.join(dir, 'repo')
  const bin = path.join(dir, 'bin')
  spawnSync('git', ['init', '-q', repo])
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'fake-gh.mjs'), FAKE_GH)
  writeFileSync(path.join(bin, 'fake-orca.mjs'), 'process.exit(1)\n')
  tool(bin, 'gh', 'fake-gh.mjs')
  tool(bin, 'orca', 'fake-orca.mjs')
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  delete env.Path

  return { dir, repo, bin, env }
}

// The Monitor's stand-in: a process that runs vigilar with its stdout on a pipe, relays each event line and prints
// vigilar's pid first. Killing it is what a Monitor timeout or TaskStop does to the shell.
const PARENT = `const { spawn } = require('node:child_process')
const child = spawn(process.execPath, process.argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] })
console.log('pid ' + child.pid)
child.stdout.pipe(process.stdout)
setTimeout(() => {}, 120000)
`

const startUnderParent = (ctx, args, extraEnv = {}) => {
  const parent = spawn(process.execPath, ['-e', PARENT, BIN, 'vigilar', ...args], { cwd: ctx.repo, env: { ...ctx.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'ignore'] })
  const lines = []
  let buffer = ''
  parent.stdout.on('data', chunk => {
    buffer += chunk
    const parts = buffer.split(/\r?\n/)
    buffer = parts.pop()
    lines.push(...parts)
  })

  return { parent, lines }
}

const waitFor = async (what, check, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

const pidOf = lines => Number(lines.find(line => line.startsWith('pid '))?.slice(4))
// [the process vigilar spawned for gh, the fake gh itself], once the slow poll started.
const ghPids = file => existsSync(file) && readFileSync(file, 'utf8').split(' ').map(Number)

const dirs = []
const stray = []
after(() => {
  for (const pid of stray) if (alive(pid)) process.kill(pid, 'SIGKILL')
  for (const dir of dirs) cleanup(dir)
})

describe('vigilar ends with its parent (#281)', () => {
  test('Rule 2: when the parent dies during a slow gh poll, vigilar and its gh are gone within 5 seconds', async () => {
    const ctx = setup()
    dirs.push(ctx.dir)
    const ghPidFile = path.join(ctx.dir, 'gh.pid')
    const { parent, lines } = startUnderParent(ctx, ['7', '--cada', '1'], { FAKE_GH_SLOW: ghPidFile })
    stray.push(parent.pid)
    const vigilar = await waitFor('vigilar pid', () => pidOf(lines), 15000)
    const [gh, fake] = await waitFor('the gh poll', () => ghPids(ghPidFile), 15000)
    stray.push(vigilar, gh, fake)
    assert.ok(alive(vigilar) && alive(gh))

    parent.kill('SIGKILL')
    await waitFor('vigilar and gh to exit', () => !alive(vigilar) && !alive(gh), 5000)
  })

  test('Rule 3: after the parent dies, rearming vigilar with the same issue resumes and repeats no event', async () => {
    const ctx = setup()
    dirs.push(ctx.dir)
    const { parent, lines } = startUnderParent(ctx, ['7', '--cada', '1'])
    stray.push(parent.pid)
    const vigilar = await waitFor('vigilar pid', () => pidOf(lines), 15000)
    stray.push(vigilar)
    await waitFor('pr-abierto', () => lines.includes('pr-abierto #7 PR #70 abc1234'), 15000)
    // vigilar prints a poll's lines before it writes the cursor (a crash re-emits them rather than losing them), so the
    // parent dies only once the cursor holds #7; dying in between is that designed re-emit, not a resume.
    const cursorFile = path.join(ctx.repo, '.git', ...CURSOR_REL)
    await waitFor('the cursor', () => existsSync(cursorFile) && JSON.parse(readFileSync(cursorFile, 'utf8'))['7'], 15000)

    parent.kill('SIGKILL')
    await waitFor('vigilar to exit', () => !alive(vigilar), 5000)

    const rearmed = spawnSync(process.execPath, [BIN, 'vigilar', '7', '--una-vez'], { cwd: ctx.repo, env: ctx.env, encoding: 'utf8' })
    assert.equal(rearmed.status, 0, rearmed.stderr)
    assert.equal(rearmed.stdout, '')
  })

  test('Rule 4: a vigilar whose parent is alive keeps running through a poll slower than the check interval', async () => {
    const ctx = setup()
    dirs.push(ctx.dir)
    const ghPidFile = path.join(ctx.dir, 'gh.pid')
    const { parent, lines } = startUnderParent(ctx, ['7', '--cada', '1'], { FAKE_GH_SLOW: ghPidFile })
    stray.push(parent.pid)
    const vigilar = await waitFor('vigilar pid', () => pidOf(lines), 15000)
    const [gh, fake] = await waitFor('the gh poll', () => ghPids(ghPidFile), 15000)
    stray.push(vigilar, gh, fake)

    await new Promise(resolve => setTimeout(resolve, 6000))
    assert.ok(alive(vigilar), 'vigilar exited while its parent was alive')
    assert.ok(alive(gh), 'the slow gh poll was killed while the parent was alive')
    parent.kill('SIGKILL')
  })

  // Real `ps` rows from Git Bash on Windows (#281): the live `vigilar 11` and an orphan of `vigilar 264`.
  const PS = `      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
    20490       1   20490      67628  ?         197608 00:47:45 /usr/bin/bash
    20492   20490   20490      26676  ?         197608 00:47:46 /c/Program Files/nodejs/node
    15398   15396   15396      53668  ?         197608 20:23:41 /c/Program Files/nodejs/node
`

  test('Rule 2: under Git Bash the watched process is the bash that ran vigilar, found through its MSYS parent', () => {
    assert.equal(parentToWatch({ platform: 'win32', pid: 26676, ppid: 4584, psOutput: () => PS }), 67628)
  })

  test('Rule 2: an orphan whose MSYS parent is gone, or a vigilar not run from Git Bash, watches its Windows parent', () => {
    assert.equal(parentToWatch({ platform: 'win32', pid: 53668, ppid: 53820, psOutput: () => PS }), 53820)
    assert.equal(parentToWatch({ platform: 'win32', pid: 999, ppid: 1234, psOutput: () => '' }), 1234)
  })
})
