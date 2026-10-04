// Runs every mod's own tests with `claude plugin test` (they need the Claude Code engine).
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const probe = spawnSync('claude', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8' })
if (probe.status !== 0) {
  console.log('claude no está instalado: se omiten los tests de los mods.')
  process.exit(0)
}
let failed = 0
for (const mod of readdirSync(join(root, 'mods')).sort()) {
  const result = spawnSync('claude', ['plugin', 'test', join(root, 'mods', mod)], {
    shell: process.platform === 'win32',
    stdio: 'inherit',
  })
  if (result.status !== 0) failed += 1
}
process.exit(failed ? 1 : 0)
