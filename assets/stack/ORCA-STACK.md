# Orca agent stack

This directory is the human-readable control plane for the local Orca stack. It is
not a second development methodology and it is not loaded as a prompt by itself.
Provider instruction files point here for the durable policy.

## Components

- **Orca**: lifecycle and delegation authority. It owns Runs, Tasks, Dispatches,
  worker placement, settlement, cleanup, and coordinator/worker boundaries.
- **Matt Pocock skills**: engineering methodology: grill-with-docs -> domain
  modeling -> CONTEXT/ADRs -> spec -> tickets -> TDD implementation -> review.
- **Engram**: persistent memory only. It is not an authority or a scheduler.
- **Gentle Shell (Pi)**: another engineer on the team with its own methodology
  (it may use ODD). It implements tickets, reviews with Judgment Day, and is
  consulted as a peer. Implementation across the stack uses gentle-ai ODD.
- **Claude / Codex / Antigravity**: execution providers attached to Orca. Provider
  choice never changes lifecycle authority.

## Authority order

1. Orca runtime, active Dispatch, and worker contract.
2. Project instructions, ADRs, CONTEXT, spec, and ticket acceptance criteria.
3. Role brief supplied by the coordinator (research, implementation, review, etc.).
4. Specialized skill for the current role.
5. Provider defaults.

A lower layer cannot cancel, replace, or broaden a higher layer. If a generic
minimalism rule conflicts with an explicit requirement, preserve the requirement.

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
Codex, agy, and pi do not run arenas or swarms, even with a note.
A bounce fan-out note requires a new human OK; a dispatch approval does not
carry over.

**Handoff by a project script.** A worker launched by a project's own dispatch
script (a handoff, not a supervised Dispatch) has no Orca preamble, so there is
no `ask` and no `worker_done`. The project brief owns verification, where to ask
(usually an issue comment), and closing (usually an open PR). Follow the brief;
do not wait for Orca receipts that will not come.

## Methodology contract

Planning follows Matt's skills (`grill-with-docs`, `to-spec`, `to-tickets`, triggered
by the human) and implementation follows gentle-ai ODD for Claude, Codex and
Antigravity sessions; Pi follows its own methodology (it may use ODD).

Ticket authoring rules are defined in `~/orca/stack/MAIN.md` ("Ciclo de `main`", step 2).
`main` follows them when writing tickets; do not copy a second version here.

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
show its error; do not rebuild the dispatch by hand. `revisar` and `rebote` close the `done` terminals and empty
shells of the worktree they reuse themselves, and refuse only while an agent works there.

RDD consent for a dispatched worker comes from orca-stack's policy, `agentes.<agent>.rddConsentimiento` in the
merged config: `"politica"` (the default) answers `declined` on the worker's own candidate and `granted` on main's
`RDD:` request for that head, without asking the human; `"humano"` makes the worker ask main with
`orca orchestration ask`, with only the consent's choices as closed options.
`reviewParaMerge: false` in `.orca-stack.json` (read only from the copy committed on the PR's base branch on GitHub, never from the checkout) makes `orca-stack estado` drop the step-7 review requirement for repos that merge on green CI; CI, `## Evidencia`, unsettled blockers on the head, migrations and `riesgo` reviews still count (#377). `migraciones` in `.orca-stack.json`, `{ "glob": "<dir>/*.sql", "numero": "^(\\d+)_" }`, makes `orca-stack estado` require
that every migration a PR adds has a number above the highest one on its base branch.

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
  Use the review model and effort to review and the implementation ones to
  implement; the rest of the command does not change. The key is read inside
  the terminal, so it never appears in the command or in the brief. If Command
  Code rejects the request (401, 403 `MODEL_NOT_IN_PLAN`, 429), it shows on
  the screen after the brief.
- pi (Gentle Shell): an interactive TUI like the other workers, so Orca shows it on its card and a turn waiting on a
  background verify resumes when it reports. The brief goes in the first message and nothing is sent afterwards. The
  command clears the `ORCA_STACK_*` variables (the stack markers the pi consult bridge also clears) and keeps Orca's
  pane variables, which Orca's pi extension reports through. It sets `GENTLE_PI_AUTONOMOUS_MODE=1` and, when personal
  config sets it, `CLAUDE_CONFIG_DIR` from `agentes.pi.claudeConfigDir`, and no `ENGRAM_DATA_DIR`, so the worker shares
  the human's global Engram memory (`~/.engram`). Then it runs `pi --no-skills --skill <gentle-pi skills> --session-id <id> --no-approve --exclude-tools ask_user_choice,ask_user_question [--tools <tools>] "Read and carry out the brief in <path>. Unattended: never wait for user input."`
  Nothing waits on a person: the two dialog tools are left out and `--no-approve` skips the project-trust prompt.
  Tools: no `--tools` to implement, so gentle-pi keeps its subagents, ODD and engram tools; to review,
  `read,bash,grep,find,ls,codemode` plus the Engram read tools `mem_current_project`, `mem_context`, `mem_search` and
  `mem_get_observation` (never an Engram write tool). Unlike the consult bridge, this one can run git, gh and the suite.

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
switches, or new global settings to the official build. The official-build integration intentionally does not pretend to add
controls that the official Orca UI does not provide.

## Deliberate exclusions

Do not install the full lifecycle-hook stacks of the modular skills. Their
always-on hooks, session-start codebase map, subagent injection, MCP proxy, statusline ownership,
and alternate planning loops would duplicate provider/Orca control.
The wrappers own the small safe bridge: launch-scoped environment markers
(`ORCA_STACK_POLICY_PATH`, plus those of the perks).

## Stop criteria

Stop when the assigned acceptance criteria are proven, the relevant tests/checks
have run, the result is reported to Orca, and no unresolved blocker remains.
Do not add generalization, cleanup, dependencies, or documentation outside the
mission merely because they might help later; record a bounded follow-up instead.
