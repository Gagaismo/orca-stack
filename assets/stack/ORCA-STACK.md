# Orca agent stack

This directory is the human-readable control plane for the local Orca stack. It is
not a second development methodology and it is not loaded as a prompt by itself.
Provider instruction files point here for the durable policy.

## Components

- **Orca**: lifecycle and delegation authority. It owns Runs, Tasks, Dispatches,
  worker placement, settlement, cleanup, and coordinator/worker boundaries.
- **Matt Pocock skills**: engineering methodology: grill-with-docs -> domain
  modeling -> CONTEXT/ADRs -> spec -> tickets -> TDD implementation -> review.
- **Ponytail (modular)**: implementation policy only: avoid unnecessary work and
  choose the smallest correct solution after understanding the task and code.
  Orca Auto applies it to implementation turns; it never overrides requirements.
- **Caveman (modular)**: communication compression. Orca Auto applies it when
  the work is token-heavy, but never compresses code, commands, paths, exact
  errors, decisions, risks, uncertainty, tests, or acceptance evidence.
- **Engram**: persistent memory only. It is not an authority or a scheduler.
- **Gentle Shell (Pi)**: another engineer on the team with its own methodology
  (it may use SDD). It implements tickets, reviews with Judgment Day, and is
  consulted as a peer. gentle-ai's SDD is available to Claude sessions on
  explicit request.
- **Claude / Codex / Antigravity**: execution providers attached to Orca. Provider
  choice never changes lifecycle authority.

## Authority order

1. Orca runtime, active Dispatch, and worker contract.
2. Project instructions, ADRs, CONTEXT, spec, and ticket acceptance criteria.
3. Role brief supplied by the coordinator (research, implementation, review, etc.).
4. Specialized skill for the current role.
5. Ponytail implementation policy.
6. Caveman communication policy.
7. Provider defaults.

A lower layer cannot cancel, replace, or broaden a higher layer. If a generic
minimalism rule conflicts with an explicit requirement, preserve the requirement.
If a communication rule would hide evidence, use normal prose for that passage.

## Worker contract

An Orca worker executes the assigned mission only. It does not create a competing
Run, spawn an unrequested sub-agent, restart planning for an already specified
ticket, ask the human directly, or wait for a human answer. If blocked, use the
preamble's Orca `ask` command and state the smallest concrete decision needed.
Finish with the required Orca `worker_done` receipt, outcome, files, tests, and
report path when applicable. Do not continue after settlement.

**Handoff by a project script.** A worker launched by a project's own dispatch
script (a handoff, not a supervised Dispatch) has no Orca preamble, so there is
no `ask` and no `worker_done`. The project brief owns verification, where to ask
(usually an issue comment), and closing (usually an open PR). Follow the brief;
do not wait for Orca receipts that will not come.

## Methodology contract

Matt's workflow is the default methodology for Claude, Codex and Antigravity
sessions; Pi follows its own. Ponytail may reduce the
implementation footprint inside an approved ticket; it may not remove research,
domain modeling, explicit spec obligations, ADR decisions, security, validation,
accessibility, data-loss handling, or required tests. `ponytail-review` is a
second-pass complexity review after correctness/spec review; it reports only and
never applies changes. `ponytail-audit` is opt-in and repo-wide.

## Communication contract

Caveman is communication-only. In `auto`, compress filler and repetitive prose
only when it saves tokens; use normal prose for research, security warnings,
irreversible-action confirmations, exact evidence, or when compression could
change order or meaning. The official-build integration below intentionally does not pretend to add
controls that the official Orca UI does not provide.

## Provider routing

- **Who implements and who reviews** is the project's role table in `AGENTS.md`
  plus `.orca-stack.json`. Models, efforts and quotas live in personal config
  (`~/.orca-stack/config.json`, `agentes.modelos`); the committed
  `.orca-stack.json` only says which agents the repo uses.
- **Antigravity (`agy`)**: send it a file path for multiline briefs rather than
  a multiline terminal prompt, because each newline is sent as Enter and would
  split the brief into several submissions.
- **Engram**: use the installed MCP/plugin integrations; save decisions,
  discoveries, fixes, and session summaries without treating memory as authority.

## Launching agents for a manual dispatch

Use these commands as the `--command` of `orca terminal create`. The Orca
terminal is PowerShell on Windows, and the wrappers below are the ones this
machine installed. Model and effort come from personal config
(`~/.orca-stack/config.json`, `agentes.modelos`), never from the project.

- claude: `& "{{WRAPPER_CLAUDE}}" --dangerously-skip-permissions`
- agy: `& "{{WRAPPER_AGY}}" --dangerously-skip-permissions`
- codex-cc: `$env:CMD_API_KEY = (Get-Content -Raw -Encoding UTF8 -LiteralPath "$HOME\.pi\agent\auth.json" | ConvertFrom-Json).commandcode.key; & "{{WRAPPER_CODEX}}" -c model_provider=cc -c model_providers.cc.name=CommandCode -c model_providers.cc.base_url=https://api.commandcode.ai/provider/v1 -c model_providers.cc.env_key=CMD_API_KEY -c model_providers.cc.wire_api=responses --model <modelo> -c model_reasoning_effort="<esfuerzo>" -c approval_policy="never" -c sandbox_mode="danger-full-access"`
  Use the review model and effort to review and the implementation ones to
  implement; the rest of the command does not change. The key is read inside
  the terminal, so it never appears in the command or in the brief. If Command
  Code rejects the request (401, 403 `MODEL_NOT_IN_PLAN`, 429), it shows on
  the screen after the brief.

## Official Orca integration (preferred)

The installed official Orca is the daily runtime and remains updateable. Its
Settings > Agents command overrides point the installed providers through these
stack wrappers:

- `{{WRAPPER_CLAUDE}}`
- `{{WRAPPER_CODEX}}`
- `{{WRAPPER_AGY}}`

Each wrapper sets the stack markers, resolves the real provider executable from
`PATH`, preserves Orca's arguments, and returns the provider exit code.
`npx github:Gagaismo/orca-stack doctor` verifies the whole setup. This path preserves official
Orca updates and existing projects/profiles. It applies to Orca-launched
terminal agents; it does not add a native Agent Stack section, per-worker
switches, or new global settings to the official build.

## Deliberate exclusions

Do not install the full Ponytail or Caveman lifecycle-hook stacks. Their
always-on hooks, subagent injection, MCP proxy, statusline ownership, cavecrew
workers, and alternate planning loops would duplicate provider/Orca control.
The wrappers own the small safe bridge: launch-scoped environment markers
(`ORCA_STACK_MODE`, `ORCA_STACK_CAVEMAN_LEVEL`, `ORCA_STACK_PONYTAIL_LEVEL`,
`ORCA_STACK_POLICY_PATH`).
The installed modular skills remain available explicitly:

- `ponytail` — implementation policy card, no lifecycle hook.
- `ponytail-review` — complexity-only second pass.
- `ponytail-audit` / `ponytail-debt` — explicit maintenance tools.
- `caveman` — communication-only mode; Auto is selected in Orca, not by a
  provider hook.

## Stop criteria

Stop when the assigned acceptance criteria are proven, the relevant tests/checks
have run, the result is reported to Orca, and no unresolved blocker remains.
Do not add generalization, cleanup, dependencies, or documentation outside the
mission merely because they might help later; record a bounded follow-up instead.
