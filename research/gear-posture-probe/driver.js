// usage: node driver.js <label> <new|resume:ID> <script>
// script lines: a prompt, or "!write <file> <text>" run before the next prompt.
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const SP = path.dirname(process.argv[1])
const D = path.join(SP, 'gear-probe-data')
const [label, how, scriptFile] = process.argv.slice(2)
const lines = fs.readFileSync(scriptFile, 'utf8').split('\n').filter(Boolean)
const args = ['-p', '--plugin-dir', path.join(SP, 'gear-probe'), '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
if (how.startsWith('resume:')) args.push('--resume', how.slice(7))
const rd = f => { try { return fs.readFileSync(path.join(D, f), 'utf8') } catch { return '' } }
fs.appendFileSync(path.join(D, 'log.jsonl'), JSON.stringify({ t: Date.now(), ev: 'run', label, how, mode: rd('mode.txt'), gear: rd('gear.txt') }) + '\n')
const child = spawn('claude', args, { cwd: D, shell: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
const out = fs.createWriteStream(path.join(D, `out-${label}.jsonl`))
child.stderr.pipe(fs.createWriteStream(path.join(D, `err-${label}.txt`)))
let i = 0
function next() {
  while (i < lines.length && lines[i].startsWith('!write ')) {
    const [, f, ...rest] = lines[i].split(' ')
    fs.writeFileSync(path.join(D, f), rest.join(' '))
    fs.appendFileSync(path.join(D, 'log.jsonl'), JSON.stringify({ t: Date.now(), ev: 'driver.write', f, text: rest.join(' ') }) + '\n')
    i++
  }
  if (i >= lines.length) { child.stdin.end(); return }
  const text = lines[i++]
  fs.appendFileSync(path.join(D, 'log.jsonl'), JSON.stringify({ t: Date.now(), ev: 'driver.send', text: text.slice(0, 80) }) + '\n')
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
}
let buf = ''
child.stdout.on('data', d => {
  out.write(d)
  buf += d
  let k
  while ((k = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, k); buf = buf.slice(k + 1)
    let o; try { o = JSON.parse(l) } catch { continue }
    if (o.type === 'result') {
      console.log(JSON.stringify({ sid: o.session_id, result: String(o.result).replace(/\s+/g, ' ').slice(0, 240) }))
      setTimeout(next, 1500)
    }
  }
})
child.on('exit', c => console.log('exit=' + c))
next()
