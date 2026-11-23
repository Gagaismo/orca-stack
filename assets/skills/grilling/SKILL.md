---
name: grilling
description: Grill a plan, decision, or idea by settling every fact and evidenced choice yourself and asking the user only what needs them. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Map the plan as a **design tree**: every decision branches into the decisions that hang off it. Settle the tree with as few questions to the user as the evidence allows: the user's time goes to what only the user knows or wants.

## Triage every open point

Before you ask anything, put each open point of the tree into one bucket:

- **Fact**: discoverable from the repo, the tools, or the docs (code, `GLOSSARY.md`, `docs/adr/`, `CODING_STANDARDS.md`, config, git history, issues). Finding facts is your job. Look it up yourself; when that takes more than a quick read, dispatch a sub-agent with a fresh context window. A running lookup is an unsettled prerequisite: only the points downstream of it wait.
- **Decision with evidence**: a choice the evidence settles (an ADR, an existing convention or pattern, a glossary term, an earlier answer from the user in this session, a rule of the ticket or spec). Decide it and record it as an **assumption** with its evidence: `path:line`, the ADR, the glossary term, or "your answer to Qn".
- **Human-only question**: needs the user. Product intent or scope; a preference between options the evidence does not separate; a consequential or hard-to-undo trade-off (data, security, public contracts, money, deadlines); a fact only the user has (a client, a third party, an external deadline, a credential, an intention written nowhere).

Ask only human-only questions. Example: "should the new flag be `--dry-run` or `--simulate`?" when every other command of the CLI uses `--dry-run` is an assumption (evidence: the other commands). "Does the client want notifications by email or by WhatsApp?" with nothing written about it is a human-only question.

## Rounds

The **frontier** is every human-only question whose prerequisites are settled. Ask the whole frontier in one round, however many questions it holds: number them and give your recommended answer for each. A question that depends on another question still open belongs to a later round. Then wait for the user's answers.

Format a round exactly like this; word each question so "yes" accepts your recommendation:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body>

➡️ <your recommended answer>
```

When a round has between 1 and 4 closed questions, you may ask them with the interactive question tool instead (`ask_user_question` in Gentle Shell, `AskUserQuestion` in Claude Code), still with your recommendation first. Use the chat format otherwise.

Each answer reshapes the tree: re-triage the points it touches, then recompute the frontier. When the frontier holds no human-only question, skip the round and go to the closing.

## Closing

Show every assumption you made in one list, each with its evidence, and ask for a single "ok":

```
📌 **A1** - <the assumption>. Evidence: <path:line | ADR | glossary term | your answer to Qn>
📌 **A2** - ...

Reply "ok" to accept them all, or name the ones you veto.
```

A vetoed assumption becomes a human-only question for one more round, then a new closing.

The session is done when the frontier holds no human-only question and the user accepted the assumptions list. Act on the plan only after that.

<!-- Adapted from Matt Pocock's `grilling` skill (mattpocock/skills 1.3.1, MIT; see LICENSE). -->
