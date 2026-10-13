# Getting started

This guide shows how to add the Tossana agent kit to a project and run your first task.
It takes about 15 minutes.

## What the kit does

You write a task in ClickUp. The kit gives the task to AI agents:

1. The **coder** writes the code on a new git branch.
2. The **reviewer** checks the code.
3. The **tester** runs lint, type check and tests.
4. If something is wrong, the coder fixes it (up to 5 rounds).
5. When everything passes, the task moves to **ready for review**. Now it is your turn.

The agents **never** push, merge, or set a task to Done. Only a human does that.
More details: [agents.md](./agents.md).

## What you need

- **Node.js 20.19 or newer** (`node --version`).
- **Git** (on Windows: Git for Windows).
- **OpenCode**, logged in to a model provider: `npm install -g opencode-ai`, then `opencode auth login`.
  (Or Antigravity, see [antigravity.md](./antigravity.md).)
- A **ClickUp list** with the 6 statuses: to do, coding, in review, testing, ready for review, done.
  See [clickup-setup.md](./clickup-setup.md).
- Your **ClickUp API token**: ClickUp → avatar → Settings → Apps → API Token. It starts with `pk_`.
- On Windows: PowerShell 7 or Windows Terminal is best. See [windows.md](./windows.md).

## 1. Install

The package is `@tossana/agents`. The command is `tossana-agents`.

In a Node.js project (has `package.json`), install it in the project:

```
pnpm add -D @tossana/agents       # or: npm install -D @tossana/agents
```

Then use `npx tossana-agents …`.

In other projects (Flutter, backend in another language), install it once on your computer:

```
npm install -g @tossana/agents
```

Then use `tossana-agents …`.

> The package is not published yet. Until it is, ask the kit maintainer for the `.tgz` file and
> install that file instead: `pnpm add -D ./tossana-agents-0.1.0.tgz`.

## 2. Set up the project: `init`

Open a terminal in the project folder (the git repo) and run:

```
npx tossana-agents init
```

`init` asks a few questions:

- **ClickUp token** (input is hidden). It is saved in `.env`, which is git-ignored.
- **ClickUp list**: pick the list where the tasks are.
- **Statuses**: check that each role has the right status name.
- **Project type and skill**: `init` detects them. Press Enter if they are right.

`init` creates these files:

| File                                 | What it is                                                        |
| ------------------------------------ | ----------------------------------------------------------------- |
| `agent.config.json`                  | Project settings (list ID, statuses, commands). Commit it.        |
| `.env`                               | Your token. **Never commit it.** `init` adds it to .gitignore.    |
| `AGENTS.md`                          | Rules for all agents. Add project notes below `<!-- PROJECT -->`. |
| `.opencode/agents/*.md`              | The four OpenCode agents.                                         |
| `.agents/skills/`, `.agents/agents/` | Antigravity skills and agents (`<name>/agent.md`), coding skill.  |

Commit the new files (not `.env`):

```
git add -A
git commit -m "chore: add Tossana agent kit"
```

`init` is safe to run again. It does not change files you edited without asking.

## 3. Check the setup: `doctor`

```
npx tossana-agents doctor
```

Every line should be ✅. For each ❌, doctor shows a `FIX:` line. Fix the **first** ❌ and run doctor again.

Common problems:

- **"Role statuses exist on the list" fails**: the list does not have the 6 statuses yet, or you made them in
  another ClickUp account. See [clickup-setup.md](./clickup-setup.md).
- **"ClickUp token works" fails**: the token is wrong or old. Make a new one and put it in `.env`.

## 4. Run one task

Pick a small task in the list with status **to do**. Copy its ID from the task URL
(`app.clickup.com/t/<taskId>`).

First, see what will happen (nothing is changed):

```
npx tossana-agents run --task <taskId> --dry-run
```

Then run it:

```
npx tossana-agents run --task <taskId>
```

What `run` does:

1. Checks that your git tree is clean (commit or stash your work first).
2. Creates the branch `task/<taskId>` from `main`.
3. Starts the orchestrator agent in OpenCode. You see its output in the terminal.
4. When the agents finish, switches back to `main`. The work stays on `task/<taskId>`.

A full log is saved in `.agents/logs/`. Press Ctrl+C to stop.

Other ways to run:

- `run --next`: the next "to do" task assigned to you.
- `run --all`: all your "to do" tasks, one after another.
- `run --task <taskId> --no-agent`: only create the branch. Then work with the agents yourself.

## Switching tools mid-task

If one tool stops in the middle of a task (for example you hit your usage limit in Antigravity), another tool can
finish it:

```
npx tossana-agents run --task <taskId> --resume --runner codex
```

`--runner` is `opencode`, `claude-code`, `codex` or `antigravity`. What happens:

