# Using the kit with Codex

Turn it on with `npx tossana-agents init --tools codex` (or pick "Codex" when `init` asks; several tools are
allowed). Set `"runner": "codex"` under `pipeline` in `agent.config.json` if `run` should start Codex.

**Once per developer:** open the project folder in Codex (`codex`) and choose to **trust** it. Codex ignores the
project's `.codex/` folder (agents, rules, config) in projects that are not trusted. `doctor` checks this.

## What `init` adds

| File                         | Owner | What it is                                                                           |
| ---------------------------- | ----- | ------------------------------------------------------------------------------------ |
| `.codex/agents/<role>.toml`  | kit   | One custom agent per role. Read-only roles get `sandbox_mode = "read-only"`.         |
| `.codex/orchestrator.md`     | kit   | The orchestrator instructions for the main Codex session                             |
| `.codex/rules/tossana.rules` | kit   | Forbidden commands (push, history rewrite) and commands that run outside the sandbox |
| `.codex/config.toml`         | kit\* | `approval_policy = "never"`, `sandbox_mode = "workspace-write"`, Figma if on         |

\* Only when the file does not exist yet. If you already have a `.codex/config.toml`, the kit does not change it and
prints the lines to add.

## How the limits work

- **Sandbox:** in `workspace-write`, Codex can change project files but keeps `.git`, `.agents/` and `.codex/`
  read-only, and has no network. That is why comment drafts live in `.tossana/tmp/`.
- **Rules:** `git add` / `git commit` (they write to `.git`) and `tossana-agents clickup …` (it needs network) are
  `allow` rules, so they run outside the sandbox. `git push`, `git reset`, `rebase`, `merge`, `checkout`, `switch`,
  `commit --amend` and deleting branches are `forbidden`. The kit's ClickUp command itself refuses Done.
- **Per role:** Codex rules apply to the whole project, so "tester edits test files only" is only an instruction
  there (like in Antigravity). The reviewer and planners are really read-only (their sandbox is `read-only`); the
  orchestrator posts their comments for them.

## Run a task

```
npx tossana-agents run --task <taskId>
```

With `runner: "codex"` this starts `codex exec --sandbox workspace-write -c approval_policy=never "<task> You are
the orchestrator: read .codex/orchestrator.md …"`. Nothing waits for approval: a command that is not allowed fails
and the agent reports it.
