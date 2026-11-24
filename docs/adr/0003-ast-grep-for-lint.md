---
status: accepted
date: 2026-11-24
---

# ast-grep for the lint rules

The comment rule of [ADR 0002](0002-deprecate-ponytail-adopt-comment-rule.md) and the structural checks need a mechanical lint across repos written in JavaScript/TypeScript, Go, Python and Shell, and none of those repos uses a linter today. We decided to implement every mechanical lint rule with ast-grep, pinned by version and checksum, behind a Node wrapper with two modes: diff mode, which checks only the lines a change adds, and whole-repo mode, which checks everything against the Baseline. The lint runs first as a single pilot in orca-stack; after it, `orca-stack init` installs it by default in every repo, with one PR per repo.

## Considered Options

- ESLint, ruff and golangci-lint, one per language: no repo uses any of them, and it would mean four toolchains to install, pin and keep in sync.
- semgrep: it ignores comments, so it cannot enforce the comment rule.
- An own Node script: it only parses JavaScript well, and the repos also hold Go, Python and Shell.

## Consequences

- Every repo gets a new pinned dependency, ast-grep, checked by version and checksum.
- Rules are written per language: JavaScript/TypeScript in the pilot, then Go, Python and Shell.
- Besides comments, the lint carries six structural checks, each with its own Baseline: module-cycle, tangle, field-leak, shallow-module, long-file and wide-directory.
- Per the gentle-ai-architect assessment of a client repo built on a Node agent runtime (2026-11-24): keep its runtime and Node, structural checks in ratchet for JS and Shell now, and Python rules warn-only in repos whose CI does not run their Python suites yet.
