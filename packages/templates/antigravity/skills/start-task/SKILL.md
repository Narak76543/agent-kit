---
name: start-task
description: Run one ClickUp task through coder -> reviewer -> tester (max {{pipeline.maxRounds}} rounds) and hand it to the human as "{{statuses.human}}". Use when the user says /start-task <taskId> or asks to work on a ClickUp task. Never sets Done.
---

# /start-task <taskId>

The task ID is the argument after `/start-task`. If none was given, ask for it and stop.

> **Running in OpenCode?** Don't use this skill. Use the `orchestrator` agent instead (Tab in the TUI), or
> run `{{kit.cmd}} run --task <taskId>`, so the OpenCode permission rules apply. Then stop.

You are the **orchestrator** in the main conversation. The procedure is shared with OpenCode and lives in
one file: **read `.opencode/agents/orchestrator.md` and follow its body exactly** (ignore its YAML
frontmatter: that is OpenCode permission config). `AGENTS.md` rules always apply.

## Before step 0 of the procedure

The procedure expects the task branch to exist. Run `git branch --show-current`. If it is not
`{{pipeline.branchPrefix}}<taskId>`, run `{{kit.cmd}} run --task <taskId> --no-agent` once (it checks the task,
refuses a dirty tree and creates or switches to the branch). If that command fails, report its output and stop.
{{figma.startTask}}

## How to "invoke" a role in Antigravity

When the procedure says to invoke `coder`, `reviewer` or `tester`:

1. Start the workspace custom subagent with that name (defined in `.agents/agents/<role>.md`).
   - Use workspace mode **inherit** (same working tree). Never `branch` or `share`: the work must land on
     the git branch `{{pipeline.branchPrefix}}<taskId>` in this checkout.
   - Subagents start without your conversation history, so give them everything in the prompt: task ID,
     round number, task name + description, spec pages and FR/AC codes, and (round > 1) the exact Issues
     from the previous round and any human feedback.
2. If custom subagents are unavailable or the subagent fails to start, play the role yourself in this
   conversation, following `.opencode/agents/<role>.md` strictly, including its limits: as **reviewer** do
   not edit any file; as **tester** edit test files only. Post that role's comment with its own
   `[AGENT: <role>]` tag. Say in the handoff file that roles were played inline.

The `reviewer` subagent has no file-writing tools, so it cannot write its comment file. Post its report for it:
write the report unchanged (it starts with `[AGENT: reviewer]`) to `.tossana/tmp/<taskId>-reviewer.md` and run
`{{kit.cmd}} clickup comment <taskId> --file .tossana/tmp/<taskId>-reviewer.md`.

Run subagents one at a time, in order (coder → reviewer → tester). Never in parallel: they share one
working tree.

## Hard stops

- Never set the task to Done / Complete / Closed. Stop at "{{statuses.human}}".
- If a `{{kit.cmd}}` command prints `BLOCKED`, stop and report. Never work around it.
- Never push, merge, or delete branches. Never read `.env`.