1. The task must be in an agent status (to do, coding, in review, testing). A task in **ready for review** or
   **done** is never touched.
2. The kit switches to the existing `task/<taskId>` branch and keeps it. Nothing is reset.
3. If the previous tool left uncommitted changes, the kit asks before committing them as
   `WIP: handoff from <previous tool>`. Without a terminal it stops, unless you add `--yes`.
4. It posts a comment `[AGENT: orchestrator] [RESULT: STARTED] … Resumed with codex after antigravity`, so the
   task and the dashboard show the switch.
5. The new tool reads the handoff file, the latest agent comment and the git log first, and continues from that
   round. If the last turn has no comment (the tool stopped mid-turn), it redoes that turn.

The new tool's files must exist in the project. If they don't, the kit tells you the command to add them
(`npx tossana-agents init --yes --tools <tools you use>,<new tool>`). Try `--dry-run` first to see the plan.

## The Local Console (a UI for the same commands)

Prefer clicking to typing? In the project folder run:

```powershell
npx tossana-agents ui
```

Your browser opens a page for **this project only**:

- **Project health**: the `doctor` checks as cards, each with its fix. Press **Re-check** after fixing something.
- **My tasks**: your tasks from the ClickUp list. **Run** starts a "to do" task, **Resume** continues one that is in
  progress. Choose the **Agent** (see below) and the **Tool** (only tools set up in this project and installed on
  your computer are offered). You always see the dry run first; nothing changes until you press **Start**.
- **Agents**: your named agents (see "Agent profiles" below): create, edit, delete.
- **Live run**: the agent's output as it works, the current role and round, and a **Stop** button (stops the agent
  and everything it started).

Good to know:

- Only your computer can open the page, and only with the link the command printed (it has a secret part). The link
  stops working when you stop the console with **Ctrl+C**. Stopping the console also stops a running agent.
- Your ClickUp token never goes to the browser.
- Only one run per project at a time, from the console or from the terminal.

## Customize your agents

Every project has the same pipeline: **orchestrator → coder → reviewer → tester → ready for review**. It is fixed,
and so are the rules (agents never set Done and never push). What you change is what each agent **knows**: its
skills.

`init` gives each agent the default skills for your project type and writes them to `agent.config.json`:

```json
"agents": {
  "coder":    { "skills": ["mobile-master"] },
  "reviewer": { "skills": ["review-checklist", "mobile-master"] },
  "tester":   { "skills": ["testing-react-native"] }
}
```

| Project type  | coder           | reviewer                          | tester               |
| ------------- | --------------- | --------------------------------- | -------------------- |
| react-native  | mobile-master   | review-checklist, mobile-master   | testing-react-native |
| flutter       | flutter-master  | review-checklist, flutter-master  | testing-flutter      |
| nextjs, react | frontend-master | review-checklist, frontend-master | testing-web          |
| node-backend  | backend-master  | review-checklist, backend-master  | testing-node         |

Change one agent at a time (the agent files are updated at once; commit `agent.config.json`):

```powershell
npx tossana-agents agents skills                          # what each agent uses
npx tossana-agents agents skills coder add ekmong-i18n     # a skill of your own in .agents/skills/ekmong-i18n/
npx tossana-agents agents skills reviewer remove mobile-master
npx tossana-agents agents skills reviewer reset           # back to the defaults
npx tossana-agents skills                                 # every skill, and who uses it
```

To change a **team skill** for this project only, copy it into the project and edit the copy:

```powershell
npx tossana-agents skills customize review-checklist     # now .agents/skills/review-checklist/ is yours
npx tossana-agents skills reset review-checklist         # back to the team version (your copy is backed up)
```

Your copy wins over the team version, and `update` never overwrites it. `update` also keeps the skills you chose
per agent: only agents still on the defaults get new default skills, and it lists what changed.

Agent profiles (below) use these skills too: a profile's skills are added for the coder and the reviewer.

## Agent profiles: "who works on this task"

An agent profile is a named agent, for example **Rei – Mobile** or **Joe – Backend**:

- a **tool** (OpenCode, Claude Code, Codex or Antigravity),
- **skills** (your project's skills, your own skills on this computer, or the team skills that come with the kit),
- optional **MCP servers** (today: Figma),
- a badge (initials and a color) so you recognise it.

It always runs the project's normal pipeline (orchestrator → coder → reviewer → tester). Its skills are **added** for
the coder and the reviewer. It never changes what a role may do: the locked rules always apply (for example, an
agent can never set a task to Done).

**Team or personal?**

- **Team agent**: saved in the project as `.agents/profiles/<id>.json`. Commit it, and everyone in the project gets it.
- **Personal agent**: saved in your home folder (`~/.agents/profiles/`), only on your computer.

Profiles never contain tokens or passwords; the kit refuses to save anything that looks like one.

**Create one** in the Local Console (**Agents** → **New agent**: tool → name → skills → MCP), or in the terminal:

```powershell
npx tossana-agents agents create --name "Rei – Mobile" --tool codex --skills mobile-master,payments
npx tossana-agents agents list
npx tossana-agents agents delete rei-mobile --yes
```

Add `--personal` to keep it on your computer only. In the form you can also **create a new project skill** from a
template (`.agents/skills/<name>/SKILL.md`): fill it in and commit it.

**Run a task as an agent:**

```powershell
npx tossana-agents run --task 86abc123 --agent rei-mobile --dry-run
npx tossana-agents run --task 86abc123 --agent rei-mobile
```

In the Local Console, **Run** and **Resume** ask which agent to use and remember your last choice for this project.
If the agent's tool is not installed on your computer (or not set up in this project), you can run it with another
tool instead; the agent's skills are kept. In the terminal, add `--runner opencode` (or another tool) for the same.

ClickUp comments and the dashboard then show who did the work, for example `[BY: Rei – Mobile · Codex]`.

## 5. What you see in ClickUp

While the agents work, the task moves through the statuses and gets comments:

| Status           | What is happening                      |
| ---------------- | -------------------------------------- |
| to do            | Waiting                                |
| coding           | The coder is writing or fixing code    |
| in review        | The reviewer is checking the code      |
| testing          | The tester is running checks and tests |
| ready for review | Done by the agents. **Your turn.**     |

Each agent writes one comment per step, for example:

```
[AGENT: reviewer] [RESULT: CHANGES_NEEDED] [ROUND: 1]
Summary: The empty state is missing.
Issues:
- src/features/orders/OrdersScreen.tsx:42 - no empty state (AC-3)
Next: coder
```

At the end you get a notification (if `CLICKUP_OWNER_USER_ID` is set in `.env`):

- `[RESULT: PASS]`: everything passed. Check the branch `task/<taskId>`, test it, then merge it and set the
  task to Done yourself.
- `[RESULT: NEEDS_HUMAN]`: the agents could not finish. The comment says why.

To ask for changes: write a normal comment on the task (no `[AGENT: …]` tag) and run
`run --task <taskId>` again. The agents read your comment first and continue on the same branch.

## Figma designs (optional)

If your tasks link to Figma designs, the agents can read them through Figma's official MCP server (read only).
The coder builds the design with your project's components and design tokens, and the reviewer compares the result
with the Figma frame. Tasks without a Figma link work exactly as before.

### Turn it on

`init` asks "Does this project use Figma designs?" (default: yes for app and web projects, no for backends).
Or run `npx tossana-agents init --figma` (and `--no-figma` to turn it off). This adds a `figma` server to:

- `opencode.json` (OpenCode), and
- `.agents/mcp_config.json` (Antigravity).

The kit only adds or removes its own `figma` entry. Your other settings in these files stay. **No Figma token is
ever saved in the project.** Commit both files.

### Which Figma server

| `figma.server` in `agent.config.json` | How it works                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `desktop` (default)                   | The Figma desktop app runs a local server. No token, you are logged in to the app. |
| `remote`                              | Figma's hosted server with your own Figma login (OAuth).                           |

We use `desktop` because Figma's hosted server only accepts the apps in Figma's MCP catalog. Antigravity is
listed there as "local server only", and OpenCode is not listed. Check the catalog
(figma.com/mcp-catalog) if you want to try `remote`; after changing it, run `init` again.

### Every developer, once

1. Install the **Figma desktop app** and log in with **your own** Figma account.
2. You need a **Dev or Full seat**. View and Collab seats get only **20 Figma MCP calls per month**, which is not
   enough for agents.
3. Open any design file, switch to **Dev Mode** (Shift+D), and in the right panel click
   **Enable desktop MCP server**.
4. Keep the Figma app open while the agents work on a task with a Figma link.
5. Run `npx tossana-agents doctor`. It checks the config files and whether the Figma server is running.
6. For `remote` instead: run `opencode mcp auth figma` once and log in in the browser.

### Writing tasks with designs

Paste the link to the **frame** (right-click the frame → Copy link to selection) into the task description. The
link has `node-id=` in it. Link one frame per screen or component.

To save Figma calls, the coder reads each frame **once per task** and saves a summary in
`.agents/handoff/<taskId>.md`. Later rounds and the reviewer use that summary. If Figma is not available (app
closed), the agents stop with `NEEDS_HUMAN` instead of guessing the design.

## Next steps

- Keep the project part of `AGENTS.md` (below `<!-- PROJECT -->`) up to date. Agents follow it.
- `npx tossana-agents update` after you install a new kit version.
