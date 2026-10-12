# Using the kit in Antigravity

Antigravity has no command-line runner, so `tossana-agents run` cannot start it. You start the task in the
Antigravity chat instead. The agents follow the same rules and post the same ClickUp comments as in OpenCode.

## What `init` adds for Antigravity

| File                                                  | What it is                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `AGENTS.md`                                           | Rules for all agents. Antigravity reads it automatically.    |
| `.agents/skills/start-task/SKILL.md`                  | The `/start-task <taskId>` command (runs one task)           |
| `.agents/skills/explore/SKILL.md`                     | The `/explore` command (refresh specs and the project notes) |
| `.agents/skills/<skill>/SKILL.md`                     | The coding skill for this project type                       |
| `.agents/agents/coder.md`, `reviewer.md`, `tester.md` | Subagents. They follow `.opencode/agents/<role>.md`.         |

There is one copy of each role's instructions (in `.opencode/agents/`). The Antigravity files only point to
them, so both tools always do the same thing.

## Run a task

1. Make sure your work is committed (the git tree must be clean).
2. Prepare the branch in a terminal (optional, `/start-task` does it too):
   ```
   npx tossana-agents run --task <taskId> --no-agent
   ```
3. Open the project folder in Antigravity.
4. In the agent chat, type:
   ```
   /start-task <taskId>
   ```
5. The main agent acts as the orchestrator. It starts the `coder`, `reviewer` and `tester` subagents one after
   another, in the same working folder (workspace mode **inherit**).
6. At the end, the task is **ready for review** in ClickUp, the same as with OpenCode.

If the subagents cannot start, the main agent plays each role itself and says so in the handoff file.

**Important:** in Antigravity, the limits (reviewer edits nothing, tester edits only tests, never set Done)
are only instructions. OpenCode enforces them with permission rules. The Done rule is still enforced by the
`tossana-agents clickup status` command in both tools.

## Check the subagent tool names

The subagent files list the tools each role may use:

```yaml
tools:
  - view_file
  - list_dir
  - find_by_name
  - grep_search
  - write_to_file
  - replace_file_content
  - multi_replace_file_content
  - run_command
  - command_status
```

The Antigravity docs warn that **a wrong tool name can make a subagent hang**. The docs only show four of these
names (`view_file`, `replace_file_content`, `grep_search`, `run_command`), so check the others once:

1. Open a project with the kit in Antigravity.
2. Open the **Customizations** menu (agents / skills). `coder`, `reviewer` and `tester` should be listed
   without errors, and `start-task`, `explore` should be listed as skills.
3. In the chat, ask: "List the exact names of all tools you can use." Compare them with the list above.
4. Test one subagent with a harmless job, for example: "Start the reviewer subagent (workspace mode inherit)
   and ask it to list the files in the project root." It should answer in under a minute.
5. If a name is wrong: tell the kit maintainer. The fix goes in `packages/templates/antigravity/agents/`.
   Do not edit the files in the project (`update` would replace them).

## `/explore`

Type `/explore` to refresh the synced ClickUp specs (`clickup sync-docs`) and update the project part of
`AGENTS.md` (below `<!-- PROJECT -->`) so it matches the code. It changes no other files.
