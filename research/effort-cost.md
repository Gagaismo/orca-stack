# Does xhigh cost less than high, and why?

Wayfinder research ticket #120 (map #118). Aggregates only; no transcript text. Rerun with `node research/effort-cost.mjs`.

**Short answer:** no. In the available data, `main`-style sessions at xhigh cost the same or more than at high, per turn and clearly more per session. The sample is small (14 xhigh sessions), so this is "no evidence of a saving", not a proof of a surcharge.

## Cutoff

Declared before the final aggregation. (Disclosure: I had seen one rough per-effort cut while building the script, so the cutoff is not blind. It was written down before the subset and paired cuts were run.)

"Effort has an effect on cost" counts only if **all** hold:

1. Pooled quota per turn differs by at least 15% between xhigh and high, and so does median quota per session, in the same direction.
2. The same direction shows in the orchestrators-only subset and in the same-projects subset.
3. Each arm has at least 10 sessions (below that, the verdict is "inconclusive").

"Effort has an effect on quality" would need a bounce (`Rebote`) rate that differs by at least 0.2 per session with at least 10 sessions per arm.

## Where the effort level is recorded

Every `assistant` event in a transcript (`~/.claude/projects/**/*.jsonl`) carries two top-level keys: `effort` and `perTurnEffort` (values seen: `low`, `medium`, `high`, `xhigh`). This is the effort in force for that turn, so a mid-session change is visible turn by turn. The script classifies a session by its dominant `perTurnEffort` when at least 90% of its turns share it, otherwise `mixed`. Not found: any settings snapshot or history of `settings.json`; it is not needed.

## Method

- Population: top-level session transcripts (sub-agent transcripts excluded). A session counts as `main`-style when its cwd is not a worktree (`.claude/worktrees`, `orca-workspaces`) and it has at least 20 assistant turns.
- A turn is one assistant message, deduplicated by `message.id` (a message is split across several events that repeat the usage).
- Tokens summed from `message.usage`: input, output, cache read, cache write.
- **Quota approximation** (the real quota formula is not published; this is an assumption): `input*1 + output*5 + cacheRead*0.1 + cacheWrite*1.25`, the public API price ratios. Cache reads are cheap per token but dominate volume, so the figure is sensitive to the cache-read weight.
- Turns, prompts, `Agent` calls and the average size of their prompts, `orca-stack despachar` commands and their length, and `orca-stack rebote` commands (bounces issued by that session).
- Controls: split by session length, by model, orchestrators only (session used `Agent`, `despachar` or `rebote`), and projects that have both high and xhigh sessions. Projects are anonymized P1, P2, ... in order of first appearance; the mapping is not stored.
- Bounces via `gh`: only 3 of the last 200 PRs carry a `Rebote:` comment, and a session cannot be mapped to PRs reliably, so the `rebote` commands in transcripts are the bounce measure.

## Sample

438 transcripts, 414 with usage, 240 `main`-style with at least 20 turns: high 128 sessions (35 projects, 20,133 turns), medium 87, mixed 8, xhigh **14 sessions (7 projects, 1,773 turns)**. Orchestrators only: high 40, xhigh 7. Same projects only: high 72, xhigh 5. Effort periods overlap in time (xhigh from 2026-07-29, high from 2026-07-30, both to 2026-10-13).

## Results

Per-turn values are pooled averages; "median" columns are medians over sessions.

| Subset | Effort | Sessions | Median turns | Out/turn | CacheR/turn | CacheW/turn | Quota/turn (pooled) | Quota/session (median) | Rebotes/session |
|---|---|---|---|---|---|---|---|---|---|
| All main-style | high | 128 | 99 | 624 | 286,552 | 3,345 | 35,956 | 2,138,295 | 0.13 |
| All main-style | xhigh | 14 | 134 | 1,129 | 249,584 | 6,040 | 38,162 | 4,468,011 | 0.00 |
| All main-style | medium | 87 | 48 | 697 | 152,255 | 3,343 | 22,892 | 942,218 | 0.00 |
| Orchestrators only | high | 40 | 143 | 635 | 262,194 | 3,014 | 33,164 | 3,617,422 | 0.42 |
| Orchestrators only | xhigh | 7 | 134 | 1,040 | 267,553 | 4,047 | 37,018 | 3,798,366 | 0.00 |
| Same projects only | high | 72 | 151 | 604 | 304,183 | 3,423 | 37,717 | 4,021,394 | 0.24 |
| Same projects only | xhigh | 5 | 134 | 980 | 249,111 | 2,549 | 32,999 | 4,468,011 | 0.00 |
| 100-299 turns | high | 41 | 169 | 618 | 216,015 | 2,879 | 28,295 (median) | 4,256,225 | 0.07 |
| 100-299 turns | xhigh | 7 | 134 | 959 | 230,140 | 2,549 | 32,294 (median) | 4,643,581 | 0.00 |
| Model opus-5-5 | high | 105 | 90 | 628 | 261,341 | 3,543 | 33,705 | 1,943,755 | 0.16 |
| Model opus-5-5 | xhigh | 6 | 134 | 983 | 240,241 | 2,560 | 32,142 | 4,468,011 | 0.00 |

