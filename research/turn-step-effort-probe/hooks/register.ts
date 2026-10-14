import type { Register } from 'claude-code'

const DIR = 'C:/Users/lautaro/AppData/Local/Temp/claude/C--Users-lautaro-Documents-orca-stack/1e037c30-c7fa-43e2-8e84-c5c0681db159/scratchpad/probe'
const LOG = DIR + '/log.jsonl'
const FORCE = DIR + '/force.txt' // effort to force on main, empty = none
const CMD = DIR + '/cmd.txt' // args for $.command.run("effort") at session.start

async function log($: any, row: object) {
  const old = (await $.fs.exists(LOG)) ? await $.fs.read(LOG) : ''
  await $.fs.write(LOG, old + JSON.stringify({ t: Date.now(), ...row }) + '\n')
}

async function readOpt($: any, p: string) {
  return (await $.fs.exists(p)) ? String(await $.fs.read(p)).trim() : ''
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const rows = await $.config.list()
    await log($, { ev: 'config', rows: rows.filter((x: any) => /effort|ultra|think|model/i.test(JSON.stringify(x))) })
    const cmd = await readOpt($, CMD)
    if (cmd) {
      try {
        const res = await $.command.run({ command: 'effort', args: cmd })
        await log($, { ev: 'command.run', args: cmd, res })
      } catch (err) {
        await log($, { ev: 'command.run', args: cmd, err: String(err) })
      }
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const force = await readOpt($, FORCE)
    const send = !e.agentId && force ? { ...e, effort: force as any } : e
    const r = yield* next(send)
    await log($, { ev: 'step', agentId: e.agentId ?? null, index: e.index, model: e.model, seenEffort: e.effort ?? null, sentEffort: send.effort ?? null, usage: r?.usage ?? null })
    return r
  })
}
