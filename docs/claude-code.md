# Using the kit with Claude Code

Turn it on with `npx tossana-agents init --tools claude-code` (or pick "Claude Code" when `init` asks which tools
the team uses; several tools are allowed). Then set `"runner": "claude-code"` under `pipeline` in
`agent.config.json` if `run` should start Claude Code.

## What `init` adds

| File                                | Owner        | What it is                                                                 |
| ----------------------------------- | ------------ | -------------------------------------------------------------------------- |
| `.claude/agents/<role>.md`          | kit          | One subagent per role, plus `orchestrator`. Same instructions as OpenCode. |
| `.claude/tossana-run.settings.json` | kit          | Allow/deny rules, used only by `tossana-agents run`                        |
| `.claude/settings.json`             | you (merged) | The kit adds one `PreToolUse` hook: `tossana-agents guard`                 |
| `CLAUDE.md`                         | you (merged) | The kit adds the line `@AGENTS.md`, so Claude reads the project rules      |
| `.mcp.json`                         | you (merged) | A `figma` server, only when Figma is on                                    |

"Merged" means the kit only adds or removes its own entry. Your other settings stay.

## How the limits work

Claude Code's permission rules apply to the whole project, not to one agent. So the kit adds a hook: before every
tool call of an agent, Claude Code runs `tossana-agents guard`, which knows the role and blocks what the role may
not do (the same presets as in OpenCode: reviewer read-only, tester test files only, coder no history rewrite,
nobody pushes or sets Done). A blocked call shows `BLOCKED by the Tossana agent kit: …`.

- In your **own** Claude Code sessions (no agent selected), the guard does nothing.
- If the kit is not installed, the hook cannot start, and Claude Code then lets the call through. `doctor` checks
  this ("Guard command can run"). Keep `@tossana/agents` in `devDependencies` and install it.

## Run a task

```
npx tossana-agents run --task <taskId>
```

With `runner: "claude-code"` this starts
`claude -p "<task>" --agent orchestrator --permission-mode dontAsk --settings .claude/tossana-run.settings.json`.
`dontAsk` means anything not allowed is refused instead of asking, so a run never waits for you.

You can also work interactively: `claude --agent orchestrator`, then "Work on ClickUp task <taskId>". The guard
applies there too.
