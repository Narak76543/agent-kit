# Tossana Agent Kit — Project Plan

> **For Claude Code:** This is the full spec for a new project. Read the whole file first.
> Work in plan mode, ask the open questions in section 13 before writing code, then build phase by phase (section 12).
> Stop at the end of each phase and show the acceptance checklist results before starting the next phase.

---

## 1. Goal

Build a reusable kit that lets any developer at Tossana Tech plug a **multi-agent coding workflow** (orchestrator → coder → reviewer → tester) into **any project** with one command, driven by **ClickUp tasks**, plus a **team dashboard** where everyone can see the agent pipeline.

The kit already exists in an early form inside the `EKMONG_MOBILE` project (React Native). This project **extracts, generalizes and packages** it.

### Success looks like
A new teammate can do this in under 10 minutes, on Windows or macOS:

```
npx @tossana/agents init          # answers a few questions
# pastes own ClickUp token into .env
npx @tossana/agents doctor        # everything green
npx @tossana/agents run --task 86abc123
```

…and the team lead opens the dashboard and sees that task move through Coding → In Review → Testing → Ready for Review.

### Non-negotiable rules
1. **Agents never set a task to Done** (or any status of ClickUp type `done`/`closed`). Only humans do.
2. **Each person uses their own ClickUp API token.** Tokens are never committed, logged, or sent to the browser.
3. **Tool-independent.** Core logic lives in plain Node/TypeScript scripts and plain files. The main agent runner is **OpenCode**; **Antigravity** must also be usable. Claude Code support is optional (the author only has Claude Code short-term).
4. **Windows first-class.** The author develops on Windows (PowerShell). No bash-only scripts. Use Node APIs for paths and processes.
5. **Use the ClickUp REST API v2**, not the ClickUp MCP server (the MCP server has a low daily call limit; the REST API allows 100 requests/minute per token on most plans).

---

## 2. Existing code to reuse (read first)

Ask the user for the path to the `EKMONG_MOBILE` project. Read these files and treat them as the starting point, not as something to rewrite from scratch:

| File in EKMONG_MOBILE | Becomes |
|---|---|
| `scripts/clickup.ts` | `packages/core` (client, guard, rate limiter) + CLI `clickup` subcommands |
| `AGENTS.md` | `packages/templates/AGENTS.base.md` (generic part) |
| `.opencode/agents/*.md` | `packages/templates/opencode/agents/*.md` (parameterized) |
| `scripts/run-pipeline.ts` | `packages/cli` `run` command |
| `.agent/` (Antigravity rule + `/start-task`, `/explore` workflows) | `packages/templates/antigravity/` |
| README agent section | `docs/` |

Also ask the user for the path to their **skills library** folder (`agents/`), which contains:
`backend-master`, `flutter-master`, `frontend-master` (also called `master-frontend`), `mobile-master`.
Copy these into `packages/templates/skills/`.

Known facts from the existing implementation (keep this behavior):
- Done guard has 3 layers: refuses names containing done/complete/closed; only allows statuses in an allow-list; refuses any status whose ClickUp `type` is `done` or `closed`.
- The status command exits with code 2 on refusal and makes no API call.
- `comment` also appends to the handoff file automatically (so read-only agents can still record notes).
- A Node crash on Windows when exiting during a network call was fixed — keep that fix.
- Only the orchestrator may change statuses; subagents are blocked from the status command entirely.
- No agent may `git push`.

---

## 3. Architecture

```
tossana-agent-kit/                 (private GitHub repo, pnpm workspace)
├── packages/
│   ├── core/          @tossana/agents-core   shared library (no CLI, no UI)
│   ├── cli/           @tossana/agents        the `tossana-agents` command
│   └── templates/     (not published separately; bundled into cli)
├── apps/
│   └── dashboard/     Next.js team dashboard
├── docs/
├── pnpm-workspace.yaml
└── README.md
```

