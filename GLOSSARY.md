# orca-stack

The methodology orca-stack installs: one orchestrating session plans and dispatches work, and workers implement tickets in their own worktrees.

## Language

### Orchestration

**Main**:
The orchestrating session, running in a repo's main checkout; it plans, dispatches, merges and integrates, and never implements tickets.
_Avoid_: coordinator, orchestrator session

**Perk**:
An optional part of the stack that the human turns on in the project config; it is off by default, and orca-stack works completely without it. The gears perk (*marchas*) is one.

**Supervised Run**:
The Orca orchestration Run bound to the main session: every ticket worker is started inside it, reports its end to it as ok or partial, and main watches its mailbox alongside GitHub.
_Avoid_: handoff (for ticket dispatch)

**Diagnóstico**:
A worker's written cause, attempts and next hypothesis after exhausting its attempts on the same failure.

**Watchdog**:
The check main's watch runs on every batch worker to detect one that stopped before opening a PR (out of quota, back at the shell, or finished without a PR) or stalled with an unchanged screen, reporting each event with the worker's last screen line as diagnosis.

**Autonomous mode**:
The state the human puts a session in so main works toward a goal they set without them: main does not wait for the human, records what needs them and carries on with the rest. It is independent of the gear. Spanish: *modo autónomo*.
_Avoid_: autopilot, unattended gear

### Gears perk

These terms apply only when the gears perk is on.

**Gear**:
The posture main works in: how deep it explores, how much it delegates and narrates, and how it collaborates with workers. Spanish: *marcha*.
_Avoid_: profile, perfil, mode, modo, level

**Lazy gear**:
The gear for work that is already specified: main carries it out (dispatching, watching and merging, or implementing in single-agent mode) without planning or specifying anything new.

**Medium gear**:
The default gear: main works as the work contract and ODD say, at the baseline effort.

**Proactive gear**:
The gear that goes beyond the request and collaborates with running workers: it answers their questions and tells them what they cannot see.

**Gear shift**:
A change from one gear to another during a session. Only the human makes one; main only suggests it.
_Avoid_: swap, profile switch

**Baseline effort**:
The effort main has without a gear: the human's most recent explicit choice, else the model's default. Spanish: *esfuerzo base*.
_Avoid_: default effort

**Gear knob**:
A process setting that a gear may turn, such as how deep main explores or how much it narrates. The knobs are a closed list; a gear names only knobs on it. Spanish: *perilla de marcha*.
_Avoid_: process rule, soft rule

**Fixed rule**:
Any rule main follows that is not a gear knob; it holds the same in every gear. Spanish: *regla fija*.
_Avoid_: contract rule, safety rule, hard rule

### Fan-out techniques

**Arena**:
Several independent attempts at the same task, judged against one rubric; the best attempt becomes the base and takes the best parts of the others.

**Candidate**:
One of the independent attempts in an arena. Spanish: *candidato*.
_Avoid_: variant, attempt

**Judge**:
The one who picks the base among an arena's candidates against its rubric; picking a candidate is not a review. Spanish: *juez*.
_Avoid_: reviewer, cross-judge

**Graft**:
Bringing into the base the parts worth keeping from the candidates that lost. Spanish: *injerto*.
_Avoid_: merge, combine

**Swarm**:
One question spread over parallel subagents doing read work, each on its own slice or racing on the whole, whose results come back as one published aggregated report. Reading different areas to give main context is delegation, not a swarm. A race that writes is an arena.
