#!/usr/bin/env bash
# Runs TLC on every config of the Rebote model and compares each result with the expected one:
# `pass`, or the name of the invariant that must be violated. Exits non-zero when any result differs.
# Usage: TLA2TOOLS=<path to tla2tools.jar 1.7.4> [JAVA=<java binary>] bash formal/rebote/check.sh [<cfg> <expected>]...
# Without arguments it checks the list below.
set -u
JAR="${TLA2TOOLS:-}"
JAVA_BIN="${JAVA:-java}"
if [ -z "$JAR" ] || [ ! -f "$JAR" ]; then
  echo "Set TLA2TOOLS to the path of tla2tools.jar 1.7.4 (got '${JAR}')." >&2
  exit 2
fi
# Relative paths are the caller's: resolve them before moving to the model's folder.
JAR="$(cd "$(dirname "$JAR")" && pwd)/$(basename "$JAR")"
case "$JAVA_BIN" in */*) JAVA_BIN="$(cd "$(dirname "$JAVA_BIN")" && pwd)/$(basename "$JAVA_BIN")" ;; esac
cd "$(dirname "$0")"
if [ "$#" -eq 0 ]; then
  set -- \
    rebote.cfg pass \
    rebote-commentfail.cfg pass \
    broken-review-once.cfg ReviewBounceOnce \
    broken-ci-limit.cfg CiBounceTwice \
    broken-conflict.cfg ConflictBounceOncePerHead \
    broken-interp.cfg InterpretationNeverToAuthor \
    broken-owed.cfg ConflictBounceOncePerHead
fi
if [ $(( $# % 2 )) -ne 0 ]; then
  echo "Arguments come in pairs: <cfg> <pass|InvariantName>." >&2
  exit 2
fi
META="$(mktemp -d)"
trap 'rm -rf "$META"' EXIT
status=0
while [ "$#" -gt 0 ]; do
  cfg="$1" expected="$2"
  shift 2
  out="$("$JAVA_BIN" -cp "$JAR" tlc2.TLC -workers 1 -deadlock -metadir "$META" -config "$cfg" Rebote.tla 2>&1)"
  if grep -q "No error has been found" <<<"$out"; then
    got=pass
  else
    got="$(grep -o 'Invariant [A-Za-z]* is violated' <<<"$out" | head -1 | cut -d' ' -f2)"
    got="${got:-error}"
  fi
  echo "$cfg: $got [expected $expected]"
  if [ "$got" != "$expected" ]; then
    status=1
    [ "$got" = error ] && tail -n 20 <<<"$out"
  fi
done
exit $status
