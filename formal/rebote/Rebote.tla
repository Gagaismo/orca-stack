------------------------------ MODULE Rebote ------------------------------
(***************************************************************************)
(* Bounce limits of `orca-stack rebote <pr>` (src/despacho.mjs,            *)
(* reboteCommand; synced at commit d90b10c). One PR, one author, one main  *)
(* session. #396 extended the CI limit: four CI bounces in total, and from *)
(* the third on a fresh `Diagnóstico: main` with a hypothesis.             *)
(*                                                                         *)
(* One `rebote` run is ONE indivisible step here: it reads the PR once     *)
(* (`gh pr view`, L1311) and decides from that snapshot. Between runs the  *)
(* world moves: reviewers comment, the human answers, CI finishes, the     *)
(* base moves, the author pushes and exits.                                *)
(*                                                                         *)
(* Guard constants switch each refusal off, to build broken variants.      *)
(* The real code has all of them TRUE.                                     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxHead,         \* number of distinct PR heads (commit shas) explored
    ConflictGuard,   \* L1366: same-head conflict bounce refused
    CiLimitGuard,    \* L1415-1416 (#396): fifth distinct CI bounce refused
    DiagnosisGuard,  \* L1417-1420, mainDiagnosis L1093-1108 (#396): third and fourth CI bounce refused without a fresh Diagnóstico: main on the head
    ReviewShaGuard,  \* L1426: only blocking reviews whose Commit: is the head count (#296)
    InterpGuard,     \* L1435-1436, L1439-1442: unsettled interpretation findings never reach the author
    AnswerOrderGuard,\* L1430-1434: an answer settles only the reviews posted before it, one by one
    OwedGuard,       \* L1569-1580: main posts the printed marker before any other rebote (contract step 8)
    CommentFail      \* TRUE: all 3 attempts of `gh pr comment` (L1562-1568) may fail after the author was launched

Heads == 1..MaxHead
Kinds == {"R", "CI", "C"}   \* markers: `Rebote:`, `Rebote CI:`, `Rebote conflicto:`
NoMarkers == [k \in Kinds |-> {}]

VARIABLES
    head,      \* pr.headRefOid (L1328)
    ci,        \* rollup of the head: "pending" | "green" | "red" (L1369-L1410)
    merge,     \* pr.mergeable: "ok" | "conflict" (L1364). UNKNOWN only refuses (L1362): not a state.
    rev,       \* blocking review comments posted for each head: subset of {"impl","interp"} (L1424-1428)
    settled,   \* some interpretation review of the head has a `Respuesta del humano:` after it (L1429-1434)
    open,      \* some interpretation review of the head has no answer after it (L1435)
    mk,        \* marker comments seen in the PR, by kind: the heads they name (L1355-1358)
    owed,      \* markers `rebote` printed after its comment failed; main has to post them (L1569-1580)
    diag,      \* head named by the `Commit:` of a `Diagnóstico: main` with a hypothesis, posted after the latest `Rebote CI:`; 0: none (#396)
    alive,     \* an author is working in the PR worktree (L1478)
    lauR,      \* history: heads on which a review-bounce launch happened
    lauCI,     \* history: heads on which a CI-bounce launch happened
    lauC,      \* history: launches of a conflict bounce, per head
    leaked,    \* history: some launch carried an unsettled interpretation finding to the author
    undiagnosed \* history: some CI launch from the third on had no fresh diagnosis of its own head (#396)

vars == <<head, ci, merge, rev, settled, open, mk, owed, diag, alive, lauR, lauCI, lauC, leaked, undiagnosed>>

TypeOK ==
    /\ head \in Heads
    /\ ci \in {"pending", "green", "red"}
    /\ merge \in {"ok", "conflict"}
    /\ rev \in [Heads -> SUBSET {"impl", "interp"}]
    /\ settled \in [Heads -> BOOLEAN]
    /\ open \in [Heads -> BOOLEAN]
    /\ mk \in [Kinds -> SUBSET Heads]
    /\ owed \in [Kinds -> SUBSET Heads]
    /\ diag \in 0..MaxHead
    /\ alive \in BOOLEAN
    /\ lauR \subseteq Heads
    /\ lauCI \subseteq Heads
    /\ lauC \in [Heads -> 0..2]
    /\ leaked \in BOOLEAN
    /\ undiagnosed \in BOOLEAN

Init ==
    /\ head = 1
    /\ ci = "pending"
    /\ merge = "ok"
    /\ rev = [x \in Heads |-> {}]
    /\ settled = [x \in Heads |-> FALSE]
    /\ open = [x \in Heads |-> FALSE]
    /\ mk = NoMarkers
    /\ owed = NoMarkers
    /\ diag = 0
    /\ alive = FALSE
    /\ lauR = {}
    /\ lauCI = {}
    /\ lauC = [x \in Heads |-> 0]
    /\ leaked = FALSE
    /\ undiagnosed = FALSE

(*************************** the world (not the code) ***************************)

\* Author, main (`gh pr update-branch`) or anyone pushes: a new head, new CI, maybe a conflict.
Push ==
    /\ head < MaxHead
    /\ head' = head + 1
    /\ ci' = "pending"
    /\ merge' \in {"ok", "conflict"}
    \* Abstraction (#396, MaxHead = 5 needs it): the head left behind keeps only what is read again. Its reviews,
    \* answers and review/conflict markers are never read again (L1424-1427, L1366 read the head); the promises on it
    \* were already checked in every state it was the head, so its review launch and conflict count are dropped too.
    \* A blocking implementation review stays: the broken ReviewShaGuard reads it. CI markers and launches stay: they count.
    \* An owed review or conflict marker of an older head only matters as owed (L1578): it is kept as head 1, always older.
    /\ rev' = [rev EXCEPT ![head] = @ \cap {"impl"}]
    /\ settled' = [settled EXCEPT ![head] = FALSE]
    /\ open' = [open EXCEPT ![head] = FALSE]
    /\ mk' = [mk EXCEPT !["R"] = @ \ {head}, !["C"] = @ \ {head}]
    /\ lauR' = lauR \ {head}
    /\ lauC' = [lauC EXCEPT ![head] = 0]
    /\ owed' = [owed EXCEPT !["R"] = IF @ = {} THEN {} ELSE {1}, !["C"] = IF @ = {} THEN {} ELSE {1}]
    /\ UNCHANGED <<diag, alive, lauCI, leaked, undiagnosed>>

\* GitHub runs no workflow while the PR conflicts (comment at L1363).
CIFinishes ==
    /\ ci = "pending"
    /\ merge = "ok"
    /\ ci' \in {"green", "red"}
    /\ UNCHANGED <<head, merge, rev, settled, open, mk, owed, diag, alive, lauR, lauCI, lauC, leaked, undiagnosed>>

BaseMoves ==
    /\ merge = "ok"
    /\ merge' = "conflict"
    /\ UNCHANGED <<head, ci, rev, settled, open, mk, owed, diag, alive, lauR, lauCI, lauC, leaked, undiagnosed>>

\* A reviewer posts `## BLOQUEA` with `Commit: <head>` (L1424-1427); "interp" if its section says interpretación (L1428).
\* A new interpretation review has no answer after it yet, whatever answered the earlier ones.
ReviewPosts(kind) ==
    /\ rev' = [rev EXCEPT ![head] = @ \cup {kind}]
    /\ open' = IF kind = "interp" THEN [open EXCEPT ![head] = TRUE] ELSE open
    /\ UNCHANGED <<head, ci, merge, settled, mk, owed, diag, alive, lauR, lauCI, lauC, leaked, undiagnosed>>

\* `Respuesta del humano:` posted after the open interpretation reviews (L1429-1434): it settles all of them.
\* Reviews of older heads are never read again (L1424-1427), so only the current head is tracked.
HumanAnswers ==
    /\ open[head]
    /\ settled' = [settled EXCEPT ![head] = TRUE]
    /\ open' = [open EXCEPT ![head] = FALSE]
    /\ UNCHANGED <<head, ci, merge, rev, mk, owed, diag, alive, lauR, lauCI, lauC, leaked, undiagnosed>>

AuthorExits ==
    /\ alive
    /\ alive' = FALSE
    /\ UNCHANGED <<head, ci, merge, rev, settled, open, mk, owed, diag, lauR, lauCI, lauC, leaked, undiagnosed>>

\* main runs the printed `gh pr comment <pr> --body-file <file>` (L1577): the owed markers reach the PR.
MainPostsOwed ==
    /\ owed /= NoMarkers
    \* Review and conflict markers of older heads are never read again (see Push); CI markers of every head count.
    /\ mk' = [k \in Kinds |-> mk[k] \cup (IF k = "CI" THEN owed[k] ELSE owed[k] \cap {head})]
    /\ owed' = NoMarkers
    \* A `Rebote CI:` marker now in the PR is the latest one: a diagnosis posted before it no longer counts (#396).
    /\ diag' = IF owed["CI"] /= {} THEN 0 ELSE diag
    /\ UNCHANGED <<head, ci, merge, rev, settled, open, alive, lauR, lauCI, lauC, leaked, undiagnosed>>

\* main posts `Diagnóstico: main` with `Commit: <head>` and a `Siguiente hipótesis:` that is neither empty nor `ninguna`
\* (#396, mainDiagnosis L1093-1108). One with an empty or `ninguna` hypothesis is no step here: the code reads the newest
\* diagnosis on the head and refuses on it (L1420), so leaving diag as it was only lets the model bounce more, never less.
MainDiagnoses ==
    /\ diag' = head
    /\ UNCHANGED <<head, ci, merge, rev, settled, open, mk, owed, alive, lauR, lauCI, lauC, leaked, undiagnosed>>

(*************************** one `rebote` run ***************************)

h == head                                                        \* sha, L1328
conflict == merge = "conflict"                                   \* L1364
failed == ci = "red"                                             \* failedChecks, L1410
\* L1426: a blocker counts only when its Commit: is the head. Broken variant (ReviewShaGuard FALSE): a blocking
\* review of any head counts, so a head that moved bounces on an older head's review.
impl == IF ReviewShaGuard THEN "impl" \in rev[h] ELSE \E x \in Heads : "impl" \in rev[x]
\* L1431-1434: the code finds an answer after each review. Broken variant (AnswerOrderGuard FALSE): any answer
\* on the head settles every review, so an open review posted after an answer counts as settled.
codeOpen == open[h] /\ (AnswerOrderGuard \/ ~settled[h])          \* interpretations.length > 0 (L1435)
\* L1436: reviewBlockers = blockers minus interpretations. The settled reviews go to the author.
\* Broken variant (InterpGuard FALSE): every blocker goes to the author and none is refused.
sendsOpen == open[h] /\ ~(InterpGuard /\ codeOpen)                \* an unanswered review reaches the author
reviewBlockers == impl \/ settled[h] \/ sendsOpen                 \* reviewBlockers.length > 0
priorCI == mk["CI"] \ {h}                                        \* k - 1 = Cardinality(priorCI), L1415

Refused ==
    \/ (ConflictGuard /\ conflict /\ h \in mk["C"])                                         \* L1366
    \/ (~conflict /\ ci = "pending")                                                        \* L1406-1409
    \/ (CiLimitGuard /\ failed /\ Cardinality(priorCI) >= 4)                                \* L1416 (#396): fifth
    \/ (DiagnosisGuard /\ failed /\ Cardinality(priorCI) >= 2 /\ diag /= h)                 \* L1417-1420 (#396): third, fourth
    \/ (InterpGuard /\ codeOpen /\ ~failed /\ ~conflict)                                     \* L1439-1442
    \/ (~reviewBlockers /\ ~failed /\ ~conflict)                                            \* L1447-1450
    \/ alive                                                                                \* L1478
    \/ (OwedGuard /\ owed /= NoMarkers)                     \* L1578: main posts the printed marker first

\* The markers of this run (L1558), added to a marker map m.
WithMarkers(m) ==
    [m EXCEPT !["R"]  = IF reviewBlockers THEN @ \cup {h} ELSE @,
              !["CI"] = IF failed THEN @ \cup {h} ELSE @,
              !["C"]  = IF conflict THEN @ \cup {h} ELSE @]

\* The history effects of a launch (L1553). The author is launched once per run: retries never relaunch.
Launch ==
    /\ ~Refused
    /\ alive' = TRUE
    /\ lauR'  = IF reviewBlockers THEN lauR \cup {h} ELSE lauR
    /\ lauCI' = IF failed THEN lauCI \cup {h} ELSE lauCI
    /\ lauC'  = IF conflict THEN [lauC EXCEPT ![h] = IF @ = 2 THEN 2 ELSE @ + 1] ELSE lauC
    /\ leaked' = (leaked \/ sendsOpen)
    /\ undiagnosed' = (undiagnosed \/ (failed /\ Cardinality(lauCI \ {h}) >= 2 /\ diag /= h))
    /\ UNCHANGED <<head, ci, merge, rev, settled, open>>

\* L1555-1568: the markers are posted after the launch; one of the 3 attempts succeeds.
Rebote ==
    /\ Launch
    /\ mk' = WithMarkers(mk)
    /\ diag' = IF failed THEN 0 ELSE diag                \* the new `Rebote CI:` is now the latest marker (#396)
    /\ UNCHANGED owed

\* L1569-1580: all 3 attempts fail; `rebote` exits non-zero and prints the markers and the command for main.
ReboteCommentFails ==
    /\ CommentFail
    /\ Launch
    /\ owed' = WithMarkers(owed)
    /\ UNCHANGED <<mk, diag>>

\* `rebote <pr> --continuar` (#292, continueBounce): relaunches the author of the bounce whose last marker is on the
\* head (heads only grow, so that is h being marked), with no live agent. It posts no marker and is no bounce: it changes
\* none of the launch histories the promises count, so no limit can move.
Continue ==
    /\ ~alive
    /\ h \in mk["R"] \cup mk["CI"] \cup mk["C"]
    /\ alive' = TRUE
    /\ UNCHANGED <<head, ci, merge, rev, settled, open, mk, owed, diag, lauR, lauCI, lauC, leaked, undiagnosed>>

Next ==
    \/ Push
    \/ CIFinishes
    \/ BaseMoves
    \/ HumanAnswers
    \/ AuthorExits
    \/ MainPostsOwed
    \/ MainDiagnoses
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

\* #396 (spec decision A2 of #392): never more than four CI bounces, on distinct heads.
CiBounceAtMostFour == Cardinality(lauCI) <= 4

\* #396: the third and fourth CI bounce each carry a `Diagnóstico: main` on the bounced head, with a hypothesis, posted
\* after the latest `Rebote CI:` marker. Bounces 1 and 2 need none.
CiBounceFromThirdNeedsDiagnosis == ~undiagnosed

\* Contract step 8: "un segundo [rebote] por conflicto sobre el mismo head se niega".
ConflictBounceOncePerHead == \A x \in Heads : lauC[x] <= 1

\* Contract step 8 / Review: interpretation findings "se envían al humano", never to the author.
InterpretationNeverToAuthor == ~leaked

=============================================================================
