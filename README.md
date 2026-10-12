# Tossana Agent Kit

A kit that adds a multi-agent coding workflow (orchestrator → coder → reviewer → tester), driven by ClickUp tasks, to any project.

The full spec is in [TOSSANA_AGENT_KIT_PLAN.md](./TOSSANA_AGENT_KIT_PLAN.md).

## Packages

| Folder               | Package                | What it is                                                                       |
| -------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `packages/core`      | `@tossana/agents-core` | ClickUp client, Done guard, config, comment protocol                             |
| `packages/cli`       | `@tossana/agents`      | The `tossana-agents` command                                                     |
| `packages/templates` | (bundled into the CLI) | Agent files, `AGENTS.base.md`, Antigravity skills + subagents, skills            |
| `apps/dashboard`     | (not published)        | Team dashboard (v1 preview: sample data, `pnpm --filter @tossana/dashboard dev`) |

## Commands

```
tossana-agents init                     # set up a project (asks a few questions; --yes for none)
tossana-agents doctor                   # check everything; shows how to fix each problem
tossana-agents run --task <taskId>      # run one task through the agents (--next, --all, --dry-run, --no-agent)
tossana-agents update                   # update kit files to the installed version
tossana-agents clickup <command>        # ClickUp commands used by the agents (get, comment, status, ...)
```

## Guides

- [Getting started](./docs/getting-started.md): install, init, doctor, run one task
- [ClickUp setup](./docs/clickup-setup.md): the 6 statuses, list templates, the wrong-account mistake
- [How the agents work](./docs/agents.md): roles, comment format, handoff files, the Done rule
- [Antigravity](./docs/antigravity.md): `/start-task` and checking the subagent tool names
- [Claude Code](./docs/claude-code.md): agent files, the guard hook, headless runs
- [Codex](./docs/codex.md): agent files, sandbox and rules, trusting the project
- [Windows](./docs/windows.md): PowerShell 7 or Windows Terminal recommended
- [Maintaining the kit](./docs/maintaining.md): how to release a new version

## Develop

Needs Node.js 20.19+ and pnpm (`npm i -g pnpm`).

```
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```
