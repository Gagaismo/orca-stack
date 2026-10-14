# turn.step effort probe (task #136, map #118)

Run 2026-10-14 on Claude Code 2.1.299, model `claude-opus-5-5`, subscription auth, headless (`claude -p --plugin-dir`), with the throwaway mod in `turn-step-effort-probe/` (never in `mods/`, never released). The mod forces an effort on `main`'s requests from a file, optionally runs `$.command.run({ command: "effort", args })` at `session.start`, and logs every `turn.step` it sees with the usage the step returned (`turn-step-effort-probe/log.jsonl`). Runs 2-10 resume one session (`--resume`), so the prefix is the same and cache reads are comparable.

## Results

| Run | Setup | Main step: effort seen → sent | Cache read / created |
|---|---|---|---|
| 1 | baseline, fresh session | medium → medium | 0 / 44,552 |
| 2 | mod forces `low` | medium → low | 44,552 / 102 |
| 3 | no force | medium → medium | 44,654 / 43 |
| 4 | mod forces `xhigh` | medium → xhigh | 44,697 / 43 |
| 5 | mod forces `low`, main spawns a subagent | main: medium → low; subagent (`agentId` set): medium → medium | main 44,740 and 44,834 |
| 6 | launched with `--effort high` (an explicit choice) | high → high | 45,243 / 42 |
| 7 | `$.command.run` `effort high` | high → high; command answered "Set effort level to high (this session only)" | 45,285 / 215 |
| 9 | next process, no command | medium → medium | 45,549 / 257 |
| 10 | `$.command.run` `effort high`, main spawns a subagent | main high; subagent high | main 45,806 |
| 11 | `$.command.run` `effort ultracode`, fresh session | medium | - |

The transcript's assistant entries carry `"effort"` per request, and it records the rewritten value (`low`, `medium`, `xhigh` for runs 2-4), so the request carried the hook's level, not the session's.

## Answers

1. **A `turn.step` rewrite changes `main`'s effort.** `next({ ...e, effort })` sends the new level; the transcript records it.
2. **The cache survives it** on Opus 5.5 with a subscription: after each rewrite the whole prefix was read from cache (cache creation 43-102 tokens, the new turn only). Flipping low → medium → xhigh on consecutive turns never broke it. Not checked: other models, API key, Bedrock or Vertex, where `/effort` itself breaks the cache.
3. **The rewrite is per request and does not touch the session's setting.** `e.effort` always shows the session's level (medium in every forced run), so the preferred shape of "Which effort does each gear use?" works: the baseline effort is just the session's effort.
4. **The hook sees the human's explicit choice.** With `--effort high` and with `/effort high` (via `$.command.run`), `e.effort` arrived as `high`. Since the mod's own rewrite never shows up in `e.effort`, any change in `e.effort` comes from someone else; the mod need not tell them apart. Not run: an interactive human typing `/effort` mid-session (the `-p` runs cannot type it; Git Bash also turned `/effort` into a path, run 8).
5. **`turn.step` sees subagents' requests**, with `e.agentId` set. The mod must rewrite only when `e.agentId` is absent.
6. **A mod's rewrite on `main` does not reach subagents.** With `main` forced to `low`, a subagent on `main`'s model ran at the session's `medium`. A session-level change does reach them: after `/effort high` the subagent ran at `high` (run 10). This confirms the transcript observation from #127 for `/effort`, and shows the `turn.step` path keeps subagents at the baseline.
7. **`$.command.run({ command: "effort", args: "high" })` reaches the native `/effort`** and answers "Set effort level to high (this session only)". It does not persist as a default: `effortLevel` in `~/.claude/settings.json` did not change, and the next process started at `medium`. Run from `session.start` it took effect before the turn's first request. Whether it holds for the rest of an interactive session is implied by "this session only" but was not observed across several turns.
8. **`$.command.run` `effort ultracode` works too:** "Ultracode on (this session only): dynamic workflows on every task. Effort stays medium."
9. **`$.config.set` has no effort or ultracode row.** The relevant `/config` rows are `model`, `thinking` (locked) and `workflowKeywordTriggerEnabled` ("Ultracode keyword trigger"), which only gates the prompt keyword.

Side note: these `-p` sessions started at `medium` although `~/.claude/settings.json` sets `effortLevel: "high"`; why was not investigated.
