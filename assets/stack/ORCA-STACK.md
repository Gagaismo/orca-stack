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
  Its level is `lite`, `full` or `ultra` (the wrappers set `full`), and a
  shortcut with a known limit gets a `shortcut: <the limit>, <when to upgrade>`
  code comment.
- **Caveman (modular)**: communication compression. Orca Auto applies it when
  the work is token-heavy, but never compresses code, commands, paths, exact
  errors, decisions, risks, uncertainty, tests, or acceptance evidence.
  Its level is a caveman 3.2.0 mode: `caveman`, `ultracave` or `megacave` (the
  wrappers set `caveman`).
- **Engram**: persistent memory only. It is not an authority or a scheduler.
- **Gentle Shell (Pi)**: another engineer on the team with its own methodology
  (it may use ODD). It implements tickets, reviews with Judgment Day, and is
  consulted as a peer. Implementation across the stack uses gentle-ai ODD.
- **Claude / Codex / Antigravity**: execution providers attached to Orca. Provider
  choice never changes lifecycle authority.

## Authority order

1. Orca runtime, active Dispatch, and worker contract.
2. Project instructions, ADRs, CONTEXT, spec, and ticket acceptance criteria.
3. Main's current gear, which only turns the closed gear-knob list below. It never broadens anything above it.
4. Role brief supplied by the coordinator (research, implementation, review, etc.).
5. Specialized skill for the current role.
6. Ponytail implementation policy.
7. Caveman communication policy.
8. Provider defaults.

A lower layer cannot cancel, replace, or broaden a higher layer. If a generic
minimalism rule conflicts with an explicit requirement, preserve the requirement.
If a communication rule would hide evidence, use normal prose for that passage.

## Gear knobs

These are the only process settings that a gear may turn. Every knob cites its source by heading. The contract's "Ciclo de `main`" references are checked against the shipped contract by CI. The gentle-ai ODD headings cited for K1-K3 and K5 are external to this repository and are intentionally unchecked; the check covers only citations to the shipped contract and policy.

- **K1 — Exploration depth** changes how deeply main explores before deciding; it does not change the evidence required by the task. Internal heading: CONTRATO.md — Ciclo de `main`; external gentle-ai ODD heading: Evidence budget rule (unchecked).
- **K2 — Delegation of main's own work** changes how readily main delegates its own work; it does not change Orca's worker ownership or dispatch lifecycle. Internal heading: CONTRATO.md — Ciclo de `main`; external gentle-ai ODD heading: Mandatory Delegation Triggers (unchecked).
- **K3 — Research and assumption challenge** changes how readily main recommends optional research or challenges a consequential premise; it does not decide product questions for the human. Internal heading: CONTRATO.md — Ciclo de `main`; external gentle-ai ODD heading: Resolve uncertainty (unchecked).
- **K4 — Gentle Shell consults above a floor** changes extra consults beyond any required floor; it does not remove a required consult. Internal heading: CONTRATO.md — Ciclo de `main`.
- **K5 — Non-product questions** changes how readily main asks non-product questions; it does not move the human's product decisions to main. Internal heading: CONTRATO.md — Ciclo de `main`; external gentle-ai ODD heading: Ask trigger (unchecked).
- **K6 — Beyond-request proposals** changes whether main proposes additional work; proposals do not authorize implementation. Internal heading: CONTRATO.md — Ciclo de `main`.
- **K7 — Worker supervision** changes whether main supervises workers when the human requests it in Proactive; it does not change worker lifecycle ownership. Internal heading: CONTRATO.md — Ciclo de `main`.
- **K8 — Narration amount** changes how much main narrates; it does not omit evidence, decisions, risks, uncertainty, or test results. Internal heading: CONTRATO.md — Avances.
- **K9 — Watch cadence** changes how often main checks progress; it does not change the requirement to preserve worker and dispatch ownership. Internal heading: CONTRATO.md — Ciclo de `main`.
- **K10 — Effort and model** changes the effort or model used for main's own work; it does not change the provider routing configured for workers. Internal heading: ORCA-STACK.md — Provider routing.
- **K11 — Arena/swarm readiness** changes how readily main considers an arena or swarm; who authorizes it and its cost cap stay fixed. Internal heading: CONTRATO.md — Arena y swarm.

Everything outside K1-K11 is a fixed rule. A new or unclear rule becomes a gear knob only if it passes the four-harm test: could the human get something different unknowingly, could it cause an irreversible effect, could it corrupt shared state, or could it produce a false report? A later ticket may add a knob only by passing that test and recording it in its resolution. Caveman, Ponytail, and Engram are orthogonal to gears.

## Worker contract

An Orca worker executes the assigned mission only. It does not create a competing
Run, spawn an unrequested sub-agent, restart planning for an already specified
ticket, ask the human directly, or wait for a human answer. If blocked, use the
preamble's Orca `ask` command and state the smallest concrete decision needed.
Finish with the required Orca `worker_done` receipt, outcome, files, tests, and
report path when applicable. Do not continue after settlement.

A Claude worker may run an arena or swarm only when its dispatch or bounce note
authorizes that fan-out for the ticket; read-only swarms require the note too.
Use the Agent tool only, never Workflow. The note fixes the approved N and
rubric or question; candidates use the worker's effort unless the note says
otherwise. Run one round and do not retry: if every candidate drops out or the
worker wants another round, continue the normal path and report that under
`## Arena` or `## Swarm`. Publish results under that heading in the PR body.
Codex, codex-cc, agy, and pi do not run arenas or swarms, even with a note.
A bounce fan-out note requires a new human OK; a dispatch approval does not
carry over.

