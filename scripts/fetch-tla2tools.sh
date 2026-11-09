#!/usr/bin/env bash
# Downloads tla2tools.jar 1.7.4 to <dest> and checks its pinned checksum; both CI sites that need TLC call it (#346).
# A transient failure of GitHub releases (a 5xx, a connection reset) is retried 5 times, 5 seconds apart. A jar whose
# checksum differs fails, whatever path it came from.
# Usage: bash scripts/fetch-tla2tools.sh <dest>
# The tests point TLA2TOOLS_URL at a local server and set TLA2TOOLS_RETRY_DELAY to 1 (0 would turn on curl's own backoff).
set -euo pipefail

jar="${1:?usage: bash scripts/fetch-tla2tools.sh <dest>}"
url="${TLA2TOOLS_URL:-https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar}"

curl -fsSL --retry 5 --retry-all-errors --retry-delay "${TLA2TOOLS_RETRY_DELAY:-5}" -o "$jar" "$url"
echo "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  $jar" | sha256sum --check --strict -
