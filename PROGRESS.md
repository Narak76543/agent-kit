# Progress

Status of the Tossana Agent Kit build. Read this first when you continue the work (in OpenCode or any other tool).
The full spec is [TOSSANA_AGENT_KIT_PLAN.md](./TOSSANA_AGENT_KIT_PLAN.md). This file records what is done, what is next,
and every decision that changes or clarifies the spec.

Last updated: 2026-10-13 (agent profiles; see "Next steps")

## Phase status

| Phase                     | Status      | Notes                                                                |
| ------------------------- | ----------- | -------------------------------------------------------------------- |
| 0 — Setup                 | ✅ Done     | CI written but never run (nothing pushed yet)                        |
| 1 — Core                  | ✅ Done     | 168 tests; guard + protocol at 100% coverage                         |
| 2 — CLI                   | ✅ Done     | doctor all ✅ against the real test list (2026-10-13)                |
| 3 — Templates             | 🟡 Built    | 328 tests (with Figma); left: one real task, Antigravity check       |
| 4 — Second project        | 🟡 Prepared | Next.js sample checked, no code changes needed; real project TBD     |
| 5 — Dashboard             | 🟡 Started  | Board + timeline on sample data; no ClickUp, no login yet            |
| 6 — Distribution, docs    | 🟡 Started  | Docs written; tarball tested; registry not chosen                    |
| 7 — Roles, tools, library | 🟡 a–d done | Roles, skill scopes, Claude Code, Codex; library repo + editing next |
| 8 — Local Console (UI)    | 🟡 1–3 done | `tossana-agents ui`: health, my tasks, live run; screens 4–6 next    |
| 9 — Agent profiles        | ✅ Built    | Named agents (tool + skills + MCP): CLI, console, dashboard          |

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

