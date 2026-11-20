---
status: accepted
date: 2026-11-20
---

# Supervised dispatch instead of handoff

Dispatch used to be a handoff: orca-stack launched workers with `orca terminal create/send`, which gives no Orca preamble, `ask` or `worker_done`, so `main` was blind to its workers except through GitHub. We decided that `despachar` starts every ticket worker as a supervised worker of the Orca Run bound to `main`, with `worker-start --terminal`, so orca-stack's own wrappers still launch the agent; the worker ends with `worker_done` (ok, or partial with its `Diagnóstico:`), and `vigilar` merges the Run mailbox with GitHub in one Monitor. GitHub stays the durable record, and the assignee stays the lock.

Issue: [#397](https://github.com/Gagaismo/orca-stack/issues/397). PR: [#405](https://github.com/Gagaismo/orca-stack/pull/405). Spec: [#392](https://github.com/Gagaismo/orca-stack/issues/392).

## Consequences

- Dispatch depends on Orca orchestration being available.
- `main` gets pushed completions instead of discovering them only through GitHub.
- Reviews stay unsupervised.
