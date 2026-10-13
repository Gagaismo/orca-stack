# orca-stack

The methodology orca-stack installs: one orchestrating session plans and dispatches work, and workers implement tickets in their own worktrees.

## Language

### Orchestration

**Main**:
The orchestrating session, running in a repo's main checkout; it plans, dispatches, merges and integrates, and never implements tickets.
_Avoid_: coordinator, orchestrator session

**Gear**:
The posture main works in: how much it reasons, explores and collaborates with workers. Spanish: *marcha*.
_Avoid_: profile, perfil, mode, modo, level

**Lazy gear**:
The gear for well-delimited, known work.

**Medium gear**:
The gear for day-to-day work that balances speed and reasoning.

**Proactive gear**:
The gear that goes beyond the request and collaborates actively with workers.

**Gear shift**:
A change from one gear to another during a session.
_Avoid_: swap, profile switch

### Fan-out techniques

**Arena**:
Several independent attempts at the same task, judged against one rubric; the best attempt becomes the base and takes the best parts of the others.

**Swarm**:
Several parallel workers, each on its own slice of a task or racing on the same one, whose results come back as one aggregated report.
