# How the agents work

## The four agents

| Agent            | Job                                                                        | May edit                                 |
| ---------------- | -------------------------------------------------------------------------- | ---------------------------------------- |
| **orchestrator** | Runs one task from start to end. Calls the others. Sets statuses.          | Only its comment file                    |
| **coder**        | Writes the code on branch `task/<taskId>` and commits.                     | Project code (not kit files, not `.env`) |
| **reviewer**     | Reads the diff and checks it against the task, specs and `AGENTS.md`.      | Nothing (read only)                      |
| **tester**       | Runs lint, type check and tests. Writes tests for the acceptance criteria. | Test files only                          |

The agent files are in `.opencode/agents/` (OpenCode) and `.agents/agents/` (Antigravity).
The rules for all agents are in `AGENTS.md`.

## One task, step by step

```
run --task 86abc  →  branch task/86abc  →  orchestrator
                                              │
          ┌───────────────────────────────────┘
          ▼
  round 1..5:  coder ──► reviewer ──► tester
                 ▲          │            │
                 └── CHANGES_NEEDED      │
                 └────────────────── FAIL
                                         │ PASS
                                         ▼
                              status "ready for review" + notify
```

1. The orchestrator reads the task, its comments and the handoff file. It posts `STARTED` and sets **coding**.
2. **Coder** writes code and commits. Result: `DONE_CODING`.
3. Status **in review**. **Reviewer** checks. `CHANGES_NEEDED` → back to the coder with the issues.
4. Status **testing**. **Tester** runs the checks. `FAIL` → back to the coder with the issues.
5. `APPROVED` and `PASS` in the same round → status **ready for review**, comment `PASS`, notification to the owner.
6. After 5 rounds without success → status **ready for review**, comment `NEEDS_HUMAN` with what keeps failing.
7. If something is missing or broken (no access, unclear task) → comment `NEEDS_HUMAN`, status unchanged, stop.

The number of rounds is `pipeline.maxRounds` in `agent.config.json` (default 5).

## The comment format

Every agent posts one comment per step, always in this format:

```
[AGENT: <orchestrator|coder|reviewer|tester>] [RESULT: <RESULT>] [ROUND: <n>]
Summary: <1-3 lines>
Issues:
- <file:line> - <problem>
Next: <agent name | human>
```

| Agent        | RESULT values              |
| ------------ | -------------------------- |
| orchestrator | STARTED, PASS, NEEDS_HUMAN |
| coder        | DONE_CODING                |
| reviewer     | APPROVED, CHANGES_NEEDED   |
| tester       | PASS, FAIL                 |

Programs (like the team dashboard) read these comments, so the first line must be exact.

**Comments from humans** have no `[AGENT: …]` tag. The agents treat them as instructions from the owner.
They are stronger than earlier agent decisions.

## The handoff file

`.agents/handoff/<taskId>.md` is the shared memory of a task:

- Every agent comment is also added there.
- Agents add longer notes: files changed, commands and results, open questions.
- Agents read it first. Later rounds and later runs continue from it.
- It is git-ignored, so it stays when you switch branches. Nobody deletes old entries.

## The Done rule

**Agents never set a task to Done, Complete or Closed.** Only a human does that, after checking the work.

This is not just a rule in the text. It is enforced in code:

- `tossana-agents clickup status` refuses any status named done/complete/closed, and any status of the
  ClickUp type Done or Closed. It prints `BLOCKED` and exits with code 2.
- The agents may only set the 5 role statuses from `agent.config.json`.
- The OpenCode permission rules also deny these commands.

The agents also never push, merge, delete branches, or read `.env`.

## Permissions (OpenCode)

Each OpenCode agent file starts with `"*": deny`: every tool and command is refused unless it is allowed
in the file. There is no "ask", so an agent can never wait forever for a permission prompt in a `run`.
To post a comment, an agent writes the text to `.agents/tmp/<taskId>-<agent>.md` and runs
`clickup comment <taskId> --file …` (quotes in command lines break on Windows).

Do not edit the agent files by hand: `tossana-agents update` would ask to replace them. Put project rules in
`AGENTS.md` below `<!-- PROJECT -->` instead.

## Custom roles (optional)

By default the pipeline is coder → reviewer → tester. A project can list its own roles, in order, in
`agent.config.json`:

```json
"roles": [
  { "name": "manager", "preset": "read-only", "purpose": "Split the task into small steps." },
  { "name": "coder", "preset": "edit-code", "skills": ["frontend-master", "our-api"] },
  { "name": "security-reviewer", "preset": "read-only", "purpose": "Check auth, input validation and secrets." },
  { "name": "tester", "preset": "edit-tests-only" }
]
```

| Field     | Meaning                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `name`    | lower-case with single hyphens; not `orchestrator` (the kit always adds it)                           |
| `preset`  | `read-only`, `edit-code` or `edit-tests-only` — the permissions; the locked rules apply to every role |
| `purpose` | optional; one or two lines added to the role's instructions                                           |
| `skills`  | optional; default is `project.skill`; several are allowed                                             |
| `mcp`     | optional; only servers from the approved list (for now `figma`, which needs `figma.enabled`)          |
| `status`  | optional; the ClickUp status while the role works: `coding`, `review` or `testing`                    |

How the orchestrator uses them:

- Roles **before** the first `edit-code` role are **planners**: they run once and report `PLANNED`.
- `edit-code` roles write the code (`DONE_CODING`).
- Roles **after** it are **checks**: `CHANGES_NEEDED` or `FAIL` sends the work back to the first `edit-code` role
  for the next round; when every check passes, the task goes to "ready for review".

Run `npx tossana-agents update` after changing `roles`: it writes one agent file per role for each tool and
removes the files of roles you deleted.

## Skills: three places

A skill name is looked up in this order (the first one found wins):

1. **Project:** `.agents/skills/<name>/SKILL.md` in the repo (commit it; the whole team uses it).
2. **User:** `~/.agents/skills/<name>/SKILL.md` on your own computer (only you; never uploaded).
3. **Team:** the skills that come with the kit (copied into `.agents/skills/` by `init`/`update`).

So a project can replace a team skill by adding its own skill with the same name.
