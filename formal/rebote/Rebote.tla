------------------------------ MODULE Rebote ------------------------------
(***************************************************************************)
(* Bounce limits of `orca-stack rebote <pr>` (src/despacho.mjs,            *)
(* reboteCommand; synced at commit 7769fd3). One PR, one author, one main  *)
(* session.                                                                *)
(*                                                                         *)
(* One `rebote` run is ONE indivisible step here: it reads the PR once     *)
(* (`gh pr view`, L884) and decides from that snapshot. Between runs the   *)
(* world moves: reviewers comment, the human answers, CI finishes, the     *)
(* base moves, the author pushes and exits.                                *)
(*                                                                         *)
(* Guard constants switch each refusal off, to build broken variants.      *)
(* The real code has all of them TRUE.                                     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxHead,         \* number of distinct PR heads (commit shas) explored
    ConflictGuard,   \* L909: same-head conflict bounce refused
    CiLimitGuard,    \* L954-959: third distinct CI bounce refused
    ReviewOnceGuard, \* L974: review bounce after the head advanced refused
    InterpGuard,     \* L964-972, L975: unsettled interpretation findings never reach the author
    CommentFail      \* TRUE: `gh pr comment` (L1085) may throw after the author was launched

Heads == 1..MaxHead
Kinds == {"R", "CI", "C"}   \* markers: `Rebote:`, `Rebote CI:`, `Rebote conflicto:`

VARIABLES
    head,      \* pr.headRefOid (L898)
    ci,        \* rollup of the head: "pending" | "green" | "red" (L929-L953)
    merge,     \* pr.mergeable: "ok" | "conflict" (L907). UNKNOWN only refuses (L905): not a state.
    rev,       \* blocking review comments posted for each head: subset of {"impl","interp"} (L960-964)
    settled,   \* a `Respuesta del humano:` newer than the interpretation review exists (L966-970)
    mk,        \* marker comments seen in the PR, by kind: the heads they name (L901-903)
    alive,     \* an author is working in the PR worktree (L1027)
    lauR,      \* history: heads on which a review-bounce launch happened
    lauCI,     \* history: heads on which a CI-bounce launch happened
    lauC,      \* history: launches of a conflict bounce, per head
    leaked     \* history: some launch carried an unsettled interpretation finding to the author

vars == <<head, ci, merge, rev, settled, mk, alive, lauR, lauCI, lauC, leaked>>

TypeOK ==
    /\ head \in Heads
    /\ ci \in {"pending", "green", "red"}
    /\ merge \in {"ok", "conflict"}
    /\ rev \in [Heads -> SUBSET {"impl", "interp"}]
    /\ settled \in [Heads -> BOOLEAN]
    /\ mk \in [Kinds -> SUBSET Heads]
    /\ alive \in BOOLEAN
    /\ lauR \subseteq Heads
    /\ lauCI \subseteq Heads
    /\ lauC \in [Heads -> 0..2]
    /\ leaked \in BOOLEAN

Init ==
    /\ head = 1
    /\ ci = "pending"
    /\ merge = "ok"
    /\ rev = [x \in Heads |-> {}]
    /\ settled = [x \in Heads |-> FALSE]
    /\ mk = [k \in Kinds |-> {}]
    /\ alive = FALSE
    /\ lauR = {}
    /\ lauCI = {}
    /\ lauC = [x \in Heads |-> 0]
    /\ leaked = FALSE

(*************************** the world (not the code) ***************************)

\* Author, main (`gh pr update-branch`) or anyone pushes: a new head, new CI, maybe a conflict.
Push ==
    /\ head < MaxHead
    /\ head' = head + 1
    /\ ci' = "pending"
    /\ merge' \in {"ok", "conflict"}
    /\ UNCHANGED <<rev, settled, mk, alive, lauR, lauCI, lauC, leaked>>

\* GitHub runs no workflow while the PR conflicts (comment at L906).
CIFinishes ==
    /\ ci = "pending"
    /\ merge = "ok"
    /\ ci' \in {"green", "red"}
    /\ UNCHANGED <<head, merge, rev, settled, mk, alive, lauR, lauCI, lauC, leaked>>

BaseMoves ==
    /\ merge = "ok"
    /\ merge' = "conflict"
    /\ UNCHANGED <<head, ci, rev, settled, mk, alive, lauR, lauCI, lauC, leaked>>

\* A reviewer posts `## BLOQUEA` with `Commit: <head>` (L960-963); "interp" if its section says interpretación (L964).
ReviewPosts(kind) ==
    /\ rev' = [rev EXCEPT ![head] = @ \cup {kind}]
    /\ UNCHANGED <<head, ci, merge, settled, mk, alive, lauR, lauCI, lauC, leaked>>

\* `Respuesta del humano:` posted after the interpretation review (L966-970).
HumanAnswers ==
    /\ "interp" \in rev[head]
    /\ ~settled[head]
    /\ settled' = [settled EXCEPT ![head] = TRUE]
    /\ UNCHANGED <<head, ci, merge, rev, mk, alive, lauR, lauCI, lauC, leaked>>

AuthorExits ==
    /\ alive
    /\ alive' = FALSE
    /\ UNCHANGED <<head, ci, merge, rev, settled, mk, lauR, lauCI, lauC, leaked>>

(*************************** one `rebote` run ***************************)

h == head                                                        \** sha, L898
conflict == merge = "conflict"                                   \* L907
failed == ci = "red"                                             \* failedChecks, L953
impl == "impl" \in rev[h]
interp == "interp" \in rev[h]
settledNow == settled[h]
\* L971-972: interpretations = flagged and unsettled; reviewBlockers = blockers minus interpretations.
\* Broken variant (InterpGuard FALSE): every blocker goes to the author and none is refused.
authorGetsInterp == IF InterpGuard THEN interp /\ settledNow ELSE interp
reviewBlockers == impl \/ authorGetsInterp                       \* reviewBlockers.length > 0
unsettledInterp == interp /\ ~settledNow                         \* interpretations.length > 0
priorCI == mk["CI"] \ {h}                                        \* previousCiShas, L955

Refused ==
    \/ (ConflictGuard /\ conflict /\ h \in mk["C"])                                         \* L909
    \/ (~conflict /\ ci = "pending")                                                        \* L949-952
    \/ (CiLimitGuard /\ failed /\ Cardinality(priorCI) >= 2)                                \* L954-959
    \/ (ReviewOnceGuard /\ (mk["R"] \ {h}) /= {}
         /\ ~((conflict \/ failed) /\ ~reviewBlockers))                                     \* L974
    \/ (InterpGuard /\ unsettledInterp /\ ~failed /\ ~conflict)                             \* L975
    \/ (~reviewBlockers /\ ~failed /\ ~conflict)                                            \* L983
    \/ alive                                                                                \* L1027

\* The history effects of a launch (L1080).
Launch ==
    /\ ~Refused
    /\ alive' = TRUE
    /\ lauR'  = IF reviewBlockers THEN lauR \cup {h} ELSE lauR
    /\ lauCI' = IF failed THEN lauCI \cup {h} ELSE lauCI
    /\ lauC'  = IF conflict THEN [lauC EXCEPT ![h] = IF @ = 2 THEN 2 ELSE @ + 1] ELSE lauC
    /\ leaked' = (leaked \/ (unsettledInterp /\ authorGetsInterp /\ reviewBlockers))
    /\ UNCHANGED <<head, ci, merge, rev, settled>>

\* L1083-1085: the markers are posted after the launch.
Rebote ==
    /\ Launch
    /\ mk' = [mk EXCEPT !["R"]  = IF reviewBlockers THEN @ \cup {h} ELSE @,
                        !["CI"] = IF failed THEN @ \cup {h} ELSE @,
                        !["C"]  = IF conflict THEN @ \cup {h} ELSE @]

