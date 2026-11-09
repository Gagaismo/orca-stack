// Issue 293 Rule 4, from the codex review of PR 347: with a clone pin, the "Falta el perfil" list offers only the
// profile that pin declares, because piProfileFor refuses every other one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { piProfileFor } from '../src/despacho.mjs'

test('missing profile lists only profiles launchable with the clone pin', () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-check-'))
  try {
    const home = join(root, 'home')
    const commonDir = join(root, 'git')
    mkdirSync(join(home, '.pi', 'gentle-ai'), { recursive: true })
    mkdirSync(join(commonDir, 'gentle-ai'), { recursive: true })
    const profile = { orchestrator: { model: 'openai/gpt-5' } }
    writeFileSync(join(home, '.pi', 'gentle-ai', 'profiles.json'), JSON.stringify({ profiles: { alpha: profile, beta: profile } }))
    writeFileSync(join(commonDir, 'gentle-ai', 'profile-pin.json'), JSON.stringify({ kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile: 'alpha' }))
    const options = { home, commonDir, config: {}, io: { out() {} } }
    assert.throws(() => piProfileFor({ ...options, flag: 'beta' }), /El clon ya fija/)
    assert.throws(() => piProfileFor(options), /\(hay: alpha\)/)
    // A clone pin naming a profile the store lacks leaves none launchable, and the list says why for each one.
    writeFileSync(join(commonDir, 'gentle-ai', 'profile-pin.json'), JSON.stringify({ kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile: 'gone' }))
    assert.throws(() => piProfileFor(options), /\(ninguno se puede lanzar: alpha: el clon fija el perfil "gone"; beta: el clon fija el perfil "gone"\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
