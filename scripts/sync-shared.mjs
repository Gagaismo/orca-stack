// Copies shared/orca-config.ts into every mod that imports it. `--check` only verifies.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SHARED_USERS = ['puente-gentle', 'bandeja-mensajes', 'guardia-despacho', 'tablero-despacho']
const source = readFileSync(join(root, 'shared', 'orca-config.ts'), 'utf8')
const check = process.argv.includes('--check')
let drift = 0
for (const mod of SHARED_USERS) {
  const target = join(root, 'mods', mod, 'hooks', 'orca-config.ts')
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null
  if (current === source) continue
  drift += 1
  if (check) console.error(`desactualizado: ${target}`)
  else writeFileSync(target, source)
}
if (check && drift) process.exit(1)
