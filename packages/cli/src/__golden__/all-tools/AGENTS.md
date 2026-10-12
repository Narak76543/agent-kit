<!-- Managed by @tossana/agents v0.1.0 — do not edit; run "tossana-agents update" -->
# AGENTS.md — rules for every AI agent in this repo

This file is the single source of truth for any agent (OpenCode, Antigravity, Claude Code, or anything
else). Tool-specific files (`.opencode/agents/*.md`, Antigravity's `.agents/agents/*.md` and `.agents/skills/`)
only add role instructions on top of it. If they disagree with this file, this file wins.

The part above the `<!-- PROJECT -->` marker is managed by the Tossana agent kit and is the same in every
project. The project section below the marker describes **this** project: overview, folders, conventions.

---

## 1. Workflow

ClickUp statuses (left to right):

```
to do → coding → in review → testing → ready for review → Done
                                                                    ^ Done is HUMAN ONLY
```

### The one rule that is never broken

**Agents never set a task to Done, Complete or Closed.** The highest status an agent may set is
**ready for review**. Only the human owner sets Done. `cu status` refuses those statuses; if you see
`BLOCKED`, do not look for a workaround — report it and stop.

### Roles

| Agent        | Does                                                                               | May set status                 |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------------ |
| orchestrator | Runs ONE task end-to-end. Delegates; never writes code.                            | coding, review, testing, human |
| coder        | Implements on branch `task/<taskId>`, fixes feedback, commits. | —                              |
| reviewer     | Read-only review of `git diff main...HEAD`.                     | —                              |
| tester       | Runs the quality gate; writes/edits **test files only**.                           | —                              |

### The loop (max 5 rounds)

1. `tossana-agents run --task <taskId>` prepares branch `task/<taskId>` and starts the
   orchestrator. The orchestrator reads the task, its comments and `.agents/handoff/<taskId>.md`, sets **coding**.
2. **coder** → `DONE_CODING`. Orchestrator sets **review**.
3. **reviewer** → `APPROVED` or `CHANGES_NEEDED`. `CHANGES_NEEDED` → back to coder with the reviewer's
   issues (status **coding**), next round.
4. Orchestrator sets **testing**. **tester** → `PASS` or `FAIL`. `FAIL` → back to coder with the failures
   (status **coding**), next round.
5. `APPROVED` + `PASS` in the same round → status **human** (ready for review) + owner notification.

If round 5 ends without APPROVED + PASS: set **human** anyway with a `NEEDS_HUMAN`
comment that says what keeps failing.

### Git rules

- Every task lives on branch `task/<taskId>`, created from `main` by
  `tossana-agents run`. It is reused if it already exists (the human may have sent the task back).
- Never commit to `main`. **Never push** (branches stay local; the human reviews them).
  Never force anything, never rewrite history, never delete branches.
- Never commit `.env`, logs, or `.agents/`.

---

## 2. ClickUp commands

Talk to ClickUp **only** through the kit CLI. Below, `cu` means `npx tossana-agents clickup`.
Never call api.clickup.com directly, never read or print `.env` or `CLICKUP_API_TOKEN`.

```
cu get <taskId>                       # task details (JSON)
cu comments <taskId>                  # all comments, oldest first
cu comment <taskId> --file <path>     # post a comment (also appended to the handoff file)
cu notify <taskId> --file <path>      # comment assigned to the owner (orchestrator only)
cu handoff <taskId> --file <path>     # append details to the handoff file only (no API call)
cu status <taskId> <role>             # orchestrator only; roles: todo, coding, review, testing, human
cu subtask <taskId> "<name>" "<description>"
cu list --status <role> [--mine]      # tasks in this project's list
cu statuses                           # the list's statuses and which agents may set
cu sync-docs                          # refresh docs/clickup/ from ClickUp Docs
```

**Always pass comment text with `--file`.** Write the text to `.tossana/tmp/<taskId>-<agent>.md` with your
edit tool, then pass that path. Quotes in command-line text break on Windows. The file is deleted after a
successful post. Exit code 2 = `BLOCKED` by the safety guard.

Never delete anything in ClickUp, never rename or rewrite the task name or description, never change
assignees. Add information as comments or subtasks.

---

## 3. Communication format

Every agent posts **one ClickUp comment per turn** in exactly this format:

```
[AGENT: <orchestrator|coder|reviewer|tester>] [RESULT: <RESULT>] [ROUND: <n>]
Summary: <1-3 lines>
Issues:
- <file:line> - <problem>
Next: <agent name | human>
```

Write `- none` under `Issues:` when there are none.

| Agent        | Allowed RESULT values                                                             |
| ------------ | --------------------------------------------------------------------------------- |
| orchestrator | STARTED (first comment), PASS (all green), NEEDS_HUMAN (out of rounds or blocked) |
| coder        | DONE_CODING                                                                       |
| reviewer     | APPROVED, CHANGES_NEEDED                                                          |
| tester       | PASS, FAIL                                                                        |

Example:

```
[AGENT: reviewer] [RESULT: CHANGES_NEEDED] [ROUND: 2]
Summary: Cart screen implements FR-12 but has no empty state.
Issues:
- src/features/cart/CartScreen.tsx:42 - no empty state (AC-21)
Next: coder
```

### Handoff file: `.agents/handoff/<taskId>.md`

- **Read it first** whenever you start work on a task. It is the shared memory between agents and between
  runs (it is git-ignored, so it survives branch switches).
- `cu comment` and `cu notify` append the comment there automatically.
- Append anything longer (files touched, commands run with results, reasoning, open questions) with
  `cu handoff <taskId> --file <path>`.
- Never delete or rewrite earlier entries; only append.

---

## 4. Quality gate and definition of ready for review

Quality gate (must all pass): `pnpm lint` · `pnpm test`.

A task may go to **ready for review** without `NEEDS_HUMAN` only when, in the same round:

1. reviewer: `APPROVED` (no blocking issues),
2. tester: `PASS` — the quality gate is clean, and every acceptance criterion the task names is covered by a
   test or listed as a MANUAL check for the human,
3. all work is committed on `task/<taskId>`, working tree clean.

---

## 5. Safety rules (all agents)

- Never set Done/Complete/Closed. Never push. Never force, rebase, reset or delete branches.
- Never read, print, edit or commit `.env` or any token.
- Never edit the agent kit's own files: `.opencode/`, `.agents/kit/`, `agent.config.json`, or the part of
  this file above the `<!-- PROJECT -->` marker.
- Skill for this project: `.agents/skills/backend-master/SKILL.md`.
