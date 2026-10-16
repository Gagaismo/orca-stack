// Runs test/*.test.mjs with the built-in runner. Explicit file list: works the same on Node 20, 22 and later,
// and never picks up the mods' own *.test.ts files (those run with `claude plugin test`, see test-mods.mjs).
import { readdirSync, openSync, closeSync, readFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function extractFailureBlocks(logContent) {
  if (!logContent) return ''
  const match = logContent.match(/(?:✖\s+)?failing tests:[\s\S]+/i)
  if (match) return match[0].trimEnd()

  const lines = logContent.split(/\r?\n/)
  const failureLines = []
  let inFailure = false
  for (const line of lines) {
    if (line.includes('✖')) {
      inFailure = true
      failureLines.push(line)
    } else if (inFailure) {
      if (/^\s*ℹ\s+tests\b/.test(line)) {
        inFailure = false
      } else if (/^\s*(?:✔|▶)/.test(line)) {
        inFailure = false
      } else {
        failureLines.push(line)
      }
    }
  }
  return failureLines.join('\n').trimEnd()
}

export async function runTests({ root = join(dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
  const logPath = join(root, 'npm-test.log')

  try {
    const fd = openSync(logPath, 'w')
    closeSync(fd)
  } catch (error) {
    process.stderr.write(`No se puede escribir en ${logPath}: ${error.message}\n`)
    return 1
  }

  const files = readdirSync(join(root, 'test'))
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => join('test', name))

  const args = [
    '--test',
    '--test-reporter=dot',
    '--test-reporter-destination=stdout',
    '--test-reporter=spec',
    `--test-reporter-destination=${logPath}`,
    ...files,
  ]

  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID

  let stdout = ''
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ['inherit', 'pipe', 'inherit'],
    env,
  })

  child.stdout.on('data', chunk => {
    process.stdout.write(chunk)
    stdout += chunk
  })

  const exitCode = await new Promise((res, rej) => {
    child.on('error', rej)
    child.on('close', code => res(code ?? 1))
  })

  let written = false
  try {
    written = statSync(logPath).size > 0
  } catch {}

  if (!written && files.length > 0) {
    process.stderr.write(`No se pudo escribir en ${logPath}\n`)
    return 1
  }

  if (exitCode !== 0) {
    const hasFailureDetails = stdout.includes('✖') || /\bFailed tests:\b/i.test(stdout)
    if (!hasFailureDetails) {
      try {
        const failures = extractFailureBlocks(readFileSync(logPath, 'utf8'))
        if (failures) {
          if (!stdout.endsWith('\n')) process.stdout.write('\n')
          process.stdout.write(`\n${failures}\n`)
        }
      } catch {}
    }
  }

  if (!stdout.endsWith('\n')) process.stdout.write('\n')
  console.log('Detalle de cada test en npm-test.log')

  return exitCode
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
const isDirectInvocation = Boolean(
  invokedPath &&
  (invokedPath === fileURLToPath(import.meta.url) ||
    (process.platform === 'win32' && invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()))
)

if (isDirectInvocation) {
  const code = await runTests()
  process.exit(code)
}
