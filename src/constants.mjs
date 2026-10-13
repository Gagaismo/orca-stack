// Versions and names the installer pins. Everything else is discovered from the package contents.

export const PINNED = {
  pi: '1.2.0',
  gentlePi: '4.2.0',
  claudeBridge: '0.9.2',
}

// Oldest Pi that gentle-pi PINNED.gentlePi runs on (its peer range): an older Pi makes gentle-shell exit.
export const PI_MIN_VERSION = '1.2.0'

// Pi packages installed with `pi install npm:<name>@<version>`.
export const PI_PACKAGES = [
  { name: 'gentle-pi', version: PINNED.gentlePi },
  { name: 'pi-claude-bridge', version: PINNED.claudeBridge },
]

// Provider wrappers. Their names never match the real binary, so they cannot call themselves.
export const WRAPPERS = {
  claude: { windows: ['claude.exe', 'claude.cmd'], posix: ['claude'], orcaKey: 'claude' },
  codex: { windows: ['codex.exe', 'codex.cmd'], posix: ['codex'], orcaKey: 'codex' },
  agy: { windows: ['agy.exe'], posix: ['agy'], orcaKey: 'antigravity' },
}

export const STACK_LEVELS = { mode: 'auto', caveman: 'full', ponytail: 'full' }

export const MARKER_BEGIN = '<!-- orca-stack:begin -->'
export const MARKER_END = '<!-- orca-stack:end -->'
// Written by the stack before orca-stack existed; init and global migrate it to the current markers.
export const LEGACY_BEGIN = '<!-- orca-stack:auto -->'
export const LEGACY_END = '<!-- /orca-stack:auto -->'

// Oldest version of the Matt Pocock plugin the work contract works with, and the skills it relies on.
export const MATT_MIN_VERSION = '1.3.1'
export const MATT_REQUIRED_SKILLS = ['pr', 'implement-spec', 'retro']

export const PROJECT_CONFIG = '.orca-stack.json'
export const PROJECT_LOCAL_CONFIG = '.orca-stack.local.json'

export const INSTALL_HINTS = {
  pi: [
    'macOS / Linux:  curl -fsSL https://pi.dev/install.sh | sh',
    'Windows:        powershell -c "irm https://pi.dev/install.ps1 | iex"',
    'Alternativa:    npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
    'Requiere Node.js 22.19 o más nuevo. Fuente: https://github.com/earendil-works/pi#readme',
  ],
  engram: [
    'macOS / Linux (Homebrew):  brew install gentleman-programming/tap/engram',
    'Windows, Linux y compilación desde el código: https://github.com/Gentleman-Programming/engram/blob/main/docs/INSTALLATION.md',
    'Plugin para Claude Code:   claude plugin marketplace add Gentleman-Programming/engram && claude plugin install engram',
  ],
  'gentle-ai': [
    'macOS (Homebrew):  brew install gentleman-programming/tap/gentle-ai',
    'macOS / Linux:     curl -fsSL https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/scripts/install.sh | bash',
    'Windows y otras opciones: https://github.com/Gentleman-Programming/gentle-ai#readme',
  ],
  orca: [
    'macOS (Homebrew):  brew install --cask stablyai/orca/orca',
    'Windows, Linux y macOS: https://github.com/stablyai/orca/releases/latest',
  ],
  gh: ['https://cli.github.com (después: gh auth login)'],
  // Matt's own marketplace ships the current version under the same plugin name (the official one pins an old sha),
  // so /mattpocock-skills:<skill> keeps working.
  mattpocock: [
    'claude plugin marketplace add mattpocock/skills',
    'claude plugin install mattpocock-skills@mattpocock',
  ],
  // For codex and agy, which read ~/.agents/skills.
  mattpocockAgents: ["npx skills add mattpocock/skills -g -s '*' -a codex -a antigravity-cli -y"],
  caveman: [
    'claude plugin marketplace add JuliusBrussee/caveman && claude plugin install caveman@caveman',
    'Otras formas (todos los agentes): npx skills add JuliusBrussee/caveman -g',
  ],
}