\* `gh pr comment` throws (ok(), L1085): the author runs, no marker exists.
ReboteCommentFails ==
    /\ CommentFail
    /\ Launch
    /\ UNCHANGED mk

Next ==
    \/ Push
    \/ CIFinishes
    \/ BaseMoves
    \/ HumanAnswers
    \/ AuthorExits
    \/ ReviewPosts("impl")
    \/ ReviewPosts("interp")
    \/ Rebote
    \/ ReboteCommentFails

Spec == Init /\ [][Next]_vars

(*************************** the promises ***************************)

\* Contract step 8: "Un PR rebota una sola vez por review"; a head that advanced after a review bounce goes to main.
\* Retrying on the same head is allowed on purpose (test/despacho.test.mjs:1451, 'Rule 2').
ReviewBounceOnce == Cardinality(lauR) <= 1

\* Contract step 8: "Después del segundo rebote de CI, si vuelve a fallar, se lo pasás al humano".
CiBounceTwice == Cardinality(lauCI) <= 2

\* Contract step 8: "un segundo [rebote] por conflicto sobre el mismo head se niega".
ConflictBounceOncePerHead == \A x \in Heads : lauC[x] <= 1

\* Contract step 8 / Review: interpretation findings "se envían al humano", never to the author.
InterpretationNeverToAuthor == ~leaked

=============================================================================