**Handoff by a project script.** A worker launched by a project's own dispatch
script (a handoff, not a supervised Dispatch) has no Orca preamble, so there is
no `ask` and no `worker_done`. The project brief owns verification, where to ask
(usually an issue comment), and closing (usually an open PR). Follow the brief;
do not wait for Orca receipts that will not come.

## Methodology contract

Planning follows Matt's skills (`grill-with-docs`, `to-spec`, `to-tickets`, triggered
by the human; a Straight shot skips `grill-with-docs` and `to-spec`) and implementation follows gentle-ai ODD for Claude, Codex and
Antigravity sessions; Pi follows its own methodology (it may use ODD). Ponytail
may reduce the
implementation footprint inside an approved ticket; it may not remove research,
domain modeling, explicit spec obligations, ADR decisions, security, validation,
accessibility, data-loss handling, or required tests. `ponytail-review` is a
second pass after correctness/spec review; it reports only and never applies
changes. It reviews quality as a whole (bugs, risk, scale, tests, speed, lean);
the Ponytail reviewer role keeps only its Lean findings and passes any
non-Lean *Must fix* to main in one line. `ponytail-audit` is
opt-in and repo-wide.

Ticket authoring rules are defined in the project's `AGENTS.md` contract. `main`
follows that contract when writing tickets; do not copy a second version here.

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

## Launching agents

Do not launch agents by hand: from the main checkout, `orca-stack despachar <issue> <agent>` and
`orca-stack revisar <pr> <agent>` create the worktree with `orca worktree create` (so it shows up in Orca), write the
brief from a template, check that every repo path the brief cites exists in the worktree, launch the agent
in an Orca terminal and send it the brief. They refuse to start when the issue is assigned, the agent is
not in `agentes.usa`, a worktree or a live agent already exists, or the reviewer wrote the PR. If one fails,
show its error; do not rebuild the dispatch by hand.

Reference, the launcher each agent gets as the `--command` of `orca terminal create`. They are written for the Orca
terminal on Windows, which is PowerShell; in a POSIX shell the leading `& ` is dropped and the key is set with
`export CMD_API_KEY=...`. Model and effort come from personal config (`~/.orca-stack/config.json`,
`agentes.modelos`), never from the project; without them each agent uses its launcher's default.

- claude: `& "{{WRAPPER_CLAUDE}}" --dangerously-skip-permissions`
- agy: `& "{{WRAPPER_AGY}}" --dangerously-skip-permissions`
- codex: `& "{{WRAPPER_CODEX}}" --model <model> -c model_reasoning_effort="<effort>" -c features.fast_mode=false -c approval_policy="never" -c sandbox_mode="danger-full-access"`
  Nobody answers approval prompts in an unattended worker, so the approval and
  sandbox flags are required. Fast mode is off because it spends Codex credits
  faster and an unattended worker does not need the speed.
- codex-cc: `$env:CMD_API_KEY = (Get-Content -Raw -Encoding UTF8 -LiteralPath "$HOME.piagentauth.json" | ConvertFrom-Json).commandcode.key; & "{{WRAPPER_CODEX}}" -c model_provider=cc -c model_providers.cc.name=CommandCode -c model_providers.cc.base_url=https://api.commandcode.ai/provider/v1 -c model_providers.cc.env_key=CMD_API_KEY -c model_providers.cc.wire_api=responses --model <model> -c model_reasoning_effort="<effort>" -c approval_policy="never" -c sandbox_mode="danger-full-access"`
  Use the review model and effort to review and the implementation ones to
  implement; the rest of the command does not change. The key is read inside
  the terminal, so it never appears in the command or in the brief. If Command
  Code rejects the request (401, 403 `MODEL_NOT_IN_PLAN`, 429), it shows on
  the screen after the brief.
- pi (Gentle Shell): headless, no TUI, so the brief goes in the prompt and nothing is sent afterwards. The command clears
  the Orca and `ORCA_STACK_*` variables (the same list the pi consult bridge clears), sets `ENGRAM_DATA_DIR` to
  Gentle Shell's own engram, `GENTLE_PI_AUTONOMOUS_MODE=1` and, when personal config sets it, `CLAUDE_CONFIG_DIR`
  from `agentes.pi.claudeConfigDir`, then runs `pi -p --no-skills --skill <gentle-pi skills> --session-id <id> [--tools <tools>] "Read and carry out the brief in <path>. Non-interactive: never wait for user input."`
  Tools: no `--tools` to implement, so gentle-pi keeps its subagents, ODD and engram tools; `read,bash,grep,find,ls` to
  review. Unlike the consult bridge, this one can run git, gh and the suite.

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
always-on hooks, session-start codebase map, subagent injection, MCP proxy, statusline ownership, cavecrew
workers, and alternate planning loops would duplicate provider/Orca control.
The wrappers own the small safe bridge: launch-scoped environment markers
(`ORCA_STACK_MODE`, `ORCA_STACK_CAVEMAN_LEVEL`, `ORCA_STACK_PONYTAIL_LEVEL`,
`ORCA_STACK_POLICY_PATH`).
The installed modular skills remain available explicitly:

- `ponytail` — implementation policy card, no lifecycle hook.
- `ponytail-review` — read-only quality review, second pass.
- `ponytail-audit` / `ponytail-debt` — explicit maintenance tools;
  `ponytail-debt` lists the `shortcut:` comments and older `ponytail:` ones.
- `caveman` — communication-only mode; Auto is selected in Orca, not by a
  provider hook.

## Stop criteria

Stop when the assigned acceptance criteria are proven, the relevant tests/checks
have run, the result is reported to Orca, and no unresolved blocker remains.
Do not add generalization, cleanup, dependencies, or documentation outside the
mission merely because they might help later; record a bounded follow-up instead.
