------------------------------ MODULE Rebote ------------------------------
(***************************************************************************)
(* Bounce limits of `orca-stack rebote <pr>` (src/despacho.mjs,            *)
(* reboteCommand; synced at commit f85aa43). One PR, one author, one main  *)
(* session.                                                                *)
(*                                                                         *)
(* One `rebote` run is ONE indivisible step here: it reads the PR once     *)
(* (`gh pr view`, L890) and decides from that snapshot. Between runs the   *)
(* world moves: reviewers comment, the human answers, CI finishes, the     *)
(* base moves, the author pushes and exits.                                *)
(*                                                                         *)
(* Guard constants switch each refusal off, to build broken variants.      *)
(* The real code has all of them TRUE.                                     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxHead,         \* number of distinct PR heads (commit shas) explored
    ConflictGuard,   \* L915: same-head conflict bounce refused
    CiLimitGuard,    \* L960-965: third distinct CI bounce refused
    ReviewShaGuard,  \* L972-975: only blocking reviews whose Commit: is the head count (#296)
    InterpGuard,     \* L977-978, L981-984: unsettled interpretation findings never reach the author
    AnswerOrderGuard,\* L972-976: an answer settles only the reviews posted before it, one by one
    OwedGuard,       \* L1100-1111: main posts the printed marker before any other rebote (contract step 8)
    CommentFail      \* TRUE: all 3 attempts of `gh pr comment` (L1093-1099) may fail after the author was launched

Heads == 1..MaxHead
Kinds == {"R", "CI", "C"}   \* markers: `Rebote:`, `Rebote CI:`, `Rebote conflicto:`
NoMarkers == [k \in Kinds |-> {}]

VARIABLES
    head,      \* pr.headRefOid (L904)
    ci,        \* rollup of the head: "pending" | "green" | "red" (L918-L959)
    merge,     \* pr.mergeable: "ok" | "conflict" (L913). UNKNOWN only refuses (L911): not a state.
    rev,       \* blocking review comments posted for each head: subset of {"impl","interp"} (L966-970)
    settled,   \* some interpretation review of the head has a `Respuesta del humano:` after it (L971-976)
    open,      \* some interpretation review of the head has no answer after it (L977)
    mk,        \* marker comments seen in the PR, by kind: the heads they name (L907-909)
    owed,      \* markers `rebote` printed after its comment failed; main has to post them (L1100-1111)
    alive,     \* an author is working in the PR worktree (L1034)
    lauR,      \* history: heads on which a review-bounce launch happened
    lauCI,     \* history: heads on which a CI-bounce launch happened
    lauC,      \* history: launches of a conflict bounce, per head
    leaked     \* history: some launch carried an unsettled interpretation finding to the author

vars == <<head, ci, merge, rev, settled, open, mk, owed, alive, lauR, lauCI, lauC, leaked>>

TypeOK ==
    /\ head \in Heads
    /\ ci \in {"pending", "green", "red"}
    /\ merge \in {"ok", "conflict"}
    /\ rev \in [Heads -> SUBSET {"impl", "interp"}]
    /\ settled \in [Heads -> BOOLEAN]
    /\ open \in [Heads -> BOOLEAN]
    /\ mk \in [Kinds -> SUBSET Heads]
    /\ owed \in [Kinds -> SUBSET Heads]
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
    /\ open = [x \in Heads |-> FALSE]
    /\ mk = NoMarkers
    /\ owed = NoMarkers
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
    /\ UNCHANGED <<rev, settled, open, mk, owed, alive, lauR, lauCI, lauC, leaked>>

\* GitHub runs no workflow while the PR conflicts (comment at L912).
CIFinishes ==
    /\ ci = "pending"
    /\ merge = "ok"
    /\ ci' \in {"green", "red"}
    /\ UNCHANGED <<head, merge, rev, settled, open, mk, owed, alive, lauR, lauCI, lauC, leaked>>

BaseMoves ==
    /\ merge = "ok"
    /\ merge' = "conflict"
    /\ UNCHANGED <<head, ci, rev, settled, open, mk, owed, alive, lauR, lauCI, lauC, leaked>>

\* A reviewer posts `## BLOQUEA` with `Commit: <head>` (L966-969); "interp" if its section says interpretación (L970).
\* A new interpretation review has no answer after it yet, whatever answered the earlier ones.
ReviewPosts(kind) ==
    /\ rev' = [rev EXCEPT ![head] = @ \cup {kind}]
    /\ open' = IF kind = "interp" THEN [open EXCEPT ![head] = TRUE] ELSE open
    /\ UNCHANGED <<head, ci, merge, settled, mk, owed, alive, lauR, lauCI, lauC, leaked>>

\* `Respuesta del humano:` posted after the open interpretation reviews (L971-976): it settles all of them.
\* Reviews of older heads are never read again (L966-969), so only the current head is tracked.
HumanAnswers ==
    /\ open[head]
    /\ settled' = [settled EXCEPT ![head] = TRUE]
    /\ open' = [open EXCEPT ![head] = FALSE]
    /\ UNCHANGED <<head, ci, merge, rev, mk, owed, alive, lauR, lauCI, lauC, leaked>>

AuthorExits ==
    /\ alive
    /\ alive' = FALSE
    /\ UNCHANGED <<head, ci, merge, rev, settled, open, mk, owed, lauR, lauCI, lauC, leaked>>

\* main runs the printed `gh pr comment <pr> --body-file <file>` (L1108): the owed markers reach the PR.
MainPostsOwed ==
    /\ owed /= NoMarkers
    /\ mk' = [k \in Kinds |-> mk[k] \cup owed[k]]
    /\ owed' = NoMarkers
    /\ UNCHANGED <<head, ci, merge, rev, settled, open, alive, lauR, lauCI, lauC, leaked>>

(*************************** one `rebote` run ***************************)

h == head                                                        \* sha, L904
conflict == merge = "conflict"                                   \* L913
failed == ci = "red"                                             \* failedChecks, L959
\* L972-975: a blocker counts only when its Commit: is the head. Broken variant (ReviewShaGuard FALSE): a blocking
\* review of any head counts, so a head that moved bounces on an older head's review.
impl == IF ReviewShaGuard THEN "impl" \in rev[h] ELSE \E x \in Heads : "impl" \in rev[x]
\* L973-976: the code finds an answer after each review. Broken variant (AnswerOrderGuard FALSE): any answer
\* on the head settles every review, so an open review posted after an answer counts as settled.
codeOpen == open[h] /\ (AnswerOrderGuard \/ ~settled[h])          \* interpretations.length > 0 (L977)
\* L978: reviewBlockers = blockers minus interpretations. The settled reviews go to the author.
\* Broken variant (InterpGuard FALSE): every blocker goes to the author and none is refused.
sendsOpen == open[h] /\ ~(InterpGuard /\ codeOpen)                \* an unanswered review reaches the author
reviewBlockers == impl \/ settled[h] \/ sendsOpen                 \* reviewBlockers.length > 0
priorCI == mk["CI"] \ {h}                                        \* previousCiShas, L961

Refused ==
    \/ (ConflictGuard /\ conflict /\ h \in mk["C"])                                         \* L915
    \/ (~conflict /\ ci = "pending")                                                        \* L955-958
    \/ (CiLimitGuard /\ failed /\ Cardinality(priorCI) >= 2)                                \* L960-965
    \/ (InterpGuard /\ codeOpen /\ ~failed /\ ~conflict)                                     \* L981-984
    \/ (~reviewBlockers /\ ~failed /\ ~conflict)                                            \* L989-992
    \/ alive                                                                                \* L1034
    \/ (OwedGuard /\ owed /= NoMarkers)                     \* L1109: main posts the printed marker first

\* The markers of this run (L1089), added to a marker map m.
WithMarkers(m) ==
    [m EXCEPT !["R"]  = IF reviewBlockers THEN @ \cup {h} ELSE @,
              !["CI"] = IF failed THEN @ \cup {h} ELSE @,
              !["C"]  = IF conflict THEN @ \cup {h} ELSE @]

\* The history effects of a launch (L1086). The author is launched once per run: retries never relaunch.
Launch ==
    /\ ~Refused
    /\ alive' = TRUE
    /\ lauR'  = IF reviewBlockers THEN lauR \cup {h} ELSE lauR
    /\ lauCI' = IF failed THEN lauCI \cup {h} ELSE lauCI
    /\ lauC'  = IF conflict THEN [lauC EXCEPT ![h] = IF @ = 2 THEN 2 ELSE @ + 1] ELSE lauC
    /\ leaked' = (leaked \/ sendsOpen)
    /\ UNCHANGED <<head, ci, merge, rev, settled, open>>

\* L1087-1099: the markers are posted after the launch; one of the 3 attempts succeeds.
Rebote ==
    /\ Launch
    /\ mk' = WithMarkers(mk)
    /\ UNCHANGED owed

\* L1100-1111: all 3 attempts fail; `rebote` exits non-zero and prints the markers and the command for main.
ReboteCommentFails ==
    /\ CommentFail
    /\ Launch
    /\ owed' = WithMarkers(owed)
    /\ UNCHANGED mk

\* `rebote <pr> --continuar` (#292, continueBounce): relaunches the author of the bounce whose last marker is on the
\* head (heads only grow, so that is h being marked), with no live agent. It posts no marker and is no bounce: it changes
\* none of the launch histories the promises count, so no limit can move.
Continue ==
    /\ ~alive
    /\ h \in mk["R"] \cup mk["CI"] \cup mk["C"]
    /\ alive' = TRUE
    /\ UNCHANGED <<head, ci, merge, rev, settled, open, mk, owed, lauR, lauCI, lauC, leaked>>

Next ==
    \/ Push
    \/ CIFinishes
    \/ BaseMoves
    \/ HumanAnswers
    \/ AuthorExits
    \/ MainPostsOwed
    \/ ReviewPosts("impl")
    \/ ReviewPosts("interp")
    \/ Rebote
    \/ ReboteCommentFails
    \/ Continue

Spec == Init /\ [][Next]_vars

(*************************** the promises ***************************)

\* Contract step 8: "Un PR rebota una sola vez por review", counted by the review's Commit: sha (#296): every review
\* bounce is on a head with a blocking review of its own. A head that moved bounces again on its own review, and a
\* retry on the same head is allowed on purpose (test/despacho.test.mjs, 'Rule 2: permits same-head retry marker...').
ReviewBounceOnItsOwnHead == \A x \in lauR : rev[x] /= {}

\* Contract step 8: "Después del segundo rebote de CI, si vuelve a fallar, se lo pasás al humano".
CiBounceTwice == Cardinality(lauCI) <= 2

\* Contract step 8: "un segundo [rebote] por conflicto sobre el mismo head se niega".
ConflictBounceOncePerHead == \A x \in Heads : lauC[x] <= 1

\* Contract step 8 / Review: interpretation findings "se envían al humano", never to the author.
InterpretationNeverToAuthor == ~leaked

=============================================================================
