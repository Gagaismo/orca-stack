# Arena and swarm mechanism on Claude Code + orca-stack

Ticket: #121 (map #118). Mechanism only; contract conflicts are listed for #130.
Read-only research: no Workflow was run and no agent was dispatched.

## Upstream summary

Sources: `cursor/plugins/main/pstack/skills/{arena,swarm,setup-pstack}/SKILL.md` (raw GitHub, read 2026-10-13).

**Arena** (`disable-model-invocation: true`, user-triggered). Phases: Frame, Fan out, Cross-judge, Pick, Graft, Verify.
- Frame: every candidate gets the same prompt. The parent derives a 3-6 criteria rubric that candidates never see. Runners come from the `arena runners` line of `~/.cursor/rules/pstack-models.mdc`; default one `claude-opus-5-5-xhigh` plus one `grok-4.7-xhigh-fast`. Each candidate gets its own output location (git worktree where possible).
- Fan out: all N subagents spawned in one message with `run_in_background: true`; each returns the artifact plus a rationale (alternatives considered and rejected). A dropout means proceed with N-1.
- Cross-judge: after all candidates finish, ONE readonly judge subagent, model picked from `arena cross-judge pool`, preferring a family different from the parent's. It scores per criterion and recommends a base.
- Pick: the parent reads every candidate end to end, scores against the rubric, compares with the judge; disagreement means read both rationales.
- Graft: usually one or two things per loser, folded in by hand. Convergence means ship the consensus; wild divergence means Frame was under-specified, re-run.
- Verify: like any output. Output is one artifact plus a synthesis note (base, judge verdict, grafts with source, rejections, dropouts, verification).