```
           npx @tossana/agents init / run / update / doctor
                          │
 ┌────────────────────────▼──────────────────────────┐
 │ Any project (EKMONG_MOBILE, backend, web, ...)    │
 │  agent.config.json   AGENTS.md   .opencode/agents │
 │  .agents/handoff/    .agents/logs/   .env         │
 └────────────────────────┬──────────────────────────┘
                          │ ClickUp REST API (each dev's own token)
                          ▼
                       ClickUp  ◄──── reads (server-side token) ──── Dashboard (Next.js)
```

**Key design choice:** `@tossana/agents-core` contains the ClickUp client, the Done guard, the config loader and the **comment protocol parser**. Both the CLI and the dashboard import it, so the comment format is defined in exactly one place.

---

## 4. Tech stack

| Area | Choice |
|---|---|
| Language | TypeScript (strict) everywhere |
| Runtime | Node.js 20+ (check what the user has; support 20 and 22) |
| Package manager | pnpm workspaces |
| CLI framework | `commander` (or `citty`) + `@clack/prompts` for interactive `init` |
| Build | `tsup` for packages |
| Tests | `vitest`; mock HTTP with `msw` (or `undici` MockAgent) |
| Lint/format | ESLint + Prettier |
| Dashboard | Next.js (App Router), TypeScript, Tailwind CSS, light mode only, font: Google Sans (use the Google Fonts "Google Sans Flex" if available; fall back to a close sans like Inter) |
| Dashboard auth | Auth.js (NextAuth) with Google provider, restricted to the company email domain |
| Distribution | GitHub Packages (private npm registry) under scope `@tossana`; local `pnpm link` during development |

---

## 5. Project configuration (per project)

### 5.1 `agent.config.json` (committed, project-owned)

```jsonc
{
  "$schema": "./node_modules/@tossana/agents/schema/agent.config.schema.json",
  "version": 1,
  "project": {
    "name": "EKMONG_MOBILE",
    "type": "react-native",            // react-native | flutter | nextjs | react | node-backend | other
    "skill": "mobile-master"           // which skill the coder uses
  },
  "clickup": {
    "listId": "901234567",
    "statuses": {                      // map roles -> exact ClickUp status names
      "todo": "to do",
      "coding": "coding",
      "review": "in review",
      "testing": "testing",
      "human": "ready for review"      // final status agents may set
    }
  },
  "commands": {                        // detected by init, editable
    "install": "pnpm install",
    "lint": "pnpm lint",
    "typecheck": "pnpm typecheck",
    "test": "pnpm test"
  },
  "pipeline": {
    "maxRounds": 5,
    "branchPrefix": "task/",
    "requireCleanGit": true,
    "runner": "opencode"               // opencode | claude-code | custom
  }
}
```

Validate it with **zod** in core; generate the JSON Schema from the zod schema.

### 5.2 `.env` (never committed, per person)

```
CLICKUP_API_TOKEN=pk_...
CLICKUP_OWNER_USER_ID=12345678      # who gets "needs human" notifications
AGENT_CMD=                           # optional override of the runner command
```

`init` must create `.env.example`, make sure `.env` is in `.gitignore`, and never write the real token anywhere except `.env`.

### 5.3 Kit-owned vs project-owned files

| Kit-owned (replaced by `update`) | Project-owned (never touched by `update`) |
|---|---|
| `.opencode/agents/*.md` | `agent.config.json` |
| `.agents/kit/` (skills copy, base rules) | `AGENTS.md` section below the `<!-- PROJECT -->` marker |
| `AGENTS.md` section above the `<!-- PROJECT -->` marker | `.env` |
| `.agent/` Antigravity rules/workflows | `.agents/handoff/`, `.agents/logs/` |

Kit-owned files start with a header comment: `<!-- Managed by @tossana/agents vX.Y.Z — do not edit; run "tossana-agents update" -->`.
`update` shows a diff and asks before overwriting any kit-owned file that was edited locally.

