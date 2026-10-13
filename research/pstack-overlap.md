# pstack overlap with the orca-stack

Research for Gagaismo/orca-stack#122 (map #118). Question: what in pstack does the stack already have?

## Sources and method

- pstack upstream: `https://github.com/cursor/plugins/tree/main/pstack` at `main`, version 0.15.21 (`pstack/plugin.json`).
  - `pstack/README.md`: intro and skill list.
  - `pstack/skills/principle-*/SKILL.md`: all 24 principle skills, read in full.
  - `pstack/skills/*/SKILL.md`: descriptions of the other skills. Full text read for the principle-adjacent ones only.
  - `pstack/LICENSE`, `pstack/plugin.json`, `pstack/.cursor-plugin/plugin.json`.
- Local stack:
  - `assets/stack/ORCA-STACK.md`, `CONTRATO.md`, `ROLE-BRIEFS.md`, `brief-*.md`.
  - `assets/skills/` (orca-setup, orca-stack-policy, ponytail*).
  - `~/.claude/CLAUDE.md` (ODD protocol and Implementation Routing) and `Documents/orca-stack/AGENTS.md` (contract, merge rules, "Dónde vive cada regla").
  - `~/.orca-stack/gentle/orchestrator.md`.
  - Matt Pocock skills under `~/.claude/plugins/cache/mattpocock/mattpocock-skills/1.3.1/skills/` and `~/.agents/skills/`.
  - judgment-day, caveman, ponytail*, work-unit-commits, chained-pr under `~/.agents/skills/`.
- Coverage ratings:
  - **Covered**: the rule exists and is enforced in a skill, contract or protocol the stack loads.
  - **Partly**: the idea exists but a named part is missing.
  - **New**: no equivalent found.
- Not verified: whether each local skill is loaded in every session. Ratings assume the skill is installed, as the stack's documents say.

## Principle skills (24)