**Swarm** (also user-triggered). Phases: Frame, Fan out, Aggregate, Report.
- Frame: done predicate and report shape; shape is slices, race, or mixed; a race needs `first pass`, `rank all` or `best-of` declared up front; N is total workers, not the concurrency cap; worker model from `swarm workers` (default `grok-4.7-xhigh-fast`); each writer gets its own output; verification briefs name exact SHAs and method.
- Fan out: one message, `subagent_type: generalPurpose`, `environment: "cloud"` (local only if the worker needs the user's machine), `run_in_background: true`, `cloud_base_branch` for a non-default pushed branch. Stand-alone briefs; reports are `PASS` / `ISSUES` / `BLOCKED` with evidence.
- Aggregate: drop results missing the required SHAs/method and respawn once; after a second miss record a gap (a gap is not a pass). Report: result table, one-line evidenced issues, gaps, race rule.

**setup-pstack** writes `~/.cursor/rules/pstack-models.mdc`: a `# budget` line and one model per role (including panel lists and `inherit-parent`/`auto`). It is the only place model choice lives upstream; there is no per-run override.

Upstream assumptions that do not hold here: Cursor's `Task` tool with a per-call `model` slug across vendors (claude + grok), cloud environments, and a rules file.

## Primitives

| | Workflow tool (ultracode) | Agent tool | `orca-stack despachar` / `revisar` |
|---|---|---|---|
| N parallel candidates | Yes. `parallel()`/`pipeline()` over `agent()`; cap min(16, CPUs-2) concurrent, 1000 agents per workflow, 4096 items per call | Yes. Several Agent calls in one message; subagents run in the background | Yes, but one command per issue/PR and one worker each (see notes) |
| Isolated worktrees | `agent(..., {isolation:'worktree'})`; ~200-500ms + disk each; auto-removed if unchanged | `isolation: "worktree"` (or `"remote"`, availability gated); auto-cleaned if unchanged | Native: `orca worktree create` from `origin/<ramaBase>`; kept after finishing (never auto-removed) |
| Model choice | `opts.model` and `opts.effort` per call; Claude models only (inherits session by default) | `model` enum (sonnet, opus, haiku, fable) and `effort` (low..max); Claude only | Any family: claude, codex (gpt), agy (gemini), codex-cc (glm/gpt), pi (claude); model/effort from `agentes.modelos`, no per-run flag |
| Cross-family judge | No (single vendor). Another Claude tier is not another family per `shared/familias.json` | No (same reason) | Yes. `revisar` only accepts a different family than the author (`familyOf`); agy/codex/codex-cc supply gemini/gpt/glm |
| Results back to parent | `agent()` returns text or, with `schema`, a validated object; deterministic code aggregates | Final message of each subagent arrives as a notification | No return channel. The worker works alone and publishes a PR (ticket) or a PR review comment; the parent reads it via `gh` and its PR-state Monitor |
| Orchestration | Deterministic JS control flow: rubric stage, fan-out, judge, graft loops, adversarial verify, budget loops | Parent drives each step manually | Parent drives; each dispatch is a separate command |
| Cost / limits | Token cost scales with agents; honours the `+Nk` turn budget as a hard ceiling; resumable (`resumeFromRunId`) | Same token cost per subagent; no orchestration code | Each worker is a full CLI session (credits for codex-cc, quota for codex/agy); `guardia.bloquear` and `preguntarAntes` can refuse an agent |
| Human authorization | Needs the user's opt-in (standing only when ultracode is on); a script run is shown in a permission dialog. Subagents inherit CLAUDE.md | None beyond normal tool permissions; worktree writers run under the session's permissions | Dispatch needs no asking per the contract, except `preguntarAntes` agents (`--confirmado`); any remote operation needs explicit authorization |

Notes
- Workflow and Agent are the in-process route: cheap to fan out, results return in-context, Claude-only. They fit `main`'s own subagents, which the map says gears govern.
- `despachar`/`revisar` is the only route that crosses families. Constraints read in `src/despacho.mjs`:
  - `despachar <n>` requires an OPEN, unassigned GitHub issue and assigns it (the assignee is the lock); the worktree is named `<repo>-<n>`, so a second candidate on the same issue is refused. N candidates of one task therefore need N distinct issues, or a new mode in `despachar`.
  - `revisar <pr> <agente>` needs an `Implementador:` line in the PR body, names the worktree `revision-<pr>-<agente>`, and refuses self-review and same-family pairs. A judge fits this shape per PR, not "all candidates at once".
  - `despachar` throws in `un-agente` mode ("no hay workers que despachar"), so the cross-family route does not exist there.
  - Launch is `claude --dangerously-skip-permissions [--model]`, `codex -c approval_policy="never" -c sandbox_mode="danger-full-access"`, etc., in an Orca terminal. Effort is passed only for codex/codex-cc, thinking only for pi; claude/agy get a model only.
- Agent tool params verified from its schema: `isolation` (`worktree`|`remote`), `effort`, `model`, `subagent_type`, `prompt`. `run_in_background` is not a schema parameter here; the tool description says subagents run in the background and notify on completion.
- Not verified: whether a Workflow `agent()` or an Agent subagent could reach a non-Claude model. A Bash step could shell out to `orca-stack`, `codex exec` or the `puente-gentle` consult, but that was not tested, and the consult is read-only by contract and runs on Claude.

## Mapping for arena

Most plausible hybrid: Workflow (or parallel Agent calls) for candidates; a cross-family judge only when worth the cost.

1. Frame (parent, inline): task, shared prompt, 3-6 rubric criteria kept from candidates.
2. Fan out: N candidates as `agent(prompt, {isolation:'worktree', model, effort})` inside one `parallel()` (or N Agent calls with `isolation: "worktree"`). Each commits on its own branch and returns a rationale. Runners may differ in Claude tier and effort, not in vendor.
3. Cross-judge, three options:
   - (a) Push each candidate as a branch/draft PR and dispatch `orca-stack revisar` to agy or codex per candidate: satisfies the existing family rule, but costs one PR and one judge per candidate.
   - (b) A read-only Claude judge inside the workflow: cheap, but same-family, a weaker check than upstream asks for.
   - (c) The `puente-gentle` consult as an extra opinion (read-only; Pi runs on Claude, so not a new family).
4. Pick and Graft: parent, inline, reading each candidate's branch diff.
5. Verify: the repo's `verificacion` commands.

Cheapest faithful version: steps 1, 2, 4, 5 in-process with judge (b); add (a) only when the task warrants a true cross-family check.

## Mapping for swarm

- Slices or race of read-mostly work (audit, exploration, measurement): in-process Workflow `pipeline(slices, ...)` or Agent calls. A `schema` replaces parsing `PASS|ISSUES|BLOCKED` text and makes the aggregate table deterministic; dropout and gap rules become plain JS. This is the closest match to upstream's background cloud workers.
- Writing swarm with independent slices that each deserve a PR: `orca-stack despachar` per sub-issue (one sub-issue per slice already matches the issue-lock model), with mixed agent families as race arms. Results come back as PRs; aggregation is the parent's `gh pr list` Monitor.
- A race on one brief across families is the awkward case under `despachar` (one issue = one worker); see conflicts 2 and 4.

## Contract conflicts noticed (for #130)

1. AGENTS.md: `main` "nunca implementás tickets"; arena candidates written by `main`'s subagents blur that line. Needs an explicit exception or a rule that candidates are throwaway.
2. One issue = one worker lock (`despachar` assignee check, worktree name `<repo>-<n>`) blocks N candidates of one task.
3. `despachar` refuses `un-agente` mode while the map wants arena/swarm in both modes: in-process primitives work in both, cross-family does not.
4. Contract "Despacho": a handoff, "no se lo supervisa" and "no armes el despacho a mano", versus arena/swarm needing synchronous aggregation of results.
5. Review rules: the reviewer must be another family and `revisar` needs `Implementador:` in a PR body; arena candidates are not PRs. A judge with a hidden rubric has no slot in the `## BLOQUEA` / `## SUGERENCIAS` format.
6. Project rule "No reviews in this repo for now": an arena judge is a review in effect.
7. Model/effort ownership: upstream keeps roles in a rules file; here `agentes.modelos` is personal config, and gears govern `main` and its own subagents but not dispatched workers. Candidates via `despachar` fall outside gears; in-process ones inside.
8. ODD Writer trigger covers parallel writers only with disjoint edit surfaces; arena candidates edit the same surface by design. Workflow also needs the user's opt-in.
9. PR-only into `ramaBase` (protected `main`): candidate branches must never reach it; only the grafted result goes through a PR.
10. Upstream swarm defaults to cloud workers; here `isolation: "remote"` or any remote destination needs explicit authorization per the global contract.

## Open questions

1. Is a same-family (Claude-only) judge acceptable for arena, or must it always be cross-family (forcing branches/PRs plus `revisar`)?
2. Should `despachar` gain a mode for N candidates of one issue (distinct worktrees, issue lock held once), or should candidates be sub-issues?
3. Can a Workflow script or Agent Bash step safely invoke `orca-stack revisar` / `codex exec` for a non-Claude judge? Needs a controlled trial.
4. Where do a candidate's rationale and the judge's rubric scores live (PR comment, file, Engram) so retros can use them?
5. Is `effort` per Agent/Workflow call honoured on the current plan and model set? Not verified without running.
6. Does the user want ultracode/Workflow as a dependency of this feature, or only Agent-tool fan-out?
