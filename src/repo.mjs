export const getStackAccount = io => {
  const res = io.sh('gh', ['api', 'user'])
  if (res.status !== 0 || !res.stdout) {
    throw new Error(`No pude obtener la cuenta de GitHub actual con \`gh api user\`: ${(res.stderr || res.stdout || '').trim()}`)
  }
  let login
  try {
    login = JSON.parse(res.stdout)?.login
  } catch {}
  if (!login || typeof login !== 'string') {
    throw new Error('La respuesta de `gh api user` no contiene un login válido.')
  }

  return login.trim().toLowerCase()
}

export const getCommonDir = io => {
  const git = io.sh('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], { cwd: io.cwd })
  if (git.status !== 0 || !git.stdout) {
    throw new Error('Corré este comando dentro de un repositorio git.')
  }
  const lines = git.stdout.split(/\r?\n/).map(l => l.trim())
  const commonDir = lines[1]
  const top = lines[2]

  return { commonDir, root: top || io.cwd }
}
