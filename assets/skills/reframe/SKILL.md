---
name: reframe
description: "Teach the expert words for what the human is building, borrow words from neighboring fields that solved the same problem, then rewrite their description with them. Use for /reframe."
disable-model-invocation: true
---

Teach the human the expert words for what they are building. Start from their own files, code and description, not a summary.

If their description could name more than one problem, first list the two or three problems it could be, each with the one term that names it and the sign that would tell it apart from the others. Then teach the words for the most likely one and say why you picked it.

1. Give 8 to 12 terms, ranked by how much each would change what gets built. For each, give the word and its meaning in one plain sentence, the part of their description it names, one real project, paper or system that uses it that way, with a link, and what it lets them ask an agent for.
2. Pick 2 or 3 neighboring fields that solved the same shape of problem under other names. For each, say what carries over, where the analogy breaks, and which terms come back.
3. Name what they didn't mention but should care about.
4. Rewrite their description with the new words.

Open every link and confirm it uses the term that way. Cut any citation you can't confirm. No padding.

## Adaptation Note

Adapted from pstack (`cursor/plugins`, version 0.15.48, commit `005d8f6`). Changes from upstream:

- "the operator" is "the human" in the description and in the first sentence: orca-stack calls the person who runs the stack the human.
- Added this note. Upstream names no Cursor-specific tool or model, so nothing else changed.
- In orca-stack only the human triggers this skill, like `grill-with-docs`. `main` may propose `/reframe` at step 1 of its cycle when an idea is vague, and waits for the human to trigger it; `main` never runs it on its own, and a worker never runs it.
