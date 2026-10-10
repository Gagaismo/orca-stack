import path from 'node:path'

import { codexHome, tilde } from './util.mjs'

export const codexTrustHint = root =>
  `Confiá la raíz del repo en Codex: [projects.'${root}'] trust_level = "trusted" en ${tilde(path.join(codexHome(), 'config.toml')).replaceAll('\\', '/')}.`
