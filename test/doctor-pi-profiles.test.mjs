import assert from 'node:assert/strict'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { cleanup, cli, tempDir, write } from './helpers.mjs'

const dirs = []
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop())
})

describe('#276 Rule 9: doctor warns about pi profiles outside the allowed providers', () => {
  test('doctor warns about every stored profile with a model outside claude-bridge, anthropic and openai', () => {
    const home = tempDir('doctor-pi-profiles')
    dirs.push(home)
    write(path.join(home, '.pi', 'gentle-ai', 'profiles.json'), JSON.stringify({ active: 'OpusFull', profiles: {
      'opus-sonnet': { orchestrator: { model: 'claude-bridge/claude-opus-5-5' }, 'gentle-ai-worker': { model: 'claude-bridge/claude-sonnet-5-5' } },
      OpusFull: { orchestrator: { model: 'claude-bridge/claude-opus-5-5' }, 'gentle-ai-worker': { model: 'anthropic/claude-opus-5-5' } },
      gpt: { orchestrator: { model: 'openai/gpt-5.2' } },
      'samu-balanceado': { orchestrator: { model: 'claude-bridge/claude-opus-5-5' }, 'gentle-ai-explore': { model: 'commandcode/deepseek/deepseek-v4.1-flash' } },
      mixto: { orchestrator: { model: 'commandcode/glm-5.1' } },
    } }))
    const { out } = cli(home, ['doctor', '--offline'], { cwd: home })
    assert.match(out, /perfil de Pi samu-balanceado.*gentle-ai-explore \(commandcode\/deepseek\/deepseek-v4\.1-flash\)/)
    assert.match(out, /perfil de Pi mixto.*orchestrator \(commandcode\/glm-5\.1\)/)
    for (const allowed of ['opus-sonnet', 'OpusFull', 'gpt']) assert.doesNotMatch(out, new RegExp(`perfil de Pi ${allowed}\\b`))
    // --skip-pi does not touch Pi, its profiles included.
    assert.doesNotMatch(cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: home }).out, /perfil de Pi/)
  })
})