---

## 6. ClickUp conventions (team-wide)

### 6.1 Statuses
Every list used with the kit has these statuses (names configurable via `clickup.statuses`):

```
To Do → Coding → In Review → Testing → Ready for Review → Done (humans only)
```

Docs must explain how to create a ClickUp **list template** with these statuses so new projects get them automatically.

### 6.2 Comment protocol (single source of truth in `core/src/protocol.ts`)

```
[AGENT: <orchestrator|coder|reviewer|tester>] [RESULT: <RESULT>] [ROUND: <n>]
Summary: <1-3 lines>
Issues:
- <file:line> - <problem>
Next: <agent name | human>
```

`RESULT` ∈ `STARTED | DONE_CODING | APPROVED | CHANGES_NEEDED | PASS | FAIL | NEEDS_HUMAN`.

Core exports:
- `formatAgentComment(data): string`
- `parseAgentComment(text): AgentComment | null` (tolerant of extra whitespace, case, Windows line endings)
- Unit tests with real-looking examples, including malformed ones.

### 6.3 Handoff files
`.agents/handoff/<taskId>.md`, append-only, one section per agent turn with a timestamp. Every agent reads it first.

---

## 7. `@tossana/agents-core`

Modules:

| Module | Responsibility |
|---|---|
| `clickup/client.ts` | Typed REST v2 client: tasks, comments, statuses, subtasks, lists, spaces, user. Reads `X-RateLimit-*` headers; retries 429 and 5xx with exponential backoff + jitter; respects `X-RateLimit-Reset`. Concurrency limit (default 4). |
| `clickup/guard.ts` | The 3-layer Done guard. Throws `DoneGuardError`. Used by the client's `setStatus` so no caller can bypass it. |
| `config.ts` | Load + validate `agent.config.json` and `.env`; helpful error messages. |
| `protocol.ts` | Comment format/parse (6.2). |
| `handoff.ts` | Append/read handoff files. |
| `detect.ts` | Detect project type and commands (section 8.1). |
| `logger.ts` | Redacts anything that looks like a token (`pk_...`) from all output. |

Requirements:
- No `console.log` of request headers.
- All file paths via `node:path`; works on Windows.
- 100% of guard logic and protocol parser covered by tests.

---

## 8. CLI: `@tossana/agents` (command `tossana-agents`)

### 8.1 `init`
Interactive (with `--yes` for defaults). Steps:
1. Check git repo exists; warn if not.
2. **Detect project type**:
   - `package.json` with `react-native` → `react-native` → skill `mobile-master`
   - `pubspec.yaml` → `flutter` → `flutter-master`
   - `package.json` with `next` → `nextjs` → `frontend-master`
   - `package.json` with `react` (no next/RN) → `react` → `frontend-master`
   - `package.json` with express/fastify/nestjs, or Go/Python backend markers → `node-backend` (or `other`) → `backend-master`
   - Let the user confirm or change.
3. **Detect commands** from `package.json` scripts (lint/typecheck/test), lockfile → package manager. For Flutter: `flutter analyze`, `flutter test`.
4. Ask for the ClickUp token if `.env` has none (masked input), write `.env`, ensure `.gitignore`.
5. Let the user **pick the ClickUp list** (fetch workspaces → spaces → lists) instead of typing an ID.
6. Fetch the list's statuses and **map them to roles**; warn if any role is missing and explain how to add it in ClickUp.
7. Write `agent.config.json`, `AGENTS.md` (base + project section generated by briefly scanning the repo structure), `.opencode/agents/`, `.agent/` (Antigravity), `.agents/kit/skills/<skill>/`.
8. Run `doctor`.

`init` must be **idempotent**: running it twice doesn't duplicate anything.

