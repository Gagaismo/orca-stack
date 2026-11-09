// Copies shared/orca-config.ts into every mod that imports it, and the cases both sides must answer alike
// (shared/familias.json: model families and blocks; shared/perfiles-pi.json: launchable pi profiles) into the mod
// tests that run them, as a .ts module because a mod only loads code files. `--check` only verifies.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SHARED_USERS = ['puente-gentle', 'bandeja-mensajes', 'guardia-despacho', 'tablero-despacho', 'marchas', 'main-md']
export const FIXTURE_USERS = ['puente-gentle']
export const asModule = (json, source = 'familias.json') =>
  `// Generated from shared/${source} by \`npm run sync-shared\`: edit that file, not this one.\nexport default ${json.trim()}\n`
const copies = [
  ...SHARED_USERS.map(mod => [join(root, 'shared', 'orca-config.ts'), join(root, 'mods', mod, 'hooks', 'orca-config.ts')]),
  ...FIXTURE_USERS.map(mod => [join(root, 'shared', 'familias.json'), join(root, 'mods', mod, 'tests', 'familias.ts'), asModule]),
  [join(root, 'shared', 'perfiles-pi.json'), join(root, 'mods', 'guardia-despacho', 'tests', 'perfiles-pi.ts'), json => asModule(json, 'perfiles-pi.json')],
]
const check = process.argv.includes('--check')
let drift = 0
for (const [from, target, transform = text => text] of copies) {
  const source = transform(readFileSync(from, 'utf8'))
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null
  if (current === source) continue
  drift += 1
  if (check) console.error(`desactualizado: ${target}`)
  else writeFileSync(target, source)
}
if (check && drift) process.exit(1)
