// Runs test/*.test.mjs with the built-in runner. Explicit file list: works the same on Node 20, 22 and later,
// and never picks up the mods' own *.test.ts files (those run with `claude plugin test`, see test-mods.mjs).
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = readdirSync(join(root, 'test'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join('test', name))
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
