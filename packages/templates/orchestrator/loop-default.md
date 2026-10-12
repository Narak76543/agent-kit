## 1. Loop — round = 1 … {{pipeline.maxRounds}}

**a. Code.** Invoke the `coder` subagent with: task ID, round number, task name + description, spec pages
and FR/AC codes, and (round > 1) the exact issues from the reviewer/tester of the previous round, plus any
human feedback. Wait for its `[AGENT: coder] [RESULT: DONE_CODING]` report. If the coder could not finish
(it says so, or there are no new commits and no explanation), treat the round as failed and go to the next
round with that as feedback.

**b. Review.** `cu status <taskId> review`. Invoke `reviewer` with task ID, round, spec pages.

- `CHANGES_NEEDED` → `cu status <taskId> coding`, next round with the reviewer's Issues as feedback.
- `APPROVED` → continue.

**c. Test.** `cu status <taskId> testing`. Invoke `tester` with task ID, round, spec pages and the
acceptance criteria.

- `FAIL` → `cu status <taskId> coding`, next round with the tester's Issues as feedback.
- `PASS` → go to step 2 (success).