Brief and ticket specificity (proxies, not full text): average `Agent` prompt is 3,821 chars at high vs 2,898 at xhigh (all) and 3,537 vs 2,638 (same projects); `Agent` calls per session 0.9 vs 1.6 (all), 2.9 vs 3.3 (orchestrators). Average `despachar` command length 1,412 chars (high) vs 3,086 (xhigh); only a handful of dispatching sessions per arm, so nothing can be read from it.

Full tables, including model and length splits: run the script.

## Verdict against the cutoff

- Condition 1 (>=15% difference, same direction): output per turn is about 60-80% higher at xhigh in every subset, but pooled quota per turn is within +6% (all), +12% (orchestrators), -13% (same projects). Median quota per session is about 2x higher at xhigh (all), +5% (orchestrators), +11% (same projects). Directions are mixed on the per-turn figure, so the cutoff is **not met for "xhigh is cheaper"**; the per-session figure points to xhigh costing more.
- Condition 3: xhigh has 14, 7 and 5 sessions in the three subsets. Only the all-sessions comparison reaches 10; the other two are **inconclusive** by the cutoff.
- Quality: 0.00 rebotes per xhigh session vs 0.13-0.42 at high, but xhigh has 7 orchestrator sessions, below the minimum. **Inconclusive.**

Conclusion: the claim "xhigh costs less than high" is **not supported**. If anything, xhigh produces more output tokens per turn (expected: more reasoning), and cache read volume dominates the quota so the per-turn totals end up similar. Why a saving might still exist in practice (fewer turns for the same task, fewer bounces) cannot be shown here: xhigh sessions are not shorter (median 134 vs 99 turns).

## Confounders

- Task type is not controlled: there is no task label in a transcript. xhigh might be used on harder tasks.
- Session length drives quota (cache reads grow per turn with context). xhigh sessions are in the 100-299 turn band mostly; the length split shows high at the same band at 28,295 median quota per turn vs 32,294 for xhigh.
- Cache misses and cache TTL (idle gaps) change cache-write volume; not controlled.
- Model mix: xhigh is on opus only; high includes some sonnet; opus-5-5 split above removes that.
- Few xhigh sessions, concentrated in 7 projects; three projects dominate high. Same-project comparison has only 5 xhigh sessions.
- "main-style" is a proxy (non-worktree cwd), not proof the session was the orchestrator; the orchestrator subset is also a proxy.
- Quota weights are an assumption. Changing the cache-read weight changes the per-turn figure; tokens are reported separately for that reason.
- Bounces are issued by sessions that dispatch; sessions that never dispatched cannot show a difference.

## How to rerun

```
node research/effort-cost.mjs                 # prints aggregate tables
node research/effort-cost.mjs --json          # same data as JSON
node research/effort-cost.mjs <projectsDir> --min-turns=50
```

Reads `~/.claude/projects` by default, no dependencies, prints aggregates only (no text, no paths, anonymized project labels). For per-gear telemetry in retros, filter by `perTurnEffort` or reuse `parseSession`.

## Open questions

- Re-run once there are 30+ xhigh `main` sessions on comparable tasks; ideally record a task label per session.
- Going forward, record effort and task class in the feature document or session summary so tasks can be matched; the transcript already gives effort per turn.
- Does a shift mid-session (visible per turn) cost cache? The `mixed` sessions are too few (8) to say; this belongs to the cache-cost-of-shifting question in the map.
- Is the real quota weighting of cache reads close to 0.1? Anthropic does not publish it; the conclusion on per-turn cost depends on it.
