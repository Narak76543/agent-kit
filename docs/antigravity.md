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

## Figma in Antigravity

If the project uses Figma (`figma.enabled` in `agent.config.json`, see
[getting-started.md](./getting-started.md#figma-designs-optional)), `init` writes the project MCP config
`.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "figma": { "serverUrl": "http://127.0.0.1:3845/mcp" }
  }
}
```

Antigravity reads this file for the workspace (the per-user file `~/.gemini/config/mcp_config.json` is not
needed). Figma lists Antigravity in its MCP catalog as **local server only, read only**, so use the desktop server.

Steps for each developer:

1. Open the Figma desktop app, log in with your own account (Dev or Full seat), open a design file, press
   Shift+D (Dev Mode) and click **Enable desktop MCP server**.
2. Open the project in Antigravity. Open **Agent settings → Customizations → MCP servers**. `figma` should be
   listed and connected. If not, click refresh, or check that the Figma app is still open.
3. Test it in the chat: "Use the figma MCP server to call whoami." It should answer with your Figma account.
4. Then use `/start-task <taskId>` as usual.

In Antigravity, the main agent (the orchestrator) reads each Figma frame once and saves a summary to the handoff
file. The coder and reviewer subagents use that summary, because subagents may not have the Figma tools.

## `/explore`

Type `/explore` to refresh the synced ClickUp specs (`clickup sync-docs`) and update the project part of
`AGENTS.md` (below `<!-- PROJECT -->`) so it matches the code. It changes no other files.
