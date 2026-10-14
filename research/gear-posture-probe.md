# Gear posture delivery probe (task #153, map #118)

Run 2026-10-14 on Claude Code 2.1.299, model `claude-opus-5-5`, subscription auth, with the throwaway mod in `gear-posture-probe/` (never in `mods/`, never released). The mod writes a posture (`POSTURA-PROBE <gear>`, 403 to 1,056 characters) through the mechanism a `mode.txt` file names, registers a `/marcha` command, draws an `AbovePrompt` band and a `$.ui.status` line, and logs every `turn.step` of `main` with its usage (`gear-posture-probe/log.jsonl`, sanitized: attachment texts dropped except ultracode's).

Three drivers: `run.sh` (one headless `claude -p` per turn, `--resume` between them), `driver.js` (several turns in one headless process through `--input-format stream-json`, sending each prompt after the previous `result`, and changing files between turns), and an interactive session in an Orca terminal (labels `INT*` in the log). All runs used the scratchpad as working directory, so the probe sessions stay out of this repo's transcripts.

## Results

Cache columns are `cache_read_input_tokens / cache_creation_input_tokens` of `main`'s request; a plain "Reply only OK." turn with nothing injected writes 34-38 tokens.

| Run | Mechanism | What happened at the shift | Cache at the shift turn | What the model saw after it |
|---|---|---|---|---|
| A3-A5 | `prompt.compose` section, `scope: 'session'`, one `claude -p --resume` per turn | the hook returned the Proactive text | 59,068 / 38 | the Medium text, in the system prompt |
| I | same, several turns in one process | same | 59,515 / 38 | Medium |
| J | same, plus `$.ui.invalidate('prompt.section')` at `prompt.submit` | same | 59,575 / 38 | Medium |
| K | same, with a new section id per gear | the hook returned `gear-probe:postura-proactive` | 57,842 / 38 | Medium |
| INT1b | same, interactive session, `/marcha proactive` | band and status line switched at once | 76,568 / 112 | Medium |
| INT2 | interactive `/clear` | new conversation | 27,078 / 35,354 (new prefix) | Proactive, in the system prompt |
| INT3 | interactive `/marcha lazy`, then `/compact` | compaction | after it: 27,078 / 25,849 | Lazy, in the system prompt |
| Q | `prompt.context` block, `$.ui.invalidate('prompt.context')` on the shift | the hook ran again next turn | 57,737 / 38 | Medium, in the first user message |
| L | `/marcha` answers `{ text, context: [posture] }` | posture recorded as a hidden user message | 57,757 / 508 | Proactive, "in a message" |
| L, N | same, then `/compact` | compaction | - | the summary kept the posture in both runs (L had quoted it just before) |
| N | same, plus `classic.SessionStart` returning the posture as `additionalContext` | the hook fired with `source: 'compact'` | - | the summary's copy and the hook's message |
| M | `classic.UserPromptSubmit` `additionalContext` every turn | Proactive, then Lazy | 379 per turn (Proactive), 289 (Lazy) | the posture on every turn |

## Answers

1. **The system prompt is fixed per conversation.** `prompt.compose` fires before every turn and its answer is ignored until the conversation is rebuilt: the session's start, `/clear` or a compaction. Neither `$.ui.invalidate('prompt.section')` nor a new section id changes that, interactive or headless, and a resumed process sends the prompt it recorded. The same holds for a `prompt.context` block: the first user message is recorded, so a new answer does not reach the model. A shift through either costs nothing in cache because it does not take effect.
2. **`modo-autonomo` is affected.** Its instructions section, `Modo autónomo activo. Meta: ...`, never reaches the model when `/autonomo` is turned on mid-session: asked right after `/autonomo prueba-del-probe`, the model found no such text (INT1b). Only the `classic.Stop` reminder, which names `[AUTONOMO-LISTO]`, reaches it. The ticket's premise "modo-autonomo already toggles one this way" does not hold.
3. **A message at the shift works and keeps the cache.** `/marcha`'s `command.run` answer `{ text: 'Marcha: <gear>', context: [posture] }` records the posture as a hidden user message right after the command's row; the next turn read the whole prefix from cache and wrote about 470 tokens beyond a plain turn (the posture plus the command's rows). It takes effect on the next turn and stays in the transcript, so `--resume` keeps it. A later shift adds another message; the earlier ones stay in the history, so each posture must say it replaces any earlier one, Medium's included.
4. **Compaction keeps it only by luck, unless re-injected.** The summary is model-written; it kept the posture in both runs, but nothing guarantees it. `classic.SessionStart` fires after a compaction with `source: 'compact'` (also `startup`, `resume`, `clear`), and its `additionalContext` puts the current posture back as a message (N).
5. **Per-turn injection keeps the cache but grows the context.** Every turn carried the posture again: about 340 tokens per turn for Proactive (1,056 characters) and 250 for Lazy (728), each one kept in the history and read again on every later request.
6. **The transcript marker.** The command's row is stored as `{"type":"system","subtype":"local_command","content":"<local-command-stdout>gear-probe: Marcha: proactive</local-command-stdout>","commandRun":{"command":"marcha","args":"proactive","plugin":"gear-probe"}}`. A plugin that is not bundled with Claude Code has its name before the text, so the model and the transcript read `<plugin>: Marcha: <gear>`, not a line starting with `Marcha:`; `commandRun` carries the command and its arguments as fields.
7. **Session id.** `$.session.id()` returns the transcript's id. `--resume <id>` and `--continue` keep it (P1, P2). `/clear` fires `session.end` with `reason: 'clear'` and the old id, then `classic.SessionStart` with `source: 'clear'` and the new id; no `session.start` fires (INT2). On `--continue`, `classic.SessionStart` still saw a provisional id (`08492bdb...`) while `session.start` saw the continued one, so read the id from `session.start` or later.
8. **Where the gear lives.** `$.state` lasts one process: it survives a hot reload, is empty after `--resume` in a new process and after `/clear`. `$.store` keyed by session id survived the new process (`storeGear: proactive` in P1). After `/clear` the band (drawn from `$.state`) fell back to Medium, but the status line kept the old session's gear: nothing redraws it, so the mod must, on `session.end` with `reason: 'clear'` (which runs under a managed organization too) or on `classic.SessionStart` with `source: 'clear'`.
9. **A mod can see ultracode, two ways.** A `command.run` hook on `{ command: 'effort' }` sees `args: 'ultracode'` when the human runs it, at once. A `prompt.attachment` hook sees `ultra_effort_enter` ("Ultracode is on: optimize for the most exhaustive, correct answer...") on the next request, and `ultra_effort_exit` ("Ultracode is off — the Workflow tool's standard opt-in rule applies again.") when a resumed process starts without it; the history's attachments are asked again on resume and after a hot reload, in order, so the latest one tells the state. `$.settings.read()`, `e.effort` (it stays at the session's level) and the system-prompt sections show nothing. Ultracode is per process: a resumed session starts with it off. Running `/effort ultracode` again leaves it on.
10. **The band and the status lines coexist.** An `AbovePrompt` band draws above the prompt box, with a collapse control at its right; `$.ui.status` lines draw below the prompt, one per plugin, each prefixed `⚠ <plugin>:`. The probe's band, its own status line, `reloj-cache`'s `caché: 60 min` and `modo-autonomo`'s `AUTÓNOMO → prueba-del-probe` showed together without overlap (INT1b). Theme keys (`suggestion`, `permission`, `success`, `warning`) and raw colors (`blue`, `green`, `yellow`, `#FFBF00`) were all accepted, with no refusal line; how each hue looks is under Colors. Status lines reorder when one of them changes.
11. **Managed organizations.** `claude plugin validate` warns that hooks on `prompt.compose`, `prompt.context`, `prompt.attachment`, `classic.SessionStart` and `classic.UserPromptSubmit` do not run in a plugin a person installs where an organization manages Claude Code. `command.run`, `turn.step` and `ui.render` are not on that list, so the message at the shift and the band work there; the re-injection after a compaction and the ultracode attachment do not.

## Colors

Checked by eye in Lautaro's terminal (Orca, `"theme": "dark"`):

| Swatch | Drew as |
|---|---|
| `suggestion`, `permission` (theme keys) | pale lavender, close to plain text: not a clear blue |
| `blue` | blue |
| `success` (theme key), `green` | green, alike |
| `warning` (theme key), `yellow`, `#FFBF00` | amber, alike |

So Medium and Proactive can follow the person's theme (`success`, `warning`), while no tested theme key gives Lazy a clear blue; `ide`, `planMode` and `autoAccept` were not tried. The `$.ui.status` lines also draw in amber, with a `▲` glyph, the same hue as a Proactive band. With ultracode on, the prompt box's border carries an `ultracode` label.

## Open after this probe

- `/rewind` to a point before a shift drops the posture message from the context while `$.store` and the band keep the new gear. Not run.
- `source: 'compact'` was observed for a manual `/compact` only, not for an automatic compaction.
- Under an organization-managed Claude Code, `classic.SessionStart` does not run, so nothing re-injects the posture after a compaction there, and the summary may keep an older one. `turn.step` cannot add a message (it rewrites only `model` and `effort`), so a fallback would have to come through `command.run`, for example the band asking the human to repeat `/marcha` after a compaction.
- `$.store` keys per session id accumulate; nothing removes them.

## Side notes

- Typed interactively, `/effort xhigh` answered "Set effort level to xhigh (saved as your default for new sessions)" and wrote `modelSettings.claude-opus-5-5.effortLevel` in `~/.claude/settings.json`. The value was already `xhigh` (every run before it, headless included, started at `xhigh`), so nothing changed here; but a human's typed `/effort` persists as a default, unlike `$.command.run` `effort`, which #136 found to be session only.
- That per-model setting is why these `-p` sessions started at `xhigh` while the top-level `effortLevel` is `high`.
- Git Bash turns a leading `/word` into a path (`C:/Program Files/Git/marcha`) when it is passed to a native program such as `orca terminal send`; `MSYS_NO_PATHCONV=1` prevents it.
- Stream-json input written all at once is queued into the running turn ("The user sent a new message while you were working"); `driver.js` waits for each `result` before sending the next prompt.
