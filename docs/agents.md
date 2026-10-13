# How the agents work

## The agents

| Agent            | Job                                                                         | May edit                                 |
| ---------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| **coder**        | Writes the code on branch `task/<taskId>` and commits.                      | Project code (not kit files, not `.env`) |
| **reviewer**     | Reads the diff and checks it against the task, specs and `AGENTS.md`.       | Nothing (read only)                      |
| **tester**       | Runs lint, type check and tests. Writes tests for the acceptance criteria.  | Test files only                          |
| **orchestrator** | Optional: runs the roles as subagents (`/start-task`, `--ai-orchestrator`). | Only its comment file                    |

The agent files are in `.opencode/agents/` (OpenCode), `.agents/agents/` (Antigravity), `.claude/agents/` (Claude
Code) and `.codex/agents/` (Codex). The rules for all agents are in `AGENTS.md`.

Every role is a **top-level agent**: it shows in `agy agents` / `/agents` and can be started on its own
(`agy --agent coder`, `opencode run --agent coder`, `claude --agent coder`). It is still a subagent too, so
`/start-task` in the IDE works as before.

## One task, step by step

`run` and `watch` run the pipeline **in the kit's code**. Each role is a separate headless agent, started one after
the other, so the order is always the same and you can watch each one.

```
run --task 86abc  →  branch task/86abc  →  the kit
                                              │
          ┌───────────────────────────────────┘
          ▼
  round 1..5:  coder ──► reviewer ──► tester        (each one its own agent and its own log)
                 ▲          │            │
                 └── CHANGES_NEEDED      │
                 └────────────────── FAIL
                                         │ PASS
                                         ▼
                              status "ready for review" + notify
```

1. The kit posts `STARTED` and sets **coding**.
2. It writes a **brief** for the role (`.tossana/tmp/<taskId>-r<round>-<role>-brief.md`: task, round, the issues
   to fix, the owner's feedback) and starts the role, e.g. `agy -p "You are the coder for ClickUp task 86abc,
round 1. Read your brief first: …" --agent coder`.
3. **Coder** writes code and commits. Result: `DONE_CODING`.
4. Status **in review**. **Reviewer** checks. `CHANGES_NEEDED` → next round, back to the coder with the issues.
5. Status **testing**. **Tester** runs the checks. `FAIL` → next round, back to the coder with the issues.
6. `APPROVED` and `PASS` in the same round → status **ready for review**, comment `PASS`, notification to the owner.
7. After 5 rounds without success → status **ready for review**, comment `NEEDS_HUMAN` with what keeps failing.
8. A role reports `NEEDS_HUMAN` (missing information, broken environment) → comment `NEEDS_HUMAN`, status unchanged,
   stop.

The number of rounds is `pipeline.maxRounds` in `agent.config.json` (default 5). `pipeline.timeoutMinutes` (default 120) is the limit for each agent.

**How the kit reads a role's result**, in this order:

1. the role's ClickUp comment posted while it ran;
2. otherwise its comment draft `.tossana/tmp/<taskId>-<role>.md`, which the kit posts;
3. otherwise the `[AGENT: …] [RESULT: …]` report in its final answer, which the kit posts (the Antigravity and Codex
   reviewers cannot write files, so this is their normal way).

**Rules the kit applies:**

- **No result** from a role (none of the three) = a failed round: the next round starts at the coder.
- **The same role without a result twice in a row** = stop with `NEEDS_HUMAN` (the remaining rounds are not used).
- **No new commit from the coder**, or uncommitted changes left by the coder or tester = a failed round, with that
  as the issue for the next round.

The agents never set a ClickUp status; the kit does.

**Resume** (`run --task <id> --resume`, or `watch` after Ctrl+C): the kit reads the comments and continues after
the last role that reported. A role that was stopped before it reported runs again. Feedback from the owner
(`feedback`, or a comment picked up by `watch`) starts a new round at the coder.

**The AI orchestrator** is still there: `run --ai-orchestrator` (and `watch --ai-orchestrator`) start the
orchestrator agent, which calls the roles as subagents in one process, as before. `/start-task` in the IDE works
that way too.

## Watching the agents

Every role has its own log, in the project's main folder (also when the task runs in a worktree):

| File                                         | What                                                          |
| -------------------------------------------- | ------------------------------------------------------------- |
| `.agents/logs/<taskId>/<round>-<role>.log`   | What the agent did: its text, each command or file it used    |
| `.agents/logs/<taskId>/<round>-<role>.jsonl` | The raw events (Antigravity and Claude Code only)             |
| `.agents/logs/<taskId>/pipeline.log`         | The kit's lines: statuses, each result, decisions, `FINISHED` |

Watch them live, from the project folder, while `run` or `watch` works:

```
npx tossana-agents follow <taskId>                  # everything, lines prefixed [kit], [r1 coder], [r1 reviewer] …
npx tossana-agents follow <taskId> --role coder     # only the coder, round after round
npx tossana-agents follow <taskId> --split          # one terminal per role
```

- `follow` waits for the run to start and stops when the pipeline finishes. Ctrl+C stops only `follow`, never the
  agents.
- `--split` opens panes in **iTerm2** and **Windows Terminal**, and one window per role in **macOS Terminal**. In
  any other terminal it prints the commands; open a terminal for each.
- Antigravity and Claude Code only print their final answer in text mode, so the kit runs them with
  `--output-format stream-json` and turns the events into readable lines. If a tool changes its event format, the
  raw lines are shown instead; nothing is lost.

## The comment format

Every agent posts one comment per step, always in this format:

```
[AGENT: <orchestrator|coder|reviewer|tester>] [RESULT: <RESULT>] [ROUND: <n>]
Summary: <1-3 lines>
Issues:
- <file:line> - <problem>
Next: <agent name | human>
```

| Agent        | RESULT values                                  |
| ------------ | ---------------------------------------------- |
| orchestrator | STARTED, PASS, NEEDS_HUMAN (posted by the kit) |
| coder        | DONE_CODING                                    |
| reviewer     | APPROVED, CHANGES_NEEDED                       |
| tester       | PASS, FAIL                                     |

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
To post a comment, an agent writes the text to `.tossana/tmp/<taskId>-<agent>.md` and runs
`clickup comment <taskId> --file …` (quotes in command lines break on Windows).

Do not edit the agent files by hand: `tossana-agents update` would ask to replace them. Put project rules in
`AGENTS.md` below `<!-- PROJECT -->` instead.

## Custom roles (advanced, off by default)

The pipeline is fixed: orchestrator → coder → reviewer → tester → ready for review. To change what an agent knows,
change its **skills** instead (see "Customize your agents" in [getting-started.md](./getting-started.md)).

Only if a project really needs its own roles or order, switch on the advanced option and list the roles in
`agent.config.json`. The locked rules still apply to every role.

```json
"advanced": { "customRoles": true },
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
