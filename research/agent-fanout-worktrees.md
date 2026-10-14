# Agent fan-out in isolated worktrees

Ticket: #151 (map #118, blocks #131). Read-only research: no agent was dispatched, no Workflow ran, the CLIs were run only with `--version` / `--help` / `features list`.
Prior findings: `origin/research/arena-swarm-mechanism` (`research/arena-swarm-mechanism.md`).
Versions inspected locally (2026-10-14): claude 2.1.299, codex-cli 0.162.1, agy 1.3.5, pi 1.2.0 with gentle-pi 4.2.0. `cm` / Command Code is not installed on this machine.

## 1. Per-agent capability

How orca-stack launches each agent: `src/despacho.mjs:131-150` (`launcherFor`). claude and agy get `--dangerously-skip-permissions [--model]` (no effort flag); codex and codex-cc get `--model`, `-c model_reasoning_effort=...`, approval `never`, sandbox `danger-full-access`; pi runs headless `pi -p ... --model ... --thinking ...`.

Legend: Yes = documented or observed; UNKNOWN = MUST VERIFY with a controlled trial.

| Agent | Can spawn subagents? | Isolated worktree per subagent? | Subagent model / effort choice | Verdict for arena |
|---|---|---|---|---|
| claude (Claude Code) | Yes. A subagent can spawn subagents, 3 layers deep by default, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` changes it (sub-agents doc, "Can subagents spawn subagents"). | Yes. `isolation: "worktree"` on the Agent call or in a custom agent's frontmatter; a Workflow `agent(..., {isolation:'worktree'})` too (workflow-authoring reference, `agent` opts). | Yes, Claude models only. Per call: `model` (`sonnet`, `opus`, `haiku`, `fable`, or a full id) and `effort` (`low`..`max`; per-call `effort` needs v2.1.292+). Order: per-call param, frontmatter, `CLAUDE_CODE_SUBAGENT_MODEL`, parent model. Env `CLAUDE_CODE_EFFORT_LEVEL` beats both effort settings. Source: https://code.claude.com/docs/en/sub-agents (Model, Effort). | Yes |
| codex (OpenAI Codex CLI) | Yes. "Current Codex releases enable subagent workflows by default"; local `codex features list` shows `multi_agent` stable/true, `worktrees` stable/true. Source: https://learn.chatgpt.com/docs/agent-configuration/subagents (redirect of developers.openai.com/codex/subagents). Depth limit: not stated. Cap: `agents.max_concurrent_threads_per_session`. | UNKNOWN for subagents. The subagents page says "Subagents inherit your current sandbox policy" and has no cwd/worktree field. `codex exec --help` lists `--worktree` ("Run the session in a new managed Git worktree") for a whole session, not for subagents. The "Git worktrees" page 404ed on the guessed URL, so its content is unread. | Yes. Custom agent TOML in `.codex/agents/` or `~/.codex/agents/` takes `model` and `model_reasoning_effort`; resolution is the agent file, then explicit spawn value, then `[agents]` default, then parent. Same page. | Yes for model/effort; isolation UNKNOWN. A parent could run `codex exec --worktree` per candidate through shell, untested. |
| codex-cc (Codex through Command Code) | Same binary as codex (`src/despacho.mjs:134-143` only adds `-c model_provider=cc ...` pointing at `https://api.commandcode.ai/provider/v1`). So the same subagent features apply in principle. Whether Command Code's provider honours a different model per subagent: UNKNOWN. | Same as codex: UNKNOWN. | Same TOML fields as codex. Model ids must be ones the `cc` provider serves: UNKNOWN. | Same as codex, plus the `preguntarAntes` gate (`.orca-stack.json`) |
| agy (Google Antigravity CLI) | Yes. The CLI "automatically spawns subagents"; custom subagents set `subagent: true` and the primary agent calls `invoke_subagent`; `/agents` panel monitors them. Sources: https://antigravity.google/docs/cli/features/ , https://antigravity.google/docs/subagents/ . `agy --help` has no subagent flag (only the `agent`/`agents` subcommands, which list agents). | Documented only for the Antigravity app: workspace modes `inherit` / `branch` ("create an isolated Git worktree") / `share`. The subagents page says nothing on workspace modes for the CLI tab, and gives no worktree path or branch naming. So for agy: UNKNOWN. | Partly. Frontmatter `model` is a tier only: `inherit`, `flash` or `pro`. No `effort` field on that page. `agy --effort` and `--model` exist for the session (`agy --help`) but those are the session's, not a subagent's. | Not proven. Do not promise arena on agy until the CLI honours `branch`. |
| pi (Pi + gentle-pi) | Yes. gentle-pi exposes `subagent_run`, `subagent_continue`, `subagent_status` (`~/.pi/agent/npm/node_modules/gentle-pi/docs/gentle-agents-activity.md:3,240`); agents live in `~/.pi/agent/agents/*.md`. | No built-in worktree creation found. gentle-pi's own rule is: "parallel writers only with disjoint Allowed edit surfaces (runtime-enforced) or isolated worktrees" (`assets/orchestrator-delegation.md:179`), i.e. the parent must provide the worktrees. A `subagent_run` parameter for cwd/worktree: UNKNOWN (not found in `extensions/gentle-agents.ts`). Also `gentle-ai-worker.md` says "Never delegate or invoke `subagent_*` tools", so a worker subagent cannot fan out further. | Yes, by agent file frontmatter: `model:` (any provider/id, e.g. `commandcode/xiaomi/mimo-v2.6-pro`) and `thinking:` (`~/.pi/agent/agents/gentle-ai-worker.md:4-5`). Per-call override: UNKNOWN. Profiles can replace routing (`extensions/gentle-agents.ts` ~1630). | Model/effort yes; isolated writes only if main hands each candidate its own worktree |

