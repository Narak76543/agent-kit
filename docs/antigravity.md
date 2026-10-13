# Using the kit in Antigravity

Two ways to run a task with Antigravity:

- **From the terminal or the Local Console** with the Antigravity CLI (`agy`): `tossana-agents run` starts it
  headless, like OpenCode or Codex. See "Run a task with agy" below.
- **In the Antigravity app or the agy chat**: type `/start-task <taskId>`.

The agents follow the same rules and post the same ClickUp comments as in OpenCode.

## What `init` adds for Antigravity

| File                                                       | What it is                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `AGENTS.md`                                                | Rules for all agents. Antigravity reads it automatically.     |
| `.agents/skills/start-task/SKILL.md`                       | The `/start-task <taskId>` command (runs one task)            |
| `.agents/skills/explore/SKILL.md`                          | The `/explore` command (refresh specs and the project notes)  |
| `.agents/skills/<skill>/SKILL.md`                          | The coding skill for this project type                        |
| `.agents/agents/<role>/agent.md` (coder, reviewer, tester) | Subagents. They follow `.opencode/agents/<role>.md`.          |
| `.agents/agents/orchestrator/agent.md`                     | The main agent for headless runs (`agy --agent orchestrator`) |

There is one copy of each role's instructions (in `.opencode/agents/`). The Antigravity files only point to
them, so both tools always do the same thing.

Antigravity finds agents as **folders**: `.agents/agents/<name>/agent.md` (and `~/.gemini/config/agents/<name>/agent.md`
for your own global agents). Older kit versions wrote flat files (`.agents/agents/coder.md`); `tossana-agents update`
moves them (your local edits are kept). Check what Antigravity sees with `agy agents` in the project folder.

## Run a task with agy (headless)

Once per computer and project:

1. Install the Antigravity CLI and run `agy` once **in the project folder**: log in, and choose to **trust** the
   folder. agy does not load the project's agents in a folder it does not trust.
2. Allow the commands the agents need:
   ```
   npx tossana-agents antigravity permissions
   ```
   In headless mode agy quietly refuses every command that is not allowed (the run goes on and does nothing
   useful). This adds narrow rules to `~/.gemini/antigravity-cli/settings.json`: the kit's `clickup` commands,
   read-only git, `git add`, `git commit -m` and your lint/typecheck/test commands. It shows them first, asks, and
   keeps a backup. It never allows `git push`. agy only reads these rules from that file (there is no project
   file), so they apply to every agy session on your computer.
3. `npx tossana-agents doctor` checks both (Antigravity rows).

Then, like any other tool:

```
npx tossana-agents run --task <taskId> --runner antigravity --dry-run
npx tossana-agents run --task <taskId> --runner antigravity
```

The kit prepares the branch, then runs `agy -p "<prompt>" --agent orchestrator --print-timeout <minutes>m`. It
does not use `--dangerously-skip-permissions`. If doctor finds rules like `command(git)` or `command(*)` in your
agy settings, remove them: they would let an agent push.

## Run a task in the app (/start-task)

1. Make sure your work is committed (the git tree must be clean).
2. Prepare the branch in a terminal (optional, `/start-task` does it too):
   ```
   npx tossana-agents run --task <taskId> --no-agent
   ```
3. Open the project folder in Antigravity (or run `agy` there).
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

## Check that agy can start every agent

Each agent file lists the tools its role may use (the reviewer gets no file-writing tools). agy refuses to start an
agent whose list names a tool it does not know (`unknown component: tool "…" not found in registry`), before any
work is done. Checked with agy 1.3.3, these names are accepted: `view_file`, `list_dir`, `find_by_name`,
`grep_search`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `edit_file`, `run_command`,
`invoke_subagent`, `define_subagent`, `read_url_content`, `search_web`, `ask_question`. Not accepted:
`command_status`, `send_command_input`, `read_terminal`, `list_directory`, `view_file_outline`, `view_code_item`,
`codebase_search`, `code_search`, `notify_user`.

To check the agents of a project on your computer:

```
npx tossana-agents antigravity check
```

It starts each agent once with "Reply with the single word pong" (one short model call each; subagents are started
as a temporary copy, because agy only starts main agents directly). The result is remembered until agy or the agent
files change. `run --runner antigravity` does the same check first when it is not remembered, and doctor shows it.
