# Effort knobs for `main` (research for #119, map #118)

Researched 2026-10-13 against Claude Code 2.1.296 (`claude --version`). Primary sources: code.claude.com docs, `claude --help`, the `plugin-authoring` type file `claude-code.d.ts` shipped with this build ("mod types" below), and this repo. "Verified" means read in a primary source or observed on this machine; "unverified" means inferred or not exercised.

## 1. What can change `main`'s effort (and model) mid-session, and from where?

**Answer.**

| Channel | Effort | Model | Timing | Source |
|---|---|---|---|---|
| `/effort <level>` or slider (human) | yes | no | mid-session; `Enter` saves it as default, `s` applies to this session only (v2.1.257+) | model-config |
| `/model` picker (human) | slider | yes | mid-session | model-config, prompt-caching |
| `--effort <level>`, `--model` | yes | yes | launch only | `claude --help` |
| `CLAUDE_CODE_EFFORT_LEVEL` env var | yes | no | read at launch; counts as an "explicit choice" and beats subagent frontmatter and the Agent `effort` parameter | model-config, sub-agents |
| Settings: `effortLevel`, `modelSettings`, `ultracode`, `model` | yes (`low`..`xhigh`, never `max`) | `model` key | defaults for sessions; a running session is not documented to re-read them (unverified) | model-config |
| Remote Control (phone or browser) | yes | no | mid-session, v2.1.234+ | model-config |
| **Mod `turn.step` hook** | **yes, per request** (`next({ ...e, effort })`) | **yes** (`next({ ...e, model })`) | rewrites the request about to be sent | mod types `TurnStepInput` |
| Mod `$.command.run({ command, args })` | indirect (runs a slash command) | indirect | queued, runs when the session is idle | mod types |
| Mod `$.config.set({ key, value })` | only if `/config` has such a row (unverified) | same | immediate | mod types |
| Classic settings hooks (PreToolUse etc.) | **no**: `effort` is read-only input (`effort.level`, env `CLAUDE_EFFORT`) | **no**: `PreModelSwitch` can only block or confirm a switch | - | hooks docs |
| Skill or command frontmatter `model` | no | yes, for that turn | when invoked | prompt-caching |
| Skill or subagent frontmatter `effort` | yes, while active | no | when invoked | model-config, sub-agents |

Evidence:
- `claude --help`: `--effort <level>   Effort level for the current session (low, medium, high, xhigh, max)`; also `--model <model>` and `--settings <file-or-json>`.
- https://code.claude.com/docs/en/model-config, "Precedence": "1. An explicit choice: the `CLAUDE_CODE_EFFORT_LEVEL` environment variable, launching with `--effort`, or `/effort` in the session; 2. Your settings ...; 3. The model's default effort". Mid-session: "You can run it while Claude is working ... Claude Code applies the new level to the next request in the turn."
- Mod types, `TurnStepInput.effort`: "How hard the request asks the model to think ... rewritable". Hook doc: "`next({ ...e, model })` or `effort` sends another; the turn, the index and the message count are pinned." It fires for main and for subagents (`e.agentId` absent means main).
- https://code.claude.com/docs/en/hooks (only the first 100k of 268k characters read): hooks can set `additionalContext` and `updatedInput`; "There is no `$CLAUDE_MODEL` environment variable"; `effort` is a read-only common input field.

Confidence: high for rows with a doc quote; medium for `turn.step` (read from types, not run); low for `$.config.set` on effort (no row confirmed).

## 2. Can a mod or hook trigger a slash command?

**Answer.** A classic settings hook: no. Nothing in the hooks docs runs a slash command; `UserPromptExpansion` only observes or blocks expansion. A mod: yes in principle. Mod types, `$.command.run`: "Runs a slash command as if the person typed `/command args` ... queued and run once the session is idle. It runs through every hook but the calling one ... Rejects an unknown name, and inside a hook the turn is waiting on." The example uses the built-in `status`. `$.prompt.submit({ text })` is a second route (queues a prompt that starts its own turn), but whether slash-prefixed text is dispatched as a command that way is unverified.