| # | pstack principle | What it says (one line) | Coverage in the stack |
|---|---|---|---|
| 1 | laziness-protocol | Consolidate decisions; make the smallest diff. | **Covered**: `assets/skills/ponytail` (YAGNI, stdlib first); ODD "smallest coherent behavior" and the 400-line heuristic (`~/.claude/CLAUDE.md`, Implementation Routing). |
| 2 | foundational-thinking | Get data structures right first; scaffold before features; isolate shared state before logic. | **Partly**: ODD "Explore first" and work-unit ordering (`work-unit-commits`). Missing: no data-structure-first rule and no scaffold-first rule. |
| 3 | redesign-from-first-principles | When a new requirement arrives, redesign as if it were foundational, and propagate it everywhere. | **Partly**: `ponytail-help` Ultra mode ("challenges requirements before building"). Missing: no rule to propagate a requirement through types, docs and examples. |
| 4 | attack-the-premise | After two failed fixes share a premise, write the premise down and take a census before the next fix. | **New**: ODD step 3 allows one "assumption challenge" for a high-consequence premise, but there is no census method and no "two failures on one premise" trigger. |
| 5 | subtract-before-you-add | Remove dead code and speculative guards before building. | **Covered**: `ponytail` and `ponytail-review` (delete/yagni findings); `ponytail-help` Ultra: "Deletion before addition." |
| 6 | minimize-reader-load | Count layers and hidden state a reader must trace; collapse one-caller wrappers. | **Partly**: `ponytail-review` flags `yagni:` for "layer with one caller". Missing: no rule about mutable state scope or the "30-second test". |
| 7 | outcome-oriented-execution | In planned migrations, converge on the end state; allow planned intermediate breakage. | **New**: ODD and ORCA-STACK assume no intermediate breakage; no rule for declared, reversible breakage windows. |
| 8 | experience-first | Choose user delight over implementation convenience; ship fewer, polished features. | **New**: the stack is engineering-process focused; no UX or scope-delight rule. |
| 9 | exhaust-the-design-space | For novel UI or architecture with no precedent, build 2-3 competing prototypes and compare. | **Partly**: `mattpocock-skills:prototype` (one throwaway prototype for a design question). Missing: competing N-way comparison. |
| 10 | build-the-lever | Build the codemod, script or rerunnable check instead of hand edits; commit it when the work outlives the session. | **New**: ODD requires "rerunnable" evidence in general terms only. No rule to build a lever for repetitive edits. |
| 11 | model-the-domain | Encode domain as a state machine, union or registry instead of scattered booleans and branches. | **Partly**: `domain-modeling` (GLOSSARY, ADRs) and `codebase-design` (deep modules). Missing: no state-modelling or invalid-state guidance. |
| 12 | boundary-discipline | Validate at boundaries (CLI, config, network); keep business logic pure; trust internal types. | **Partly**: `codebase-design` (seams). Missing: no validate-at-boundary rule. |
| 13 | type-system-discipline | Illegal states unrepresentable; brand IDs; parse external data; no casts; exhaustive matching. | **New**: no TypeScript or typed-language discipline in the stack. The `typescript-best-practices` skill exists only in pstack. `migrate-to-shoehorn` (Matt, misc) covers only test casts. |
| 14 | make-operations-idempotent | Commands and loops must converge after crashes, retries and reruns. | **Partly**: `orchestrator.md` line 58 (no blind retry on external GitHub mutations; preserve state) and the assignee-as-lock rule in `AGENTS.md`. Missing: no general rule for `orca-stack despachar`, `rebote` or `revisar` reruns. |
| 15 | migrate-callers-then-delete-legacy-apis | When a new internal API lands, migrate callers and delete the old one in the same wave. | **Partly**: `ponytail-review` `yagni:` finding. Missing: no rule against compatibility layers in internal refactors. |
| 16 | separate-before-serializing-shared-state | Remove the shared write target first; serialize only real invariants. | **Covered**: ODD "Parallel writers" (disjoint edit surfaces, shared-file owner, parent owns git) and `AGENTS.md` (one `main` session per repo; assignee lock). |
| 17 | prove-it-works | Verify against the real artifact, not a self-report or "it compiles". | **Covered**: ODD "Check off only observed outcomes", independent verifier for high risk, `## Evidencia` in PR body (`AGENTS.md`), `Verificado por main` rule. |
| 18 | fix-root-causes | Reproduce, ask why, no nil-check guards, grep for the pattern. | **Covered**: `ponytail` ("Fix root causes, not only the reported symptom"); `mattpocock-skills:diagnosing-bugs`. |
| 19 | sequence-verifiable-units | Small units, each verified before the next; RED test first, then fix. | **Covered**: `work-unit-commits`, `chained-pr`, ODD test-first (RED before GREEN) and work-unit commits. |
| 20 | test-behavior-not-implementation | Assert literal outputs through the public interface; delete tests that would pass on undefined. | **Covered**: ODD step 6 ("Each test asserts every observable effect ... goes through the public interface"); `mattpocock-skills:tdd`. |
| 21 | explain-the-number | Before trusting a measured number, name its limiter and rule out other explanations. Keep run count and spread. | **New**: `gentle-ai-bench` is about benchmark journeys, not measurement validity. No limiter or run-count rule. |
| 22 | guard-the-context-window | Route bulk to subagents; size phases; keep summaries in the main thread. | **Covered**: ODD Mapping, Output budget and Long-session backstop (about 150k tokens); Writer trigger. |
| 23 | never-block-on-the-human | On reversible work, proceed and present; ask only for irreversible actions. | **Covered, with a difference**: `AGENTS.md` "Permisos" (reversible actions without asking; irreversible ones asked). ODD's "Ask trigger" is stricter: it stops for any open product or design decision. |
| 24 | encode-lessons-in-structure | Turn a repeated correction into a lint, check or script, not more prose. | **Covered**: `AGENTS.md` "Dónde vive cada regla" (mechanical rules live in CI; the instruction is the symptom). |

Summary: 9 covered (1, 5, 16, 17, 18, 19, 20, 22, 24), 1 covered with a stricter variant (23), 8 partly (2, 3, 6, 9, 11, 12, 14, 15), 6 new (4, 7, 8, 10, 13, 21). Principle 13 has no equivalent in the stack.

## Other pstack skills and playbooks