Consequence for the brief: only claude has a documented, end-to-end "subagent writes in its own worktree with a chosen model and effort". For codex, codex-cc, agy and pi the brief must say "arena: not supported" (or "supported only with worktrees you create yourself") until a trial proves otherwise.

## 2. Claude Code worktrees: location and branch

### Documented (https://code.claude.com/docs/en/worktrees)

- `claude --worktree <name>`: "created under `.claude/worktrees/<name>/` at your repository root, on a new branch named `worktree-<name>`".
- Subagents: "Each subagent gets a temporary worktree that Claude Code removes automatically when the subagent finishes without changes; a worktree with changes stays on disk" until a periodic sweep (`cleanupPeriodDays`). They "use the same base branch as `--worktree`": the repo default branch (fresh `origin/HEAD`) unless `worktree.baseRef` is `"head"`. `worktree.baseRef` cannot be a branch name.
- Docs tip: "Add `.claude/worktrees/` to your `.gitignore` so worktree contents don't appear as untracked files in your main checkout."
- Custom location only via a `WorktreeCreate` hook, which "replaces default git behavior" and prints the path on stdout; it is also what runs for `isolation: "worktree"` (https://code.claude.com/docs/en/hooks, WorktreeCreate). The SVN example reads the name from stdin JSON (`jq -r .name`). Whether the hook receives or may set a branch name: UNKNOWN (the hooks page section was not fully read).
- The Agent tool schema in this session has `isolation` (`worktree`|`remote`), `model`, `effort`, `subagent_type`; no branch or path parameter. The Workflow `agent()` opts are `label, phase, schema, model, effort, isolation: 'worktree', agentType`; no branch or path (workflow-authoring reference). So a custom name such as `arena/<artifact>/<n>` cannot be set through either API.

### Observed (this research agent is itself an Agent-tool `isolation: "worktree"` subagent)

- `git worktree list` shows `C:/Users/lautaro/Documents/orca-stack/.claude/worktrees/agent-a227390b38dff1127  [worktree-agent-a227390b38dff1127] locked`.
- So an Agent-tool subagent worktree is `<repo root>/.claude/worktrees/agent-<id>` on branch `worktree-agent-<id>`, locked while the agent runs (matches "git worktree lock" in the worktrees doc).
- `git check-ignore -v` reports `.git/info/exclude:11:.claude/worktrees/` as the ignore source. The repo's tracked `.gitignore` does NOT list `.claude/worktrees/` (checked on `origin/main`, ignore list: `node_modules/`, `*.log`, mod types, `.DS_Store`, `.atl/`, `.orca-stack.local.json`, `odd/`). It is ignored here only because of a line in the shared `.git/info/exclude`; origin of that line is UNKNOWN, and a fresh clone would not have it.

### Could it land inside a worker's own worktree?

- Workers live at `~/orca/workspaces/orca-stack/orca-stack-<n>` (`git worktree list`), outside the main checkout. A subagent launched there resolves "repository root" to either that worktree's top level or the main checkout. The docs say "at your repository root" and that the enforcement covers "the main checkout a linked worktree is linked from", but do not say which. UNKNOWN / MUST VERIFY (needs one real trial from a worker worktree; I did not run one because that means spawning an agent).
- If it resolves to the worker's top level, the candidate worktree would sit at `<worker worktree>/.claude/worktrees/agent-<id>/`, inside the worker's tree. Nothing in the tracked `.gitignore` would hide it.
- Is the nested-repo risk real? Mechanically yes in that case: a directory containing a `.git` entry (a linked worktree has a `.git` file) is seen by `git add -A` as an embedded repository and is staged as a gitlink (mode 160000) with git's "adding embedded git repository" warning, which then rides into the PR. This is git's documented behaviour for embedded repos (`git add` docs); I did not reproduce it in this repo. It only fires if (a) the nested path is not ignored and (b) a candidate worktree still exists when the worker commits (changed worktrees persist; unchanged ones are removed).
- Also relevant: the worker's `git worktree list` is shared, so candidate branches `worktree-agent-*` appear in the common repo and could be pushed by mistake with `git push --all`/`--mirror`.

### Prevention (cheapest first)

1. Add `.claude/worktrees/` to the tracked `.gitignore` of every repo orca-stack manages (the doc's own recommendation). One line, covers any worker, any path under the top level.
2. Or have `despachar` append it to the worker's `info/exclude` the way it already does for the Pi pin (`src/despacho.mjs:473-497`, `PIN_REL`); that file is per clone, so one write covers all worktrees of the clone. Note the existing code guards against a `.gitignore` negation overriding it.
3. Brief rule: the worker stages explicit paths (not `git add -A`) and checks `git status --short` / `git ls-files -s | grep ^160000` before committing.
4. If a deterministic location or name is needed (`arena/<artifact>/<n>`): create the worktree outside the worker's tree with `git worktree add <outside path> -b arena/<artifact>/<n> <base>` and run the candidate there (the docs recommend plain git for "a specific existing branch or place the worktree outside the repository"), or have the candidate rename its branch after creation (`git branch -m`, untested), or use a `WorktreeCreate` hook (branch control UNKNOWN). Note `worktree.baseRef` accepts only `fresh` or `head`.

## Open questions

1. Where does `isolation: "worktree"` put the worktree when the session's cwd is a linked worktree (a worker at `~/orca/workspaces/...`): under that worktree's `.claude/worktrees/` or under the main checkout's? One trial from a worker worktree answers it (needs the human's OK to spawn an agent).
2. Who wrote `.claude/worktrees/` into `.git/info/exclude` in this clone (Claude Code itself, Orca, or the user)? If Claude Code does it on first use, risk 1 is already mitigated for most clones; if not, it must be added.
3. Does a `WorktreeCreate` hook receive a branch name or only `name`, and can it return a branch? Would let `arena/<artifact>/<n>` be set without leaving the Agent/Workflow API. Read the full hooks reference, section WorktreeCreate.
4. Does `git add -A` in a worker really stage a candidate worktree as a gitlink? Reproduce once in a scratch repo to confirm the warning and mode.
5. codex: does a subagent get its own worktree (the "Git worktrees" doc page was not read; `worktrees` feature is stable)? Does depth have a limit?
6. codex-cc: does Command Code's provider honour per-subagent `model` values and which ids?
7. agy: does the CLI (not the app) honour subagent workspace mode `branch`, where do those worktrees land, and is there any effort control?
8. pi: does `subagent_run` take a cwd or worktree, and can the model/thinking be overridden per call?
9. The `agent.spawn` mod hook mentioned in the sub-agents doc ("If an installed mod sets a model in its `agent.spawn` hook, Claude Code uses that model in place of the per-invocation parameter") could override candidate models in this repo's mods; check `mods/` before relying on per-call `model`.
