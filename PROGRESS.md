# Progress

Status of the Tossana Agent Kit build. Read this first when you continue the work (in OpenCode or any other tool).
The full spec is [TOSSANA_AGENT_KIT_PLAN.md](./TOSSANA_AGENT_KIT_PLAN.md). This file records what is done, what is next,
and every decision that changes or clarifies the spec.

Last updated: 2026-10-12 (Phase 3 templates built; waiting on ClickUp statuses for the real task)

## Phase status

| Phase                  | Status         | Notes                                                          |
| ---------------------- | -------------- | -------------------------------------------------------------- |
| 0 — Setup              | ✅ Done        | CI written but never run (nothing pushed yet)                  |
| 1 — Core               | ✅ Done        | 168 tests; guard + protocol at 100% coverage                   |
| 2 — CLI                | 🟡 Built       | Only doctor's status check fails (list has no custom statuses) |
| 3 — Templates          | 🟡 Built       | 318 tests; left: init in Ek-Mobile-test + one real task        |
| 4 — Second project     | ⏳ Not started | Project not chosen yet                                         |
| 5 — Dashboard          | ⏳ Not started | Will be built later with another tool                          |
| 6 — Distribution, docs | ⏳ Not started |                                                                |

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

| Path                                    | What                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/core/src/clickup/`            | `client.ts` (REST v2 + Docs v3), `guard.ts`, `rate-limiter.ts`, `types.ts`                |
| `packages/core/src/protocol.ts`         | Agent comment format/parse (single source of truth)                                       |
| `packages/core/src/config.ts`           | `agent.config.json` zod schema, JSON Schema, `.env` loader                                |
| `packages/core/src/handoff.ts`          | `.agents/handoff/<taskId>.md`                                                             |
| `packages/core/src/detect.ts`           | Project type / skill / package manager / commands                                         |
| `packages/core/src/logger.ts`           | Token redaction; the only place core writes output                                        |
| `packages/cli/src/commands/`            | `clickup`, `doctor`, `init`, `run`, `update`                                              |
| `packages/cli/src/`                     | `kit-files.ts` (manifest/backup/marker), `templates.ts`, `template-vars.ts`, `runners.ts` |
| `scripts/phase2-real-clickup-check.ps1` | Manual check against real ClickUp (user runs it)                                          |
| `docs/windows.md`                       | PowerShell 5.1 quotes, exit codes                                                         |
| `packages/templates/`                   | Agent templates (Phase 2/3)                                                               |
| `*.test.ts` next to each module         | vitest; HTTP is faked by injecting `fetch` (`fake-api.test-helper.ts`)                    |

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

### CLI (Phase 2) — found while building

- **PowerShell 5.1 drops embedded double quotes** in native-command arguments (verified, and kept as an e2e test).
  Agents write comment text to `.agents/tmp/<taskId>-<agent>.md` with their edit tool and pass `--file`; the CLI
  deletes that file after a successful post. Every agent may edit `.agents/tmp/*` only (coder: everything except
  `.opencode/`, `.agents/`, `.git/`, `.env*`, `agent.config.json`). See `docs/windows.md`.
- **OpenCode's shell on Windows varies** (cmd / PowerShell / Git Bash, reported in opencode issues #4683, #8396), so
  agent prompts never rely on shell quoting or heredocs.
- **Permissions verified in real OpenCode 1.18.35** (`opencode agent list`): OpenCode puts its defaults first
  (`doom_loop: ask`, `external_directory: ask`) and the agent's rules after; our leading `"*": deny` overrides every
  `ask`. OpenCode appends its own tool-output folder allow at the end, so truncated output stays readable.
- Agent comment results: orchestrator posts `STARTED` first, `PASS` on success, `NEEDS_HUMAN` when out of rounds
  or blocked (EKMONG used `FAIL` for those).
- `.agents/kit/manifest.json` stores the sha256 of every kit file as written. `init`/`update`: untouched → update;
  edited → keep (no terminal) or diff + confirm; `--force` replaces; a file that existed before the kit is backed
  up to `.agents/kit/backup/<timestamp>/` and replaced. Every replace makes a backup.
- `AGENTS.md`: only the part above a `<!-- PROJECT -->` line (marker on its own line; the kit text also mentions
  it inline) is kit-owned. The part below is kept byte for byte (CRLF too).
- `.gitignore`: init adds `.env`, `.env.*`, `!.env.example`, `.agents/handoff/`, `.agents/logs/`, `.agents/tmp/`,
  `.agents/kit/backup/` unless an equivalent rule exists (`.env*`, `.agents/` …). A new `.env.*` is always followed
  by `!.env.example` (found on the EKMONG copy: `.env.example` would have been ignored).
- `init` writes `pipeline` in full (defaults included) so people can see the settings; `$schema` only in Node projects.
- `run` keeps EKMONG's behaviour: re-check status before starting, refuse a dirty tree, switch back to the base
  branch after each task, stop if the agent leaves uncommitted changes, timeout, Ctrl+C. Output is redacted line by
  line (a token split across chunks is still caught). On Windows the agent's process tree is killed with `taskkill /T`.
- `doctor` checks run without custom task IDs (it only reads the user and the list). Dependent checks are `skip`.
- CLI uses commander **14** (15 needs Node 22.12+). Build: `tsup && node scripts/postbuild.mjs` (copies
  `packages/templates` into `packages/cli/templates`, writes `packages/cli/schema/agent.config.schema.json`).
- Templates are excluded from Prettier (exact formatting matters).

## Phase 2 results

- 301 tests (core + CLI in-process + 9 PowerShell 5.1 e2e against a local fake ClickUp server).
- `init --yes` on a copy of `D:\Ek-Mobile` (robocopy without `node_modules` and `.env`): old agents backed up and
  replaced with default-deny ones, old `AGENTS.md` kept byte for byte below the marker, `.gitignore` only got
  `.agents/tmp/` and `.agents/kit/backup/`, second run changed nothing, `opencode agent list` loads all four agents.
- Not yet run by the user against real ClickUp: `scripts/phase2-real-clickup-check.ps1`.

## Open questions / waiting on the user

- Skills folder path (`backend-master`, `flutter-master`, `frontend-master`, `mobile-master`). Placeholders exist in
  `packages/templates/skills/` and are shipped as-is until the user gives the path.
- Result of `scripts/phase2-real-clickup-check.ps1` with the user's token.
- Phase 4 project, GitHub org, company email domain, dashboard hosting, dashboard token: later phases.

## Next steps

1. The user fixes the statuses on the test list. Then: read-only doctor → Phase 2 done.
2. `init` in `D:\Ek-Mobile-test` against the test list (token only via the process environment), `pnpm install`.
3. The user runs task `z8qu5d2v09` (AppText) from To Do to Ready for Review and watches it.
4. Someone with Antigravity checks that `/start-task` and the three subagents load (tool names are unverified).

## Test data in the personal ClickUp test workspace (2026-10-10)

- `scripts/copy-test-data.ts` (one-off, no IDs in the file): copies local Markdown specs into one ClickUp doc and
  creates tasks from a JSON file. Every non-GET request passes `scripts/write-fence.ts` (only the target workspace;
  the source client can never write). Always `--dry-run` first.
- Done: the EKMONG spec doc (28 pages, from the git-ignored `.local/ekmong-docs/clickup/`) and 5 small test tasks
  (status "to do", no assignee) in the test list. IDs are kept out of the repo.
- Learned: ClickUp refuses docs created at Workspace level (create them in a Space); it rejects tables with an
  unescaped `|` inside a code span (`--escape-table-pipes`); Create Task uses `markdown_content`.
- `sync-docs` round trip: 20/28 pages identical; the rest differ only by ClickUp's Markdown export (escapes, list
  numbering, empty `>` lines). No text lost. Headings are no longer doubled.
- Read-only Phase 2 checks against the test list: all PASS except `doctor` → the list still has the default statuses
  (to do / in progress / complete). Waiting for the user to set custom statuses on the list.

## Session 2026-10-12

- Read-only doctor against the test list: 13 ok, 1 failed ("Role statuses exist on the list"). The API still
  returns to do / in progress / complete for every list and Space, and the list has `override_statuses=false`
  (it inherits the Space's statuses). Board view columns are not proof; `tossana-agents clickup statuses` is.
  Phase 2 stays open until doctor is green.
- `D:\Ek-Mobile-test` created with `git clone --no-hardlinks D:\Ek-Mobile` (original only read). It holds the
  committed app only: the old pipeline files in `D:\Ek-Mobile` (`.agents/`, `.opencode/`, `AGENTS.md`,
  `docs/clickup/`, `scripts/clickup.ts`, `scripts/run-pipeline.ts`) are untracked there, so `init` in the clone is a
  fresh install, not an upgrade. No `.env`, no `node_modules`.
- Antigravity format checked (antigravity.google/docs, 2026-10-12): skills in `.agents/skills/<name>/SKILL.md`
  (`.agent/` is legacy), invokable as `/<name>`; custom subagents in `.agents/agents/<name>.md`; rules read
  `AGENTS.md` automatically. Workflows are being migrated to skills. EKMONG's files already use this format.

### Phase 3 — built 2026-10-12

- **Antigravity templates** (`packages/templates/antigravity/`): `/start-task` and `/explore` as skills in
  `.agents/skills/`, and `coder`/`reviewer`/`tester` subagent wrappers in `.agents/agents/` (ported from EKMONG, which
  already used the current layout). No separate rule file: Antigravity reads `AGENTS.md` itself. `/start-task`
  runs `run --task <id> --no-agent` when the branch is wrong, then follows `.opencode/agents/orchestrator.md`.
  The reviewer has no write tools, so the orchestrator posts the reviewer's comment for it.
- **Unverified:** the subagent `tools` names (EKMONG's IDE names: `view_file`, `list_dir`, `find_by_name`,
  `grep_search`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `run_command`,
  `command_status`). The docs only confirm four of them and warn that a wrong name can make a subagent hang;
  the SDK uses other names. Check in a real Antigravity session.
- **Skill folder moved** from `.agents/kit/skills/<skill>/` to `.agents/skills/<skill>/` (Antigravity finds it there).
  No migration: only test copies had the old path.
- init now writes 11 kit files (was 6).
- **Real OpenCode 1.18.35 check** (temp project, orchestrator agent): writing `.agents/tmp/T1-orchestrator.md`
  allowed (OpenCode matches it as `.agents\tmp\*`), editing `README.md` denied; token in no file except `.env`.
- **Bug found and fixed:** OpenCode takes its project folder from `PWD` when set. With `--cwd` or a stale `PWD`
  (Git Bash, tool shells) it ran in the wrong folder, could not find `orchestrator` and failed with `UnknownError`.
  `run` now passes `--dir <project>` to `opencode run` and sets `PWD` for every agent process.

### After Phase 3 (2026-10-12, user-approved list; no ClickUp writes until the test account is sorted out)

- The user had been logged in to the wrong ClickUp account, so the custom statuses and the "Agent Test" Space were
  made in a workspace the token cannot see.
- **Item 1 — wrong-account hint (done):** when the list cannot be read or role statuses are missing, `doctor` prints
  a `HINT:` line naming the token's workspace(s) (one extra `GET /team`, only on failure). `clickup statuses` and
  `init` print the same hint with their missing-status warning.
- **Item 2 — Phase 6 docs (done):** `docs/getting-started.md`, `clickup-setup.md`, `agents.md`, `maintaining.md`,
  `antigravity.md`, linked from the README. The publish registry is still open (`maintaining.md` says so).
- **Item 3 — packaging (done):** `@tossana/agents-core` is bundled into the CLI (tsup `noExternal`), moved to the
  CLI's devDependencies, and marked `private`; `zod` is now a CLI dependency. Packed tarball installed with npm in
  a temp project outside the monorepo, path with spaces and an apostrophe: `--version`, `init --help`, `doctor`
  without token (exit 1, FIX lines, no stack trace), `init --yes --list 123` without token (all 11 files) all work.
  Script: session scratchpad `pack-test.ps1` (not in the repo).
- **Item 4 — Phase 4 prep (done, no code changes needed):** a minimal Next.js 16 project (create-next-app shape,
  npm, `tsconfig.json`, `app/page.tsx`) in a temp folder with a space, `init --yes --list L1` against a local fake
  ClickUp (`TOSSANA_CLICKUP_API_URL=http://127.0.0.1:…`): type `nextjs`, skill `frontend-master`, npm, commands
  `npm install` / `npm run lint` / `npx tsc --noEmit` (no `test`: create-next-app has no test script, so the gate is
  lint + typecheck until the project adds one), folder tree `app/`, doctor 14/14 green, `run --dry-run` shows
  `--dir`, `opencode agent list` loads all four agents. Scripts: session scratchpad `p4/` (not in the repo).
- **Item 5 — dashboard preview (started):** `apps/dashboard`, Next.js 16.4 (App Router, Turbopack) + Tailwind 4,
  light mode, Google Sans Flex (Google Fonts). Data from `fixtures/tasks.json` (8 tasks, 2 projects, protocol
  comments) parsed with core's `parseAgentComment`; core is used from the workspace (built first by `predev`/
  `prebuild`). Screens: pipeline board (5 role columns, card = project, task, last agent + result badge, round,
  assignee, time in status; NEEDS_HUMAN sorted first and outlined red; "new comment from a human"; project/assignee
  filters in the URL) and task timeline. Auto-refresh 60 s. No auth, no ClickUp, no Needs-human/Stats screens yet.
  Run: `pnpm --filter @tossana/dashboard dev` → http://localhost:3100. Checked with Playwright + installed Edge at
  1440 px and 390 px: no horizontal overflow. (Headless Edge alone cannot go below ~500 px wide.)
- **Item 6 — Figma (queued, not started):** optional Figma MCP (read-only), asked by `init`; see the user's request
  of 2026-10-12. Ask before starting if time is short.