| Group | pstack item | Coverage |
|---|---|---|
| Router and mode | `poteto-mode` (23 playbooks), `poteto-help`, `setup-pstack` | Overlaps ODD routing and `orca-stack-policy`. Not needed; it duplicates the router and uses a different model panel. |
| Planning and design | `architect` (types and signatures before code), `arena` (N parallel candidates) | **New** (`arena`), **partly** (`architect`: ODD explores first but has no type-sketch step). |
| Multi-agent | `swarm`, `interrogate` (multi-model adversarial review) | **Covered** by ODD Writer and Parallel-writer rules and by `judgment-day` (blind dual review). Interrogate's code-quality lens is new. |
| Investigation | `how`, `why`, `teach`, `recall`, `ketchup`, `reflect` | `recall` partly covered by engram (`mem_context`, `mem_search`). `reflect` and `ketchup`: **new**. `how`, `why`: **new** (no evidence-categorised investigator). |
| Verification | `blast-radius`, `benchmark-checklist`, `create-verification-skill`, `maintain-verification-skill`, `show-me-your-work` | `blast-radius`: **partly** (ODD Risk line requires checking shared code). `show-me-your-work`: **partly** (ODD feature document and Log). The other three: **new**; the global `run` skill covers launching an app only. |
| Code hygiene | `no-comments`, `typescript-best-practices`, `correct` | **New**. `ponytail-review` covers over-engineering only. |
| Writing | `technical-writing`, `unslop`, `bro` | `technical-writing`: **partly** (`cognitive-doc-design`, `comment-writer`). `unslop`, `bro`: **new**. `caveman` covers compressed chat only. |
| Pocock-equivalents | `tdd` (pstack skill) | **Covered** by Matt Pocock `tdd` and `diagnosing-bugs` (`mattpocock-skills` 1.3.1). |
| Automations | `automations/benny` (issue reproduce and triage) | **Partly**: `systemic-issue-triage`. Benny's automation is new. |
| Skill authoring | `automate-me` | **Partly**: `skill-creator`, `skill-improver`. |
| Not applicable | `make-bot-ui`, `comment-sicko`, `poteto-agent` | Out of scope. |

## License terms and attribution

- **License:** MIT, as stated in `pstack/LICENSE` (copyright line: `Copyright (c) 2026 Lauren Tan`) and in `pstack/plugin.json` and `pstack/.cursor-plugin/plugin.json` (`"license": "MIT"`, `"author": {"name": "Lauren Tan"}`).
- **Repo root:** `cursor/plugins` has no root LICENSE (404 on raw `main`). The `pstack/LICENSE` governs the pstack subtree.
- **Name note:** the README is written by "poteto" (a handle linking to x.com/poteto). The copyright holder in the LICENSE is "Lauren Tan". Use the LICENSE name in attribution.
- **Attribution required to copy text:** MIT requires that "the above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software." For copied pstack text in this repo:
  1. Keep the copyright line `Copyright (c) 2026 Lauren Tan` and the full MIT permission notice, in a file or header next to the copied text, or in a `THIRD_PARTY_NOTICES` file.
  2. Link to the source path (`https://github.com/cursor/plugins/tree/main/pstack/skills/<name>`) so the origin is traceable.
  3. Paraphrasing an idea with no copied text does not trigger the notice requirement. The MIT notice covers copies of the Software, not ideas.
- Not checked: whether the upstream repo's Lauren Tan copyright year or name has changed since `main` was read.

## Candidates worth bringing in

Ranked by fit with the stack's known gaps. Each would be a new skill or a rule added to an existing one, not a copy of the whole pstack.

1. **make-operations-idempotent** (principle 14). The orca-stack commands (`despachar`, `rebote`, `revisar`) and the assignee lock depend on rerun safety, and the stack has no general rule for it. Fit: high. Adds a rule to `assets/stack/ORCA-STACK.md`. Attribute to pstack.
2. **attack-the-premise** (principle 4). The `rebote` loop allows one bounce per review; two failed fixes on one premise currently have no stop rule. Fit: high. Could live as a short addition to ODD step 3.
3. **explain-the-number** (principle 21). The stack already has `gentle-ai-bench` and perf work, but no rule to verify a measured claim. Fit: medium. Pair it with `benchmark-checklist` if it is adopted.
4. **type-system-discipline** (principle 13). The stack has no typed-code guidance and most of its repos are TypeScript-based (per `typescript-best-practices` in pstack). Fit: medium, but it needs a scoped skill for the repos that use it.
5. **build-the-lever** (principle 10). Fits the ODD test-first and rerunnable-evidence rules; would be a single short rule. Fit: low-medium.
6. **exhaust-the-design-space** (principle 9). Extend `mattpocock-skills:prototype` with a "two or three competing prototypes" option instead of forking a new skill. Fit: low.

Do not import: the whole `poteto-mode` router (duplicates ODD and `orca-stack-policy`), `arena` or `swarm` (overlap with ODD parallel rules), or the model-panel defaults (the stack has its own `agentes.modelos`).

## Open questions

1. Should the orca-stack adopt principle 14 (idempotent operations) as an explicit contract rule in `ORCA-STACK.md`? That would be a change to the mirrored contract and needs owner sign-off.
2. ODD's ask trigger is stricter than pstack's never-block principle. Which one governs product decisions? The stack's `AGENTS.md` "Permisos" supports pstack for reversible actions.
3. Is a TypeScript-specific skill wanted now? Repos in the stack vary, and the answer depends on which repo would use it.
4. Who owns the attribution text for any copied pstack content (a `THIRD_PARTY_NOTICES` file would be the new convention)?