### 8.2 `doctor`
Checks, each with ✅/❌ and a fix hint:
- Node version, pnpm/npm available, git available, Git for Windows on Windows (optional)
- `agent.config.json` valid
- `.env` exists, token present, token works (`GET /user`), `.env` is git-ignored
- List exists and token can access it
- All role statuses exist; `human` status is not of type done/closed
- OpenCode installed (`opencode --version`) when runner is `opencode`
- Kit-owned files present and their version matches the installed kit

### 8.3 `run`
```
tossana-agents run --task <id>          # one task
tossana-agents run --next               # next task in "todo" assigned to me
tossana-agents run --all                # all todo tasks assigned to me, one at a time
tossana-agents run --task <id> --dry-run
```
Behavior:
- Refuse to start if `requireCleanGit` and there are uncommitted changes to tracked files.
- Create/checkout branch `<branchPrefix><taskId>`.
- Start the runner via an **adapter** (8.6) with the orchestrator agent and the prompt `Work on ClickUp task <id>`.
- Stream runner output to the console and to `.agents/logs/<taskId>-<timestamp>.log` (tokens redacted).
- After the runner exits, read the last agent comment; print a short summary (rounds used, final result).
- Never pushes.

### 8.4 `update`
Update kit-owned files to the installed kit version, with diff + confirmation for locally edited files. Never touch project-owned files.

### 8.5 `clickup` subcommands (used by agents)
Keep the same commands agents already use so the agent templates stay simple:
```
tossana-agents clickup get <taskId>
tossana-agents clickup comments <taskId>
tossana-agents clickup comment <taskId> "<text>"      # also appends to handoff
tossana-agents clickup handoff <taskId> "<text>"
tossana-agents clickup status <taskId> <role>          # role names (coding/review/testing/human), not raw names
tossana-agents clickup subtask <taskId> "<name>" "<desc>"
tossana-agents clickup notify <taskId> "<text>"        # comment assigned to CLICKUP_OWNER_USER_ID
tossana-agents clickup list [--status <role>] [--mine]
tossana-agents clickup spaces | lists | statuses
```
Using **role names** for `status` (instead of raw status names) means agent prompts work in every project even if status names differ.