Not verified: that `$.command.run({ command: "effort", args: "high" })` reaches the built-in `/effort`; whether it saves the level as the user default (what `Enter` in the slider does); whether a session-only form exists (the slider's `s` has no documented command syntax).

Confidence: medium (types read, not executed).

## 3. What does "ultracode" switch on, and can a mod or setting toggle it?

**Answer.** Ultracode is not an effort level. https://code.claude.com/docs/en/model-config: "Ultracode is a Claude Code setting rather than a model effort level: with it on, Claude orchestrates dynamic workflows for substantive tasks, at whichever effort level the session runs at." The workflows page adds that Claude plans a workflow for each substantive task, and that the large-workflow warning, the concurrent-subagent limit and the first-launch approval in auto mode are skipped. Each request costs more tokens by design.
- On: `/effort ultracode`; `--effort ultracode` (starts at `xhigh`); settings `"ultracode": true`; Agent SDK `effortLevel: "ultracode"`. Off: `/effort ultracode off` (v2.1.284+) or unset the setting.
- On/off "leaves the effort level unchanged". `CLAUDE_CODE_EFFORT_LEVEL` and the persisted `effortLevel` "don't accept `ultracode`".
- Unavailable when workflows are disabled (`"disableWorkflows": true`, `CLAUDE_CODE_DISABLE_WORKFLOWS=1`) or the model lacks `xhigh`.
- Separate: the word `ultracode` inside one typed prompt requests a workflow for that prompt only (not in `-p` or webhooks). `ultrathink` deepens reasoning for one turn without changing the session effort.
- Mod control: plausibly via `$.command.run({ command: "effort", args: "ultracode" })`, unverified. `$.settings` has only `read`, so a mod cannot write the setting.

Confidence: high on semantics (doc quotes); low on mod control.

## 4. Does changing effort mid-session invalidate the prompt cache?

**Answer.** It depends on the model. https://code.claude.com/docs/en/prompt-caching, "Changing effort level": "On most models, changing the effort level mid-session means the next request reads the entire conversation history with no cache hits. While the cache is still warm, Claude Code asks you to confirm the change first. On Opus 5.5, Sonnet 5.5, Haiku 5.5, and Fable 5.1 with an API key or a Claude subscription, changing effort keeps the cache, and Claude Code applies the new level without asking." Even on those models it does invalidate on Amazon Bedrock, Google Cloud's Agent Platform, a Claude apps gateway, with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, or under a HIPAA configuration.
- A model switch always invalidates ("Each model has its own cache").
- Ultracode on/off is not in the list of invalidating actions; it changes behavior, not the request prefix (inferred, unverified).
- TTL: main conversation 1 h on a subscription within plan usage, otherwise 5 min; subagents and workflows 5 min unless `subagentPromptCacheTtl` is set. `mods/reloj-cache/hooks/register.ts` hardcodes a 1 h TTL.
- Open: whether a `turn.step` effort rewrite follows the same cache path as `/effort` (same request field, but unverified). Flipping effort back and forth per step would miss the cache each time on an affected model.

Confidence: high for `/effort` (doc quote); low for `turn.step`.

## 5. Does the Agent tool's `effort` parameter take effect for subagents?

**Answer.** Yes, with limits. https://code.claude.com/docs/en/sub-agents: "When you ask Claude to run a non-fork subagent at a specific effort level, it can also pass an `effort` parameter for that invocation. The parameter overrides the `effort` field and stays in effect when the subagent is resumed. The `CLAUDE_CODE_EFFORT_LEVEL` environment variable takes precedence over both. The per-invocation parameter requires Claude Code v2.1.292 or later." Local version is 2.1.296, so it is available. It does not apply to forks (they inherit the parent's model and context; mod types: "`model` is ignored"). The Agent tool schema in this very session lists `effort` (low..max) and says to set it only when the user or instructions explicitly ask for a specific level, which constrains how `main` may use it.
- Mod angle: `agent.spawn` hooks can rewrite `model` (`AgentSpawnInput.model`); a `turn.step` hook sees subagent steps (`e.agentId`) and can rewrite their effort.
- Not observed: I did not spawn a subagent to watch the effect. It is documented, not observed here.

Confidence: high (doc); observation pending.

## 6. How does a `claude` worker get its effort at launch?

**Answer.** Three routes; the first is verified on this machine:
1. `--effort <level>` (shown by `claude --help`), e.g. `claude --dangerously-skip-permissions --model X --effort high`.
2. `CLAUDE_CODE_EFFORT_LEVEL=<level>` in the environment (also accepts `auto`); outranks `/effort` and settings.
3. `--settings '{"effortLevel":"high"}'` or the `effortLevel` key (never `max`).

Current code: in `src/despacho.mjs`, `launcherFor` returns `${bin} --dangerously-skip-permissions${model ? ` --model ${model}` : ''}` for `claude` and `agy`, with no effort. `modelFor` already yields `effort` (from `esfuerzo`) but only the codex branch uses it. So claude workers run on the model's default effort: `medium` on Opus 5.5, Sonnet 5.5 and Haiku 5.5, `high` on most others, `xhigh` on Opus 4.7 (model-config, precedence list).

Caveats: an unsupported level falls back to the highest supported level at or below it (`xhigh` runs as `high` on Opus 4.6). `agy` shares the claude branch but is not Claude Code, so `--effort` must not be added to it blindly (unverified). Whether the wrapper script (`wrapperFile`) forwards the flag unchanged was not checked.

Confidence: high for the flag; medium for the wrapper.

## Implications for gear shifting

- A mod can shift effort two ways: queue a slash command (`$.command.run`; discrete, visible in the transcript, may persist as the human's default) or rewrite `effort` per request in a `turn.step` hook (continuous, touches no setting, persists nothing, but unverified end to end). Prototype both before choosing.
- `turn.step` also reaches the subagents `main` spawns (`e.agentId`) and `agent.spawn` can rewrite their `model`. That fits the map's rule that a gear governs `main` and its own subagents; dispatched Orca workers are separate processes a mod never sees.
- A classic hook cannot shift gears. It can read the level (`effort.level`, `CLAUDE_EFFORT`) and inject `additionalContext`, so a gear's conduct (posture text) can live in hooks while its effort half needs a mod.
- Cache cost depends on the model. On Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 via API key or subscription an effort shift keeps the cache; on other models, on Bedrock or Vertex, under HIPAA or through a gateway it re-reads the whole history. A gear shift should warn when the cache is warm and the model is not in the free list; `reloj-cache` already tracks cache age.
- Do not model ultracode as a gear: it is a behavior switch (workflows, no concurrency limit, much higher token use) and a mod cannot write its setting. "Proactive" is better expressed as posture text plus effort, leaving ultracode to the human.
- Worker effort is a separate, small change: add `--effort` to the claude branch of `launcherFor`. Prefer the flag over `CLAUDE_CODE_EFFORT_LEVEL`, which would also override any per-subagent effort.

## Open questions

1. Does `$.command.run({ command: "effort", args: "high" })` reach the built-in `/effort`, and does it persist the level as the user default or apply it per session? Test in a throwaway `--plugin-dir` mod.
2. Does a `turn.step` effort rewrite behave like `/effort` for caching? Measure `cache_read_input_tokens` (statusline `prompt_cache` fields) before and after.
3. Does `$.config.list()` expose an effort or ultracode row that `$.config.set` can write?
4. Does the Agent tool's `effort` parameter change a spawned subagent's requests? Observe with a `turn.step` hook logging `e.effort` for `e.agentId`.
5. Does the orca wrapper script forward `--effort` unchanged, and is it safe for `agy`?
6. The hooks page was read only in part (100k of 268k characters), so a hook output field that sets effort cannot be fully ruled out, though none was found.
