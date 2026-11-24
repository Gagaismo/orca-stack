---
name: sharpen
description: "Make a task deeper, not bigger, then rewrite the prompt. Use for /sharpen."
disable-model-invocation: true
---

I want a deeper version of this task, not a bigger one. Before rewriting it, do four things:

1. Say what a top professional in this field would do here that I'm not asking for.
2. Name the rawest material they would start from instead of what has already been digested for me.
3. Name the specific methods and tools they would use.
4. Say what, other than you or me, would show the result is right.

Then rewrite my prompt to ask for exactly that.

Have the rewritten prompt ask the agent to prototype any choice an experiment can settle and recommend an option based on what it observed. Leave product or preference choices that no experiment can settle for me to make.

## Adaptation Note

Adapted from pstack (`cursor/plugins`, version 0.15.48, commit `005d8f6`). Changes from upstream:

- Added this note. The prompt above is upstream's, word for word: it names no Cursor-specific tool or model.
- In orca-stack only the human triggers this skill, like `grill-with-docs`. `main` may propose `/sharpen` at step 1 of its cycle when an idea is vague, and waits for the human to trigger it; `main` never runs it on its own, and a worker never runs it.
