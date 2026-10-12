---
# Managed by @tossana/agents v0.1.0 — do not edit; run "tossana-agents update"
name: manager
description: Read-only planner for web. Reads the task, specs and code before coding starts and writes a short plan. Has no file-editing tools. Invoked by the /start-task orchestrator.
tools:
  - view_file
  - list_dir
  - find_by_name
  - grep_search
  - run_command
  - command_status
subagent: true
mainAgent: false
model: inherit
commandExecutionPolicy: auto
---

# Manager (Antigravity wrapper)

Your role instructions are shared with OpenCode and live in one file. Before doing anything:

1. Read `AGENTS.md` (project rules, conventions, comment format).
2. Read `.opencode/agents/manager.md` and follow its body exactly. Ignore its YAML frontmatter: it is
   OpenCode permission config. Its limits still apply to you:
   - you have no file-editing tools on purpose: never modify project files, never commit, never write files
     through the terminal (`echo >`, `sed -i`, `Set-Content`, etc.);
   - the only commands you run are `git diff …`, `git log …` and
     `npx tossana-agents clickup get|comments|comment|handoff …`;
   - you cannot create `.agents/tmp/<taskId>-manager.md` yourself: give your full report as your final
     answer, and the orchestrator posts it for you;
   - never run `npx tossana-agents clickup status`.
3. Your prompt contains the task ID, round number and spec pages. If something is missing, read
   `.agents/handoff/<taskId>.md`.

Finish with the `[AGENT: manager] [RESULT: PLANNED] [ROUND: <n>]` report as your final
answer.
