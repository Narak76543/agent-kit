# Tossana Agent Kit

A kit that adds a multi-agent coding workflow (orchestrator → coder → reviewer → tester), driven by ClickUp tasks, to any project.

The full spec is in [TOSSANA_AGENT_KIT_PLAN.md](./TOSSANA_AGENT_KIT_PLAN.md).

## Packages

| Folder               | Package                | What it is                                                   |
| -------------------- | ---------------------- | ------------------------------------------------------------ |
| `packages/core`      | `@tossana/agents-core` | ClickUp client, Done guard, config, comment protocol         |
| `packages/cli`       | `@tossana/agents`      | The `tossana-agents` command                                 |
| `packages/templates` | (bundled into the CLI) | Agent files, `AGENTS.base.md`, Antigravity workflows, skills |
| `apps/dashboard`     | (later)                | Team dashboard                                               |

## Develop

Needs Node.js 20.19+ and pnpm (`npm i -g pnpm`).

```
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```
