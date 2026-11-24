---
status: accepted
date: 2026-11-24
---

# Deprecate Ponytail and adopt the comment rule

The Ponytail perk asks for `shortcut: <limit>, <when to upgrade>` comments next to known limits, and those comments are exactly what Matt Pocock's comment rule calls an Excuse: they let a hacky implementation stay and spread. The two cannot coexist, so we deprecate the whole Ponytail perk (its policy, the five skills `ponytail`, `ponytail-audit`, `ponytail-debt`, `ponytail-help` and `ponytail-review`, `PONYTAIL.md` and its mods config) and adopt the comment rule instead. Ponytail gets one release with a deprecation warning and is removed in the next one.

The comment rule sorts every code comment into one of four types and says what to do with it:

| Type | Action |
|---|---|
| Tautology | Delete it. |
| Excuse | Delete it and open an issue to fix the implementation. |
| Stale | Delete it. |
| Decision Record | Move it to an ADR. |

The only comment allowed is a Decision Record that cites an ADR or an issue `#n`. The rule lives in a new `CODING_STANDARDS.md`; its mechanical part is the lint of [ADR 0003](0003-ast-grep-for-lint.md).

Source: Matt Pocock, https://x.com/mattpocockuk/status/2123798388227403983.

## Considered Options

- Keep Ponytail and exempt `shortcut:` comments from the rule: rejected, because it keeps the exact comment type the rule exists to remove.
- Deprecate only the `shortcut:` comment and keep the rest of Ponytail: rejected; the human chose to deprecate the whole perk.

## Consequences

- Repos that turned the Ponytail perk on get a warning for one release, then lose it.
- centro-estudiantes changes its CS-4 standard, which today requires a `shortcut:` comment, in its own PR.
- The rule applies by default to existing code too: the existing comments it flags go into each repo's Baseline instead of failing CI, and new ones fail.
