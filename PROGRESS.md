# Progress

Status of the Tossana Agent Kit build. Read this first when you continue the work (in OpenCode or any other tool).
The full spec is [TOSSANA_AGENT_KIT_PLAN.md](./TOSSANA_AGENT_KIT_PLAN.md). This file records what is done, what is next,
and every decision that changes or clarifies the spec.

Last updated: 2026-10-09 (start of Phase 2)

## Phase status

| Phase                  | Status         | Notes                                                             |
| ---------------------- | -------------- | ----------------------------------------------------------------- |
| 0 — Setup              | ✅ Done        | CI written but never run (nothing pushed yet)                     |
| 1 — Core               | ✅ Done        | 168 tests; guard + protocol at 100% coverage                      |
| 2 — CLI                | 🚧 In progress | Priority: clickup commands → doctor → init → run → update         |
| 3 — Templates          | ⏳ Not started | Antigravity, skills, check agent files in OpenCode, one real task |
| 4 — Second project     | ⏳ Not started | Project not chosen yet                                            |
| 5 — Dashboard          | ⏳ Not started | Will be built later with another tool                             |
| 6 — Distribution, docs | ⏳ Not started |                                                                   |

## How to work on this repo

```
pnpm install
pnpm check        # lint + format check + typecheck + tests (stops at the first failure)
pnpm build
pnpm coverage     # tests + 100% coverage gate for guard.ts and protocol.ts (CI runs this)
pnpm format       # fix formatting
```

- Node 24 locally (team: Node 20.19+). pnpm 12, pinned with `packageManager` in `package.json`.
- Windows + PowerShell is the main platform. Use `node:path`, no bash-only scripts.
- Small commits, one logical change each. **Never push** unless the user asks.
- Check current docs (OpenCode, ClickUp) instead of guessing formats or flags.
- EKMONG_MOBILE (the project the kit was extracted from) is at `D:\Ek-Mobile`. **Read only. Never modify it.**

## Where things are

| Path                            | What                                                                       |
| ------------------------------- | -------------------------------------------------------------------------- |
| `packages/core/src/clickup/`    | `client.ts` (REST v2 + Docs v3), `guard.ts`, `rate-limiter.ts`, `types.ts` |
| `packages/core/src/protocol.ts` | Agent comment format/parse (single source of truth)                        |
| `packages/core/src/config.ts`   | `agent.config.json` zod schema, JSON Schema, `.env` loader                 |
| `packages/core/src/handoff.ts`  | `.agents/handoff/<taskId>.md`                                              |
| `packages/core/src/detect.ts`   | Project type / skill / package manager / commands                          |
| `packages/core/src/logger.ts`   | Token redaction; the only place core writes output                         |
| `packages/cli/`                 | `tossana-agents` command (Phase 2)                                         |
| `packages/templates/`           | Agent templates (Phase 2/3)                                                |
| `*.test.ts` next to each module | vitest; HTTP is faked by injecting `fetch` (`fake-api.test-helper.ts`)     |

## Decisions (beyond or different from the spec)

### Setup (Phase 0)

- TypeScript **5.9**, not 7.x: tsup's d.ts build and typescript-eslint do not support 7 yet.
- Tests and typecheck use core's **source** (vitest alias + `source` export condition), so no build is needed first.
- `allowBuilds: esbuild: true` in `pnpm-workspace.yaml` (pnpm 12 blocks install scripts by default).
- ESLint `no-console` is on in core except `logger.ts`. `no-non-null-assertion` is off (needed with `noUncheckedIndexedAccess`).
- CI: ubuntu + windows × Node 20/22/24.

### Core (Phase 1)

- **Comment protocol:** the parser accepts both the plan's bullet `Issues:` list and EKMONG's one-line form
  (`Issues: a.ts:1 - x; b.ts:2 - y` or `Issues: none`). The formatter always writes bullets (`- none` when empty).
- **Done guard allow-list** = the 5 role statuses from config, including "to do". Forbidden words
  (done/complete/closed) and ClickUp status type done/closed are always refused. Refusal exits with code 2.
- **Config additions** (all optional): `clickup.workspaceId`, `clickup.customTaskIds`, `clickup.docs.{ids,outDir}`,
  `pipeline.baseBranch` (default `main`), `pipeline.timeoutMinutes` (default 120). The old EKMONG `.env` variables
  `CLICKUP_WORKSPACE_ID`, `CLICKUP_CUSTOM_TASK_IDS`, `CLICKUP_DOC_IDS`, `CLICKUP_DOCS_OUT` still override them.
  `CLICKUP_LIST_ID` and `CLICKUP_AGENT_STATUSES` are replaced by `clickup.listId` and the role statuses.
- Config is rejected when a role maps to a done-like status or two roles share one status.
- `sync-docs` (ClickUp Docs API v3) and custom task IDs (`EKM-123`) are kept as optional features.
  Docs endpoint verified against the official v3 OpenAPI spec (`getDocPagesPublic`): returns an array of pages.
- `getTask` sends `include_markdown_description=true` (the old script read the field but never requested it).
- `X-RateLimit-Reset` is accepted in seconds or milliseconds (ClickUp docs do not say which).
- Default final status for all projects: **"ready for review"** (EKMONG's "Ready for Narak" will be renamed by the user).

### CLI (Phase 2) — agreed before starting

- **`run` creates/switches the task branch** (not the orchestrator). The orchestrator only checks
  `git branch --show-current` and stops if it is wrong. `run --task <id> --no-agent` prepares the branch only,
  for people who then work in OpenCode/Antigravity interactively.
- **No `--auto`** for `opencode run`. Templates are default-deny with only allow/deny rules (never `ask`), and every
  tool not explicitly allowed is denied, so a non-interactive run can never hang on a permission prompt.
- **Agents call the kit as `{{kit.cmd}}`**: `npx tossana-agents` in Node projects (devDependency), `tossana-agents`
  elsewhere (global install). Permission rules allow both.
- **Existing `AGENTS.md` without the `<!-- PROJECT -->` marker**: kit section goes on top, the old content is kept
  unchanged below the marker.
- **Runners:** `opencode` and `custom` (`AGENT_CMD` with `{agent}`, `{prompt}`, and the old `{taskId}`), plus
  `antigravity`, which only prints instructions. The `claude-code` adapter is skipped for now.
- Processes are spawned with `cross-spawn` (Node 20+ cannot spawn `.cmd` shims without a shell on Windows).
- A test-only ClickUp base URL override is accepted **only for localhost**, so a `.env` cannot redirect the token.
- If PowerShell 5.1 breaks quotes in arguments: templates always use `--file` or stdin for comment text, and the docs
  recommend PowerShell 7 or Windows Terminal.

## Open questions / waiting on the user

- Skills folder path (`backend-master`, `flutter-master`, `frontend-master`, `mobile-master`). If not given by
  Phase 3, create placeholder skill folders.
- Phase 4 project, GitHub org, company email domain, dashboard hosting, dashboard token: later phases.

## Next steps

1. Phase 2 in this order: CLI skeleton → token error hints → `clickup` subcommands → `doctor` → templates + `init`
   → `run` → `update`.
2. At the end of Phase 2: PowerShell script for the user to test against real ClickUp with their own token.