### 8.6 Runner adapters
```ts
interface RunnerAdapter {
  name: string;
  isInstalled(): Promise<boolean>;
  buildCommand(opts: { agent: string; prompt: string; cwd: string }): { cmd: string; args: string[] };
}
```
- `opencode` (default): non-interactive run with the orchestrator agent. Check the current OpenCode CLI docs (https://opencode.ai/docs/cli/) for the exact command and flags.
- `claude-code` (optional): non-interactive `claude -p` with the orchestrator agent. Check current docs.
- `custom`: uses `AGENT_CMD` from `.env` with `{agent}` and `{prompt}` placeholders.
- Antigravity has no headless runner: `run` prints instructions to open Antigravity and use the `/start-task <id>` workflow.

Spawn processes without a shell where possible; quote arguments correctly on Windows.

---

## 9. Agent templates (`packages/templates`)

### 9.1 OpenCode agents (`opencode/agents/`)
Templates use placeholders filled by `init` from `agent.config.json` (e.g. `{{commands.test}}`, `{{project.skill}}`, `{{pipeline.maxRounds}}`).

| Agent | Mode | Permissions (default deny for bash) |
|---|---|---|
| orchestrator | primary | `task`: only coder, reviewer, tester. `edit`: deny. `bash`: deny by default; allow `tossana-agents clickup *`, `git status`, `git log*`, `git diff*`. |
| coder | subagent | `edit`: allow. `bash`: deny by default; allow the project's install/lint/typecheck/test commands, `git status`, `git diff*`, `git add *`, `git commit *`, `git checkout -b *`, `tossana-agents clickup get/comments/comment/handoff`. Deny `git push*`, `clickup status*`. |
| reviewer | subagent | `edit`: deny. `bash`: deny by default; allow `git diff*`, `git log*`, `tossana-agents clickup get/comments/comment/handoff`. |
| tester | subagent | `edit`: allow only test file globs (e.g. `**/*.test.*`, `**/__tests__/**`, `test/**`). `bash`: deny by default; allow lint/typecheck/test commands and `tossana-agents clickup get/comments/comment/handoff`. |

> **Important:** The existing EKMONG_MOBILE setup runs with an auto-approve mode in which anything not explicitly denied is allowed. The new templates must use **default-deny** (`"*": "deny"` first, then specific allows — OpenCode applies the last matching rule). Verify the exact permission syntax in https://opencode.ai/docs/agents/ and https://opencode.ai/docs/permissions/.

Orchestrator logic (in its prompt):
1. Read task + comments + handoff. If the task is large, create subtasks.
2. Set status `coding`, call coder.
3. Set status `review`, call reviewer. On `CHANGES_NEEDED` → back to 2 with the issues.
4. Set status `testing`, call tester. On `FAIL` → back to 2 with the logs.
5. On `PASS` → set status `human`, post a final summary comment, and `notify` the owner.
6. After `maxRounds` without passing → set status `human`, post `NEEDS_HUMAN` with the reason, `notify` the owner.

### 9.2 `AGENTS.base.md`
Generic rules: the workflow, comment protocol, handoff rules, safety rules (no Done, no push, no secrets), how to use the `clickup` subcommands. Followed by a `<!-- PROJECT -->` marker; `init` writes the project section below it.

### 9.3 Antigravity (`antigravity/`)
An always-on rule pointing to `AGENTS.md`, plus workflows `/start-task <id>` and `/explore`. Port them from EKMONG_MOBILE's `.agent/` folder. Verify the current Antigravity rules/workflows folder format before writing.

### 9.4 Skills (`skills/`)
Copies of the user's `backend-master`, `flutter-master`, `frontend-master`, `mobile-master`. `init` copies only the selected skill into `.agents/kit/skills/` and references it from the coder agent.

---

## 10. Team Dashboard (`apps/dashboard`)

### 10.1 Purpose
Read-only view (v1) of all agent pipelines across projects, so the team and the boss can see progress without opening every ClickUp task.

### 10.2 Data
- Server-side only. A **dashboard service token** (`DASHBOARD_CLICKUP_TOKEN`, ideally from a dedicated ClickUp bot/member account with read access) lives in the server env.
- Projects are configured in `dashboard.config.json`: `[{ name, listId, statuses }]`, or discovered from a ClickUp Space.
- Agent activity comes from parsing task comments with `parseAgentComment` from core.
- Cache ClickUp responses for 30–60 s (Next.js `fetch` revalidate or an in-memory LRU) so many viewers don't hit the 100 req/min limit.
- No database in v1.

### 10.3 Screens
1. **Pipeline board** — columns per role status (To Do, Coding, In Review, Testing, Ready for Review). Card: task name, project, assignee, current round, last agent + result badge, time in status. Filters: project, assignee.
2. **Task detail / timeline** — all agent comments in order as a vertical timeline (agent, result, round, summary, issues), link to the ClickUp task.
3. **Needs human** — tasks in `human` status, with `NEEDS_HUMAN` ones highlighted at the top.
4. **Stats** — tasks reaching Ready for Review per week, average rounds, most common reviewer issue types, pass rate on first round.

### 10.4 Design
- Light mode only, Google Sans (see section 4), clean and calm, lots of whitespace.
- Result badge colors: APPROVED/PASS green, CHANGES_NEEDED amber, FAIL/NEEDS_HUMAN red, others neutral.
- Responsive down to phone width.
- Auto-refresh every 60 s.

### 10.5 Auth & deploy
- Auth.js Google login, allow only `@<company-domain>` emails (ask the user for the domain).
- Deploy target: ask the user (Vercel with env vars, or an internal server with Docker). Provide a `Dockerfile` either way.

### 10.6 Later (not v1)
"Start pipeline" button (needs a runner service), Slack/Telegram notifications, per-agent cost tracking.

---

## 11. Security checklist
- [ ] Tokens never logged (logger redaction tested), never in client bundles, never committed.
- [ ] `.env` added to `.gitignore` by `init`; `doctor` fails if it isn't.
- [ ] Done guard enforced in core client; tested for name variants and status `type`.
- [ ] Default-deny bash permissions in all agent templates.
- [ ] No `git push` from any agent or from `run`.
- [ ] Dashboard is read-only in v1 and requires login.

---

## 12. Phases & acceptance criteria

### Phase 0 — Setup
- pnpm workspace, TypeScript strict, ESLint/Prettier, vitest, tsup, CI workflow (GitHub Actions: lint, typecheck, test on ubuntu + windows).
- ✅ `pnpm build` and `pnpm test` pass on Windows.

### Phase 1 — Core
- Port client, guard, rate limiter, protocol, handoff, config, detect, logger from EKMONG_MOBILE.
- ✅ Guard + protocol tests pass. ✅ Rate limiter tested with mocked 429 responses (this was untested before). ✅ All write commands tested against a mocked API.

### Phase 2 — CLI
- `clickup` subcommands, `doctor`, `init`, `run` (opencode + custom adapters), `update`.
- ✅ Running `init` in a fresh copy of EKMONG_MOBILE produces an equivalent setup to the current one, but with default-deny permissions.
- ✅ `init` twice = no duplicates. ✅ `doctor` shows clear fixes for each failure. ✅ `run --dry-run` prints the exact command.

### Phase 3 — Templates
- OpenCode agents, AGENTS.base.md, Antigravity rule/workflows, skills.
- ✅ Agent files parse in OpenCode. ✅ One real small task in EKMONG_MOBILE goes from To Do to Ready for Review (user runs this manually).

### Phase 4 — Second project
- ✅ `init` works on a different project type (ask the user which: backend, web or Flutter) with no code changes to the kit.

### Phase 5 — Dashboard
- ✅ Board, timeline, needs-human, stats screens working against real ClickUp data. ✅ Login restricted to company domain. ✅ Cached so 10 open tabs stay well under the rate limit.

### Phase 6 — Distribution & docs
- Publish `@tossana/agents` to GitHub Packages (private). Document `.npmrc` setup for teammates.
- Docs: `docs/getting-started.md` (for teammates, simple English, screenshots welcome), `docs/clickup-setup.md` (statuses + list template), `docs/agents.md` (how the pipeline works), `docs/maintaining.md` (how to release a new kit version).
- ✅ A teammate who has never seen the kit can follow getting-started and run one task.

### Phase 7 — Plug-and-play roles, tools and a team-managed library (added 2026-10-12)

**Goal:** the kit works for ANY project and ANY agent tool, with the same workflow (ClickUp task → roles in order
→ "ready for review", never Done). The team manages agents, skills and MCP servers centrally; developers keep
their secrets local.

#### 7.1 Configurable roles (one source of truth: `agent.config.json`)
- `roles` lists the pipeline roles **in order**, e.g. `manager → coder → reviewer → tester`, or custom roles
  (`security-reviewer`, `docs-writer`, …). Each role has:
  - `purpose` (one or two lines; becomes the role's instructions together with a template),
  - `skills` (several allowed, by name),
  - `mcp` (server names from the approved catalog),
  - `permissions`: a preset — `read-only`, `edit-code`, `edit-tests-only` — plus the project's commands it may run.
- The orchestrator (coordinator) is implicit: it runs the roles in order, loops on failure, and moves statuses.
- **Default = today's setup** (orchestrator + coder → reviewer → tester), so existing projects keep working.
- **Locked rules apply to every role** and cannot be changed by config, library or dashboard: never set
  Done/Complete/Closed, never `git push`/merge/branch delete, default-deny for every tool and command (no "ask"),
  never read `.env`, the comment protocol (`[AGENT: …] [RESULT: …] [ROUND: …]`). `init`/`update` re-check generated
  files and refuse a config that would break them.

#### 7.2 Skills in three scopes
- **Team** (bundled in the kit, or from the team library), **user global** (per developer, e.g. `~/.agents/skills/`),
  **project** (`.agents/skills/` in the repo). On a name clash the **project** wins, then user, then team.
- A role can list several skills; the generator writes where each tool expects them.

#### 7.3 One config, generated for each tool
- `init` asks which tools the team uses (several allowed): **OpenCode, Antigravity, Claude Code, Codex**.
  `init`/`update` generate each tool's agent files from `agent.config.json` (and the library). Formats and
  non-interactive commands are taken from each tool's current docs, never guessed.
- `run` adapters: `opencode` (exists), `claude-code`, `codex` (new), `antigravity` (instructions only, no headless
  mode), `custom`. Every adapter starts the orchestrator in the project folder and keeps the safety rules (no
  permission prompts that can hang, Done guard in the CLI, output redaction, timeout).

#### 7.4 Three levels of management
| Level | Where | What | Who changes it |
| --- | --- | --- | --- |
| Team library | private git repo `tossana-agent-library` | role templates, skills, approved MCP catalog, locked-rules text | editors propose, approvers merge |
| Project profile | `agent.config.json` in the project (or `profiles/<project>.json` in the library) | which roles/skills/MCP servers/tools this project uses, library version | project lead |
| Developer machine | local only | ClickUp/model tokens, model provider, Figma login, user-global skills | the developer — **never on the web** |

- `init`/`update` read the library at a **pinned version** (git tag) and fall back to the bundled templates
  when there is no library.
- MCP servers can only be chosen from the **approved catalog**; adding a server needs an approver.

#### 7.5 Dashboard
- Read-only pages: Agents/roles (permissions in plain English, locked rules marked), Skills (rendered Markdown,
  scope), MCP catalog, Projects (roles, skills, MCP servers, tools, library version). Each task shows its roles
  and which tool ran it (from the agent comments / run log).
- Later: editing. **The web never writes directly**: an edit opens a pull request in the library repo; an
  approver merges it. Every change has git history and can be rolled back (revert).
- Roles: **viewer** (read), **editor** (propose changes = open PRs), **approver** (merge).

#### 7.6 Build order and acceptance
1. ✅ Read-only dashboard pages on sample data, showing roles and tools.
2. ✅ Config schema for custom roles + skill scopes, with tests; the 4-role default produces byte-identical files.
3. ✅ Claude Code generator + `run` adapter (formats from the current Claude Code docs).
4. ✅ Codex generator + `run` adapter (formats from the current Codex docs).
5. Library repo + pinned versions in `init`/`update`; dashboard editing via PRs; login with roles.

---

## 13. Open questions (ask the user before Phase 0)
1. Path to the `EKMONG_MOBILE` project and to the skills `agents/` folder.
2. GitHub organization/user name for the private repo and package scope (default `@tossana`).
3. Company email domain for dashboard login.
4. Dashboard hosting: Vercel or internal server?
5. Which second project to test in Phase 4?
6. Final status name: "Ready for Review" for everyone, or keep "Ready for Narak" in EKMONG_MOBILE?
7. Should the dashboard use a dedicated ClickUp bot account, or the team lead's token for now?
8. Node version on the team's machines.

---

## 14. Working rules for Claude Code on this project
- Plan before each phase; show the plan; then implement.
- Small commits with clear messages, one logical change each. Do not push unless the user asks.
- Check current docs for OpenCode, ClickUp API and Antigravity instead of guessing flags or formats.
- When something in this plan conflicts with how the existing EKMONG_MOBILE code works, explain the difference and ask.
- Keep user-facing docs in simple, clear English (the team are not all native English speakers).