| Path                                    | What                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/core/src/clickup/`            | `client.ts` (REST v2 + Docs v3), `guard.ts`, `rate-limiter.ts`, `types.ts`                 |
| `packages/core/src/protocol.ts`         | Agent comment format/parse (single source of truth)                                        |
| `packages/core/src/config.ts`           | `agent.config.json` zod schema, JSON Schema, `.env` loader                                 |
| `packages/core/src/handoff.ts`          | `.agents/handoff/<taskId>.md`                                                              |
| `packages/core/src/detect.ts`           | Project type / skill / package manager / commands                                          |
| `packages/core/src/logger.ts`           | Token redaction; the only place core writes output                                         |
| `packages/cli/src/commands/`            | `clickup`, `doctor`, `init`, `run`, `update`                                               |
| `packages/cli/src/`                     | `kit-files.ts` (manifest/backup/marker), `templates.ts`, `template-vars.ts`, `runners.ts`  |
| `scripts/phase2-real-clickup-check.ps1` | Manual check against real ClickUp (user runs it)                                           |
| `docs/windows.md`                       | PowerShell 5.1 quotes, exit codes                                                          |
| `packages/cli/src/figma.ts`             | Optional Figma MCP config merge + doctor checks (`packages/templates/figma/`)              |
| `apps/dashboard/`                       | Dashboard preview (Next.js, `fixtures/tasks.json`); `pnpm --filter @tossana/dashboard dev` |
| `docs/`                                 | User guides: getting started, ClickUp setup, agents, Antigravity, Windows, maintaining     |
| `packages/templates/`                   | Agent templates (Phase 2/3)                                                                |
| `packages/cli/src/console/`             | Local Console: `security.ts`, `server.ts`, `app.ts` (actions), `web/` (the page)           |
| `packages/design-tokens/`               | `tokens.css`: colors and radii for the dashboard and the Local Console                     |
| `*.test.ts` next to each module         | vitest; HTTP is faked by injecting `fetch` (`fake-api.test-helper.ts`)                     |

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

## Next steps (handover — read this first)

State on 2026-10-12: Phases 0–3 built, Phase 6 docs written, Phase 4 checked on a Next.js sample, Phase 5 started
(preview on sample data), optional Figma support added. 328 tests, `pnpm check` green. Nothing is pushed.
IDs of the personal test workspace are kept out of this repo on purpose (see the local notes, not git).

1. ✅ **Real ClickUp test (done 2026-10-13).** Space "Agent Test" in the token's account, with to do / coding, in
   review, testing, ready for review / done (done group) / complete (closed). Both "done" and "complete" are refused
   by the Done guard twice (name and ClickUp type). The list is still named "List" in the API (the rename to
   "EKMONG Test" did not take; harmless). Read-only doctor against it: all ClickUp checks ✅. The 5 test tasks were
   re-created there (status "to do", **no assignee**; new IDs, kept out of the repo).
2. **First real agent run (AppText task).** Ready (2026-10-13):
   - Done: the kit is installed in `D:\Ek-Mobile-test` from the packed tarball (`vendor/tossana-agents-0.1.0.tgz`,
     `pnpm add -D`), `init --yes --list <listId> --tools opencode --no-figma`, `pnpm install`, kit files committed in
     the clone. Doctor there: 14 ✅. `.env` (git-ignored) has the token and `CLICKUP_OWNER_USER_ID` of the second
     test member (Antiz Perfect), so the Ready for Review / Needs-human notifications go to that account.
   - Note: init only saves the token when it asks for it (interactive), so with `--yes` the `.env` was written first.
   - Note: the tasks have no assignee, so "My tasks" in the Local Console and `run --next/--all` show nothing until
     the tasks are assigned to the token's user; `run --task <id>` works either way.
   - The user runs it and watches: `npx tossana-agents run --task <AppText task ID>` in `D:\Ek-Mobile-test`
     (`--dry-run` first), or from the Local Console (`npx tossana-agents ui`). Expect statuses to move coding → in
     review → testing → ready for review, one comment per step, a branch `task/<id>`, and never Done. Log:
     `.agents/logs/`.
   - Write down what went wrong (prompts, permissions, timeouts) and fix the templates.
3. **Antigravity check** (someone with Antigravity): steps in `docs/antigravity.md` → "Check the subagent tool
   names". The `tools` names in `packages/templates/antigravity/agents/*.md` are unverified (only 4 of 9 are in the
   docs; a wrong name can hang a subagent). Also check that `/start-task` and `/explore` show up as skills, and
   (if Figma is used) that `.agents/mcp_config.json` connects.
4. **Figma, real test** (optional): a task with a Figma frame link, Figma desktop app open (Dev/Full seat), run it,
   check that the frame is read once and summarised in the handoff file. If OpenCode ever appears in Figma's MCP
   catalog, `figma.server: "remote"` becomes an option.
5. **Dashboard, rest of Phase 5** (`apps/dashboard`, plan §10):
   - Real data: server-side ClickUp reads with a `DASHBOARD_CLICKUP_TOKEN` (read-only bot account),
     `dashboard.config.json` with the projects, 30–60 s cache; replace `lib/data.ts`'s fixture reader.
   - Login: Auth.js with Google, only the company email domain (**ask the user for the domain**).
   - Screens: **Needs human** (tasks in the human status, NEEDS_HUMAN first) and **Stats** (ready-for-review per
     week, average rounds, common reviewer issues, first-round pass rate).
   - Deploy: ask the user (Vercel or internal server); add a `Dockerfile` either way.
6. **Phase 7 — plug-and-play roles, tools and team library** (design: plan §12 "Phase 7"). Steps a–d are **done**
   (see the Phase 7 sections at the end). Left, in order:
   - **Real runs per tool:** one task through Claude Code (`runner: "claude-code"`) and, on a machine with Codex,
     one through Codex (`runner: "codex"`; trust the project first). Codex output is unit-tested only.
   - **Antigravity:** custom-role names in `/start-task` and the Figma snippets (still say coder/reviewer/tester).
   - **Dashboard:** show the real tool per task (from the run log or a `[TOOL: …]` note in the STARTED comment —
     needs a small protocol addition), plus the rest of Phase 5 (real ClickUp data, login, Needs-human, Stats).
   - **Team library:** the `tossana-agent-library` repo with pinned versions in `init`/`update`, dashboard editing
     via pull requests, login with viewer/editor/approver roles. Open questions: GitHub org and repo, who approves,
     GitHub App or token for PRs.
7. **Local Console, rest of Phase 8** (plan §12 "Phase 8"):
   - **Look at it in a browser once** (not done yet: no browser in the 2026-10-13 session; the API and page were
     checked with curl and tests): `tossana-agents ui` in `D:\Ek-Mobile-test`, all three screens, both themes,
     phone width. Then one real run from the console with Stop pressed mid-run.
   - Screen 4: setup wizard (`init` as a form). Screen 6: `update` with a diff preview. Every write behind a
     confirmation. (Screen 5, the roles & skills editor, was replaced by agent profiles, Phase 9.)
   - Agent profiles, by hand: create one in the console on Windows and on a Mac, run a task with it in
     `D:\Ek-Mobile-test`, check the `[BY: …]` tag on every agent comment in ClickUp.
   - The theme choice is per console start (random port = new origin = new localStorage). Fine for now.
8. **Later:** real skills content (waiting for the skills folder path), Phase 4 on a real second project, publish
   registry (GitHub Packages under `@tossana`?) and the first release (`docs/maintaining.md`), push + run CI once.

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
- **Item 6 — Figma (done):** `figma.enabled` / `figma.server` in `agent.config.json`; `init` asks (default yes for
  UI project types, no for `node-backend`/`other`; `--yes` keeps the existing value, else off; `--figma`/`--no-figma`).
  The kit merges only its `figma` entry into `opencode.json` (`mcp`) and `.agents/mcp_config.json` (`mcpServers`,
  the documented Antigravity **workspace** MCP file — not only the global one, as first assumed). Default server is
  **desktop** (`http://127.0.0.1:3845/mcp`, Figma app, no token): Figma's remote server (`https://mcp.figma.com/mcp`,
  OAuth) only accepts clients in its MCP catalog, which lists Antigravity as "local server only" and does not list
  OpenCode. Coder and reviewer get 5 read-only tools (`figma_get_design_context`, `_get_metadata`,
  `_get_variable_defs`, `_get_screenshot`, `_whoami`); everything else stays denied. Instructions (only when
  enabled): orchestrator passes `figma.com` links on; coder reads each frame once and saves a `## Figma <link>`
  summary to the handoff file; reviewer compares against it; "Figma not available" → NEEDS_HUMAN. In Antigravity the
  main agent reads the frame (subagents may lack MCP tools). doctor: both configs, desktop server reachable (warn),
  seat note (View/Collab = 20 calls/month). Real OpenCode 1.18.35: config loads, `figma_*` permissions applied to
  coder and reviewer only; with the Figma app closed, `opencode run` still finishes (it logs "server unavailable").

### Phase 7 (a) — read-only library pages (done 2026-10-12)

- `apps/dashboard`: Agents (list + detail), Skills (list + rendered SKILL.md), MCP catalog, Projects, plus a nav bar.
  Data: `fixtures/library.json` (shaped like the future `tossana-agent-library`); the four agents' permission
  blocks are the **real** rendered OpenCode files of a sample RN project (generated by a scratch script from an
  `init --figma` run). `lib/permissions.ts` turns the rules into "Can" / "Never" lines in plain English
  (last-match-wins, Windows-path duplicates hidden, locked rules marked 🔒); the raw rules are in a `<details>`.
- Board cards show the tool that ran the task; the task page shows the project's roles in order (current role
  highlighted) and "Ran with <tool>". Tool per task is sample data for now (later: from the run log / comment).
- Checked with Playwright + Edge at 1440 px and 390 px on all pages: no horizontal overflow, Google Sans Flex loads.

### Phase 7 (b) — configurable roles + skill scopes (done 2026-10-12)

- `agent.config.json` → optional `roles` (in order): `name` (kebab-case, not `orchestrator`), `preset`
  (`read-only` | `edit-code` | `edit-tests-only`), `purpose`, `skills` (default `[project.skill]`), `mcp`
  (catalog: `figma`, needs `figma.enabled`), `status` (`coding` | `review` | `testing`, default from preset).
  Validation: unique names, at least one `edit-code`, roles before the first `edit-code` must be `read-only`.
  Core: `pipelineRoles(config)` (default = coder → reviewer → tester), kinds `plan` / `code` / `check`.
- Protocol: any kebab-case role name is a valid `[AGENT: …]`; new result `PLANNED` (planners).
- Templates are **preset templates** with `{{role.*}}` / `{{pipeline.*}}` placeholders (`packages/cli/src/role-vars.ts`):
  planner (new) / coder / reviewer / tester; the default loop text lives in `templates/orchestrator/loop-default.md`,
  custom pipelines get a generated loop (plan once → code roles → checks in order, any failure back to the first
  coder). **Golden tests** (`packages/cli/src/__golden__/`, `UPDATE_GOLDEN=1` to accept) prove the default output is
  byte-identical to before; a `custom-roles` golden case shows the custom output.
- Skills: `resolveSkill` = project `.agents/skills/<n>` (not kit-written, per manifest) → user `~/.agents/skills/<n>` →
  team (bundled). Only team skills are copied; agents get the resolved path. `init` accepts a project/user skill as
  `project.skill`. Docs: `docs/agents.md` → "Custom roles", "Skills: three places".
- Known gaps: the Antigravity `/start-task` text and the Figma snippets still name coder/reviewer/tester in places
  (fine for the default; slightly off for custom roles). Per-role `mcp` other than figma waits for the library catalog.
- Dashboard: Agents page text is generic (no project name), the orchestrator card says "Runs the pipeline"; the
  Projects page shows each project's quality-gate commands.

### Phase 7 (c) — Claude Code (done 2026-10-12)

- `agent.config.json` → `tools` (`opencode`, `antigravity`, `claude-code`; default the first two, so existing
  projects and the golden files are unchanged). `init` asks (multi-select) or takes `--tools a,b`. OpenCode agent
  files are written when OpenCode **or** Antigravity is selected (the Antigravity wrappers read them).
- Claude Code files (docs checked 2026-10-12: sub-agents, permissions, hooks, headless):
  `.claude/agents/<role>.md` (+ `orchestrator`, tools per preset, `Agent(<roles>)` for the orchestrator, Figma
  `mcp__figma__*` read tools for Figma roles; body = the OpenCode instructions), kit-owned
  `.claude/tossana-run.settings.json` (allow = union of role commands + Edit/Write; deny = git push, `.env`).
  Merged, user entries kept: `.claude/settings.json` (one PreToolUse hook `… guard`, matcher `*`), `CLAUDE.md`
  (`@AGENTS.md` line), `.mcp.json` (`figma`, type `http`, only with Figma on).
- **Per-role limits = `tossana-agents guard`** (hidden command, `packages/cli/src/commands/guard.ts`, policies in
  `presets.ts`): reads the hook JSON, role from `agent_type`; locked rules + preset rules (commands by prefix, each
  part of `a && b; c | d` checked; edits by path; test-file globs; MCP tools; only the orchestrator may start roles;
  other tools default-deny). No `agent_type` (a developer's own session) → allowed. Errors → blocked (exit 2).
- `run` with `pipeline.runner: "claude-code"`: `claude -p <prompt> --agent orchestrator --permission-mode dontAsk
--settings .claude/tossana-run.settings.json`. doctor: Claude Code installed, guard hook present, **guard can run**
  (Claude Code lets a call through when a hook cannot start, so a missing kit = no limits).
- Real check (Claude Code 2.1.296, kit installed from the packed tarball into a temp project): `--agent coder` →
  `echo guard-test` was **blocked by the hook** with the kit's message; a reviewer run wrote its draft and refused the
  forbidden steps by itself. Script: session scratchpad `p4/claude-check.ps1`.
- Not done: a full task run through Claude Code against ClickUp (needs the test account fixed). Note: piping JSON
  into the `npx.cmd` shim from Windows PowerShell 5.1 loses stdin; Claude Code itself passes it fine.
- Docs: `docs/claude-code.md`.

### Phase 7 (d) — Codex + drafts folder (done 2026-10-12)

- **Drafts moved to `.tossana/tmp/`** for every tool (Codex docs, "Protected paths in writable roots": in
  `workspace-write`, `.git` is always read-only, `.agents` and `.codex` when they exist as folders). `init`/`update`
  move leftover drafts from `.agents/tmp/` once and git-ignore `.tossana/tmp/`. (A bulk rename briefly broke the
  move itself; fixed in `62e4f2d` with a test.)
- `tools` may include `codex`; `runner` may be `codex`. Kit-owned: `.codex/agents/<role>.toml` (`name`,
  `description`, `sandbox_mode` = `read-only` for read-only roles else `workspace-write`, `developer_instructions` =
  a short Codex note + the OpenCode instructions), `.codex/orchestrator.md` (main session; posts read-only roles'
  comments for them), `.codex/rules/tossana.rules` (`forbidden`: push, reset/rebase/merge/clean/switch/checkout,
  `commit --amend`, branch delete; `allow` = outside the sandbox: `git add|commit`, `tossana-agents clickup`, the
  install command). `.codex/config.toml` (`approval_policy = "never"`, `sandbox_mode = "workspace-write"`, Figma with
  `enabled_tools`) only when absent or kit-owned; a user's file is never changed (the kit prints what to add).
- `run`: `codex exec --sandbox workspace-write -c approval_policy=never "<task> You are the orchestrator: read
.codex/orchestrator.md …"` (Codex has no `--agent`). doctor: Codex installed; **project trusted** in
  `$CODEX_HOME/config.toml` (default `~/.codex`), because Codex ignores `.codex/` otherwise.
- Limits: Codex rules are project-wide, so "tests only" is an instruction there; read-only roles are enforced by
  their sandbox. **Not run against a real Codex** (not installed here) — formats are from the docs, covered by unit
  tests and the `all-tools` golden case (all four tools at once, for review).
- Docs: `docs/codex.md`. Tests: 364.

### Dashboard design: dark default + design tokens (2026-10-12)

- Dark mode is the default (near-black page `#121212`, cards `#1a1a1a`, thin borders, no shadows, one green accent
  `#3ecf8e` for the active tab, links and focus rings; Supabase-like feel, no brand assets). Light mode is optional:
  header toggle, remembered in localStorage (`tossana-theme`), applied by an inline script before first paint.
- **All colors and radii are tokens** in `apps/dashboard/app/globals.css` (`:root`/`[data-theme='dark']` and
  `[data-theme='light']`), mapped to Tailwind names (`bg-card`, `text-muted`, `bg-ok-bg`, `rounded-md` …). No
  hard-coded colors or shadows remain in components. Radii: 6px (`rounded-sm`: badges, buttons, inputs, chips), 8px
  (`rounded-md`: cards, columns), 10px max (`rounded-lg`); only tiny dots/check icons stay round.
- Contrast checked for every text/background token pair: dark ≥ 5.79:1, light ≥ 4.75:1.
- Plan §10.4 updated (dark default, light optional, radius 6/8/10px). The library fixture now shows `.tossana/tmp/`.

### Switching tools mid-task: `run --resume` (done 2026-10-12)

- `tossana-agents run --task <id> --resume [--runner opencode|claude-code|codex|antigravity] [--yes] [--dry-run]`
  (`packages/cli/src/commands/resume.ts`). `--runner` also works without `--resume` (one-run override).
- Only agent statuses (todo, coding, review, testing); `human` and closed are refused, nothing posted. Needs the
  existing `task/<id>` branch (kept, never reset). Leftover changes (tracked or new files) → confirm in a terminal,
  `--yes` otherwise, then commit `WIP: handoff from <previous tool>`; no → stop.
- The chosen tool's files must exist (`.opencode/agents/orchestrator.md`, `.claude/agents/orchestrator.md`,
  `.codex/orchestrator.md`, `.agents/skills/start-task/SKILL.md`), else the error gives the `init --tools` command.
- Every run now records `Run started with <runner>` in the handoff file; a resume records `Resumed with X after Y`.
  The previous tool = the last such entry ("an earlier run" if none, e.g. a task started by hand in an IDE).
- The kit posts `[AGENT: orchestrator] [RESULT: STARTED] [ROUND: <last round>]` "Resumed with X after Y …" (round and
  `Next` taken from the last agent comment), and the resume prompt tells the orchestrator to read the handoff file,
  the latest agent comment and `git log <base>..HEAD` first, continue from that round, redo an unfinished turn, and
  not post another STARTED. Antigravity: the kit prints `/start-task <id>` plus the resume text to paste.
- Codex: handoff notes are written by `tossana-agents clickup handoff/comment`, which `.codex/rules/tossana.rules`
  runs outside the sandbox (`.agents/` is read-only inside it); the rule now carries a handoff `match` example, so
  Codex validates it when it loads the rules. Not run against a real Codex (not installed here).
- Docs: `docs/getting-started.md` → "Switching tools mid-task". Tests: 11 new (375 total).

### Phase 8 (1–3) — Local Console (done 2026-10-13)

- `tossana-agents ui [--no-open]` (`packages/cli/src/console/`). Design: plan §12 "Phase 8". The Team Dashboard stays
  view-only for running agents; only the local console starts processes.
- **Not the Next.js app:** one self-contained `dist/console.html` (~21 KB: vanilla TS bundled by esbuild in
  `scripts/postbuild.mjs`, `@tossana/design-tokens/tokens.css` and `console.css` inlined) served by `node:http`.
  No new runtime dependencies (esbuild and design-tokens are devDependencies). Browser code is type-checked with DOM
  types by `src/console/web/tsconfig.json`.
- **Security** (`console/security.ts`, tests in `security.test.ts` + `server.test.ts`): 127.0.0.1 only, OS-chosen port,
  256-bit token per start; page needs `?token=`, API needs `Authorization: Bearer` (constant-time compare, token in the
  URL is not accepted for the API); Host must be `127.0.0.1:<port>`/`localhost:<port>` (DNS rebinding → 421); Origin
  must be ours and is required on POST; `Sec-Fetch-Site` cross-site refused; JSON-only POST bodies ≤ 64 KB; only
  GET/POST (no CORS answers); CSP with a per-response nonce, `no-referrer`, `DENY` framing, `no-store`.
- **No secrets in the browser:** every string in every response, and every log line, is redacted with the ClickUp token
  pattern plus all secret-looking values (`*TOKEN*`, `*KEY*`, `*SECRET*`, `*PASSWORD*`, `*_PAT`…) from `.env` and the
  process environment. The browser only sends a session token, never gets `.env`.
- **Same functions as the CLI:** doctor → `runDoctor`; preview → `runTasks({ dryRun })`; start → `runTasks({ task,
resume, runner, yes, signal })`; status → `lastResult` + handoff. Runner commands stay argv arrays.
- **Confirmations, enforced by the server:** a run needs a preview id (single use, 10 min). A resume with leftover
  changes on the task branch needs `confirmWip` (UI checkbox) before the "WIP: handoff from …" commit.
- **One run per project:** new `run-lock.ts` — `.agents/logs/run.lock` with the pid, taken by `run` itself (not by
  `--dry-run`), so CLI and console runs exclude each other; a lock whose process is gone is taken over.
- **Stop kills the whole tree:** Windows `taskkill /T /F` (as before); macOS/Linux now start the agent in its own
  process group (`detached`) and kill the group (before, only the agent pid got SIGTERM). The test starts a fake agent
  with a grandchild and checks both are gone after Stop, and after closing the console. Run on Windows here; the
  POSIX path runs in CI (never run yet).
- Screens: Project health (doctor cards, fix + hint, re-check), My tasks (assigned to me; Run for todo, Resume for
  coding/review/testing with a task branch; runner dropdown = tools whose files exist, plus custom when AGENT_CMD is
  set), Live run (streamed NDJSON log, status/role/round/last result/handoff every 15 s, Stop with a confirm dialog).
- Docs: `docs/getting-started.md` → "The Local Console". Tests: 44 new (419 total).

### Phase 9 — Agent profiles (built 2026-10-13)

- Design: plan §12 "Phase 9". A profile = name, optional initials + color (token names only), tool, skills, MCP
  servers. It runs the project's pipeline; its skills are **added** for the coding roles (`edit-code`) and read-only
  checks (default: coder and reviewer). Permissions and locked rules never change. Custom `roles` stay an advanced
  config option; the planned roles editor (Phase 8 screen 5) is replaced by this.
- **Schema** (`packages/core/src/profiles.ts`): strict zod object (unknown keys refused, so a token cannot be stored),
  one-line names without quotes/brackets, values that look like secrets refused (ClickUp tokens, `sk-`, `ghp_`, long
  random strings). Slug from the name (`Rei – Mobile` → `rei-mobile`); names without Latin letters need an id.
- **Storage** (`packages/cli/src/profiles.ts`): team `.agents/profiles/<id>.json` (committed), personal
  `~/.agents/profiles/<id>.json`. An id used in the other scope is refused. `ctx.home` (new) is a temp folder in
  tests, so tests never touch the real home folder.
- **Runs without template changes:** the handoff entry the kit writes at run start now says
  `Run started with codex as "Rei – Mobile"` (resume: `Resumed with codex as "…" after …`) and lists the skill files
  for the coder and reviewer; the orchestrator, coder and reviewer already read the handoff file first. The prompt
  names the profile. Skills that are not in the project (user skills, team skills not copied) are copied to
  `.tossana/tmp/skills/<name>/` (git-ignored, inside the workspace, readable by every tool and sandbox). A missing
  skill stops the run before anything changes. MCP servers stay per project; a profile that needs Figma in a project
  without it gets a warning with `init --figma`.
- **Protocol:** optional `[BY: Rei – Mobile · Codex]` after the round (backward compatible; `by` on parsed
  comments). Agents do not write it: `cu comment`/`cu notify` add it from the latest run entry of the handoff file;
  without a profile it names the tool (`[BY: Claude Code]`). The kit's resume comment carries it too.
- **CLI:** `tossana-agents agents list [--json] | create --name --tool [--id --skills --mcp --initials --color
--personal --replace] | delete <id> [--personal] --yes`; `run --task <id> --agent <id> [--runner <tool>]` (the
  runner override keeps the skills). `--agent <id>` and `--no-agent` share one commander option.
- **Local Console:** new **Agents** tab (cards with badge, tool installed/set up, skills with scope or "missing",
  MCP; New/Edit form: tool → name/id/badge/scope → skills with "create project skill" → MCP → review the file →
  Save). Every write needs `confirm: true` from the dialog (server-checked). **Run/Resume** dialog: Agent + Tool;
  the last agent is remembered per project in `.tossana/tmp/console.json`; a tool that is not installed or not set
  up is replaced by a usable one with a note ("skills are kept").
- **Dashboard:** `by` per task (newest `[BY: …]`, else the tool) on the board card and the task page ("Ran by"), and
  per timeline entry. Fixtures carry sample `[BY: …]` tags.
- Note: a new team profile is an untracked file; `run --resume` treats untracked files as leftovers (WIP commit). The
  console says to commit it.
- Tests: 31 new (452 total): schema and helpers, `[BY]` format/parse (protocol still 100%), `agents` commands,
  `run --agent` (dry run, handoff, staged skills, prompt, runner override, missing skill/unknown agent/tool not set
  up), resume with an agent, comment stamping, console Agents API (confirmations, secrets, personal folder, skills,
  run with a fallback tool, remembered choice).

### Antigravity CLI (agy): agent folders and a real run adapter (2026-10-13, branch `fix/antigravity-agents`)

- Found on the user's machine: Antigravity CLI 1.3.3 (`agy`) documents agents as
  `.agents/agents/<name>/agent.md` (workspace) and `~/.gemini/config/agents/<name>/agent.md` (global). The kit wrote
  flat files. Checked with `agy agents`: 1.3.3 also lists flat files, **but only in a trusted folder**; the real
  reason `D:\Ek-Mobile-test` showed no kit agents was that it was set up with `tools: ["opencode"]` only.
- Generator: `.agents/agents/<role>/agent.md` + a new main agent `.agents/agents/orchestrator/agent.md`
  (`mainAgent: true`, `subagent: false`, tools include `invoke_subagent`; it follows `/start-task`).
  `init`/`update` move old flat kit files and their manifest entries (`migrateAntigravityAgents`); edited files stay
  "edited locally", files the kit did not write are left alone (doctor warns about them).
- Run adapter `antigravity` is now headless: `agy -p <prompt> --agent orchestrator --print-timeout <timeout>m`
  (https://antigravity.google/docs/cli/headless). Before anything changes it checks (`preflight`, also shown in
  dry runs and in doctor): the folder is in `trustedWorkspaces`, and the kit's allow rules are in
  `~/.gemini/antigravity-cli/settings.json`. Headless agy soft-denies unapproved commands (exit 0), and agy only
  reads rules from that global file. New command `tossana-agents antigravity permissions [--yes]` adds narrow rules
  (kit `clickup`, read-only git, `git add`, `git commit -m`, project lint/typecheck/test) after a confirmation, with a
  backup. No `--dangerously-skip-permissions`, no deny rules written (they would be global and break the user's
  other projects); doctor warns about broad rules (`command(*)`, `command(git)`, `git push`).
- Tests: 9 new (461 total, PowerShell e2e included).

### agy tool names + agent check (2026-10-13, same branch)

- The first real run failed at once: `unknown component: tool "command_status" not found in registry` (agy 1.3.3).
  Tool names were then **tested against agy itself** (a probe agent with every candidate; agy rejects an unknown
  name before any model call). Accepted: view_file, list_dir, find_by_name, grep_search, write_to_file,
  replace_file_content, multi_replace_file_content, edit_file, run_command, invoke_subagent, define_subagent,
  read_url_content, search_web, ask_question. Rejected: command_status, send_command_input, read_terminal,
  list_directory, view_file_outline, view_code_item, codebase_search, code_search, notify_user.
- Removed `command_status` from the four agent templates. The tools lists stay: per the docs an agent without one
  gets no tools, and they keep the reviewer read-only (the permission rules cannot do that per agent).
- New `tossana-agents antigravity check`: starts each agent once with "Reply with the single word pong"
  (each as a temporary main-agent copy with the same tools and a trivial body). Remembered per agy version and
  agent files in `.tossana/tmp/agy-check.json`; `run --runner antigravity` runs it first when stale (dry runs do
  not); doctor shows it without starting agy.
- Tests: 7 new (468 total).
- Found while preparing the second real run: the failed run had left `task/<taskId>` with no commits of its own,
  pointing at the old main (old agent files with `command_status`). `run` reuses an existing task branch as it is, so
  a kit update on main does not reach it; it was fast-forwarded to main by hand (lossless: no own commits).
  **Follow-up:** let `run` fast-forward a task branch that has no own commits and is behind the base branch.

### agy permission rules: regex, tested (2026-10-13, same branch)

- First real (interactive) agy run: NEEDS_HUMAN after round 1; the coder could not commit. agy recorded the exact
  texts it refused: `git commit -m "<taskId>: …"`, `pnpm.cmd typecheck`, `git log -n 5 --oneline`; agents also ran
  `npx.cmd tossana-agents …`, `npx tossana-agents run --task <id> --no-agent`, `git branch -a`.
- Tested in a sandbox (temporary HOME with its own agy settings.json, scratch repo, fake kit bin, a throwaway agent
  running ONE command per session, because headless agy ends the session at the first refusal; verdict from the
  command line agy recorded). Result: in agy 1.3.3 a plain rule such as `command(git log)` matches only that exact
  text. With the kit-generated anchored `regex:` rules, all 10 forms above are allowed and 8 stay refused: `git push`,
  `git push origin main`, `git commit --amend`, `git reset --hard`, `git rebase`, `git branch -D`, and two chained
  commands (`…; git push`, `… && git push`). A unit test keeps the same table (plus more refusals) against the rules.
- `antigravity permissions` now shows a +/- diff, replaces only the rules an older kit version added, and writes only
  after a yes (backup kept).
- **Follow-up:** `run --no-agent` (called by /start-task) records "Run started with <pipeline.runner>", so an
  Antigravity session was labeled OpenCode ([BY: OpenCode], "Resumed … after opencode"). /start-task should pass
  `--runner antigravity`, and `--no-agent` without `--runner` should not name a tool.

### Default agents, per-agent skills, locked pipeline (2026-10-13, branch `feat/default-agents`)

- Product decision: the pipeline is fixed (orchestrator → coder → reviewer → tester → ready for review); people change
  what each agent knows (skills), not the roles. Locked rules unchanged.
- **Config:** `"agents": { "coder"|"reviewer"|"tester": { "skills": [...] } }` (strict). Custom `roles` only with
  `"advanced": { "customRoles": true }` (off by default; the error names the fix). `update`/`init` add that flag to
  older configs that already use `roles`, so they keep working.
- **Defaults** (`defaultAgentSkills` in core): coder = project.skill; reviewer = `review-checklist` + project.skill;
  tester = the stack's testing skill (`testing-react-native`, `testing-flutter`, `testing-web` for nextjs/react,
  `testing-node`; none for `other`). The tester template now names its skill (`role.skillRead`).
- **New team skills** (drafted, review welcome): `review-checklist`, `testing-react-native`, `testing-flutter`,
  `testing-web`, `testing-node`. The four `*-master` skills are still placeholders (skills folder never provided).
- **update keeps edits:** the kit manifest records the defaults it wrote (`agentDefaults`). A role still equal to
  them gets the new defaults; an edited role is kept and reported with the new default; a project from before
  `agents` is treated as having the old implicit defaults (stack skill for coder and reviewer).
- **CLI:** `agents skills [role] [add|remove <skill> | reset]`, `skills [list]`, `skills customize <skill>` (team
  copy becomes the project's own: no managed header, out of the manifest, so it wins and update keeps it),
  `skills reset <skill>` (project copy to `.agents/kit/backup/…`, team copy written again). Every change refreshes the
  agent files through the same code as `update` (`updateProject`).
- Agent profiles unchanged: their skills are added for the coder and reviewer on top of the per-agent skills.
- Not in this change: per-agent skill editing in the Local Console (lives on `feature/console-design`).
- Tests: 14 new (481+ total); goldens: reviewer/tester now name their skills, new skill folders per case.

## Phase 10 — Automation (2026-10-13)

User goal: to pass the kit to the team once it works for them. Order: 1 → 3/4 → 5 → 2 → 6. Each step on its own
branch, merged after the user approves.

### Step 1 — Context before every run (built, merged)

`tossana-agents context <taskId> [--no-docs]`; `run` and `--resume` refresh before the agent starts (`--no-context`
skips). ClickUp Docs sync is incremental (unchanged pages are not rewritten, removed pages are deleted) with a short
`docs/clickup/INDEX.md` (one line per page, no timestamp). The task bundle `.agents/context/<taskId>/` (git-ignored)
holds the task, parent, subtasks, linked tasks and dependencies (both directions), all comments, attachment links and
an INDEX.md. Only GET requests; a failed Docs sync keeps the old files. Checked read-only against the real ClickUp API
(28 spec pages, a real test task). All role templates point to the INDEX files (`cu get`/`cu comments` as fallback).

### Steps 3 and 4 — watch, worktrees, review (built on feat/watch)

- **Worktrees:** `<parent>/<repo>-tasks/<taskId>` on `task/<id>` from the local base branch (not origin: a clone's
  origin may not have the kit). A branch with own commits is reused; one with no own commits is moved to the base
  (the stale-branch case, lossless). A branch checked out in the main folder → refused with the fix. `.env`, the
  task's handoff file and the agy check result are copied in; the install command runs there.
  `worktrees list | clean [taskId] [--force]` (clean = nothing uncommitted and closed in ClickUp or merged; branches
  are never deleted).
- **watch** `[--runner] [--interval 5m] [--once] [--retry <id>]`: doctor must pass for that runner first (new check:
  Windows PowerShell execution policy when Antigravity is used). Each poll: interrupted tasks (resumed, at most twice),
  tasks sent back with feedback, then my "to do" tasks, oldest first; one at a time, headless, in the task's worktree.
  State in `.tossana/tmp/watch-state.json` (main folder): finished, failed or NEEDS_HUMAN tasks are not repeated
  (`--retry` runs one again). Main-folder run lock against a second watcher. Ctrl+C aborts the agent (whole process
  tree) and keeps the task as "running" so the next start resumes it. Desktop notification on ready for review /
  NEEDS_HUMAN: Windows toast via a fixed PowerShell script with the text in environment variables, macOS osascript
  with the text as arguments, Linux notify-send.
- **Antigravity in worktrees:** checked with a sandboxed agy (temporary HOME): trusting a parent folder does not
  cover subfolders, but `--add-dir <folder>` loads the agents and runs allowed commands without trust. The adapter
  always passes `--add-dir`; trust is no longer required (doctor and preflight no longer check it).
- **review <taskId>** (people only: refuses without an interactive terminal, and inside agent runs, which get
  `TOSSANA_AGENT=1`): summary, rounds, the quality gate run in the worktree, `git diff --stat`, the diff opened in
  VS Code; then push the branch (+ a PR with gh if installed), send feedback, or skip. Done stays manual.
- Tests: 14 new (512 total; real git, fake ClickUp, a fake agent). Docs: getting-started "Fully automatic mode".

### Real test of watch (2026-10-13, Windows, antigravity runner, "Implement pnpm i18n:check")

- Run 1 timeline: 14:24:10 doctor OK (3 s) → 14:24:13 task picked → 14:24:19 worktree created + pnpm install (6 s) →
  14:24:54 agent check, 4 agents pong (35 s) → 14:24:55 context → 14:24:55 agy started → 14:30 coder subagent
  started → 14:34:09 run ended: status still coding, nothing committed.
- Cause (from agy's own conversation record, step 84): the coder ran `node -v`, which is not on the allow list;
  headless agy ends the whole run at a refused command. Also found and fixed on the way: `update` did not add new
  .gitignore lines (`.agents/context/`); the task needs `pnpm i18n:check` (rule for the project's package.json
  scripts added, long-running ones like start/android/ios excluded).
- Fix: the Antigravity agents now get the exact list of commands headless agy allows (and: put new script files in
  package.json scripts); version checks are allowed; `watch --retry` re-runs a task whatever its status.
- **Not re-run yet** (the user moved testing to macOS). Next: `tossana-agents antigravity permissions` on the Mac
  (adds the version-check rule), then `watch --runner antigravity --once --retry <i18n task id>`.

### Step 5 — Feedback loop (built with steps 3 and 4)

`tossana-agents feedback <taskId> "text"` posts the comment as the owner, moves the task to coding and records it in
the handoff file. watch resumes tasks in coding whose newest comments are from people after a finished pipeline
(orchestrator PASS or NEEDS_HUMAN), once per comment. A resume with feedback starts a new round at the coder with the
comment as the top-priority instruction, then the normal review and test.

### Step 2 — Planner step (next)

Fixed read-only planner before the coder: subtasks with acceptance criteria when the task is bigger than one small
change, plan posted as a comment, pipeline per subtask. `pipeline.planApproval`: `auto` (default) or `human`
(waits for the comment "approved", resumed by watch or `feedback`).

### Step 6 — Figma for real (later)

Coder: get_design_context / get_variable_defs / get_screenshot mapped to tokens and components. Reviewer: differences
against the screenshot and design context. Doctor: desktop MCP server reachable. agy MCP permissions tested. Then a
real task with the user's Figma link.
