# Tossana Agent Kit

A kit that adds a multi-agent coding workflow (orchestrator → coder → reviewer → tester), driven by ClickUp tasks, to any project.

The full spec is in [TOSSANA_AGENT_KIT_PLAN.md](./TOSSANA_AGENT_KIT_PLAN.md).

## Packages

| Folder               | Package                | What it is                                                            |
| -------------------- | ---------------------- | --------------------------------------------------------------------- |
| `packages/core`      | `@tossana/agents-core` | ClickUp client, Done guard, config, comment protocol                  |
| `packages/cli`       | `@tossana/agents`      | The `tossana-agents` command                                          |
| `packages/templates` | (bundled into the CLI) | Agent files, `AGENTS.base.md`, Antigravity skills + subagents, skills |
| `apps/dashboard`     | (later)                | Team dashboard                                                        |

## Commands

```
tossana-agents init                     # set up a project (asks a few questions; --yes for none)
tossana-agents doctor                   # check everything; shows how to fix each problem
tossana-agents run --task <taskId>      # run one task through the agents (--next, --all, --dry-run, --no-agent)
tossana-agents update                   # update kit files to the installed version
tossana-agents clickup <command>        # ClickUp commands used by the agents (get, comment, status, ...)
```

On Windows, see [docs/windows.md](./docs/windows.md) (PowerShell 7 or Windows Terminal recommended).

## Develop

Needs Node.js 20.19+ and pnpm (`npm i -g pnpm`).

```
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```
