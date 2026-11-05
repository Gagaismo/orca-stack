#!/usr/bin/env bash
# Runs the Rebote model. Expected: rebote.cfg passes; every broken-*.cfg fails with the named invariant;
# rebote-commentfail.cfg fails (known finding, see .claude/skills/verify-rebote/SKILL.md).
# TLA2TOOLS = path of tla2tools.jar 1.7.4.
set -u
cd "$(dirname "$0")"
JAR="${TLA2TOOLS:-C:/Users/lautaro/orca/scratch/tla/tla2tools.jar}"
META="$(mktemp -d)"
trap 'rm -rf "$META"' EXIT
status=0
run() { # cfg expected(pass|fail)
  out="$(java -cp "$JAR" tlc2.TLC -workers 1 -deadlock -metadir "$META" -config "$1" Rebote.tla 2>&1)"
  if grep -q "No error has been found" <<<"$out"; then got=pass; else got=fail; fi
  inv="$(grep -o 'Invariant [A-Za-z]* is violated' <<<"$out" | head -1)"
  echo "$1: $got ${inv:+($inv)} [expected $2]"
  [ "$got" = "$2" ] || status=1
}
run rebote.cfg pass
run broken-review-once.cfg fail
run broken-ci-limit.cfg fail
run broken-conflict.cfg fail
run broken-interp.cfg fail
run rebote-commentfail.cfg fail
exit $status
