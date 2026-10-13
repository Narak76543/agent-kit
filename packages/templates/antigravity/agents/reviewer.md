---
name: {{role.name}}
description: {{role.agDescription}}
tools:
  - view_file
  - list_dir
  - find_by_name
  - grep_search
  - run_command
subagent: true
mainAgent: true
model: inherit
commandExecutionPolicy: auto
---

# {{role.title}} (Antigravity wrapper)

Your role instructions are shared with OpenCode and live in one file. Before doing anything:

1. Read `AGENTS.md` (project rules, conventions, comment format).
2. Read `.opencode/agents/{{role.name}}.md` and follow its body exactly. Ignore its YAML frontmatter: it is
   OpenCode permission config. Its limits still apply to you:
   - you have no file-editing tools on purpose: never modify project files, never commit, never write files
     through the terminal (`echo >`, `sed -i`, `Set-Content`, etc.);
   - the only commands you run are `git diff …`, `git log …` and
     `{{kit.cmd}} clickup get|comments|comment|handoff …`;
   - you cannot create `.tossana/tmp/<taskId>-{{role.name}}.md` yourself: give your full report as your final
     answer, and `tossana-agents run` (or the orchestrator) posts it for you;
   - never run `{{kit.cmd}} clickup status`.
3. Your prompt names your brief (`.tossana/tmp/<taskId>-r<n>-{{role.name}}-brief.md`) or, from the orchestrator,
   contains the task ID, round number and spec pages. If something is missing, read `.agents/handoff/<taskId>.md`.

{{agy.commands}}

Finish with the `[AGENT: {{role.name}}] [RESULT: {{role.results}}] [ROUND: <n>]` report as your final
answer.
