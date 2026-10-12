# ClickUp setup

The agents move tasks through **6 statuses**. Every list the kit uses must have them, with these exact names:

| Status           | Type in ClickUp | Who sets it                              |
| ---------------- | --------------- | ---------------------------------------- |
| to do            | Not started     | Human (new tasks)                        |
| coding           | Active          | Agents                                   |
| in review        | Active          | Agents                                   |
| testing          | Active          | Agents                                   |
| ready for review | Active          | Agents (last status they may set)        |
| done             | Closed / Done   | **Human only.** Agents can never set it. |

Upper/lower case does not matter. Spelling and spaces do.

Other names are possible: map them in `agent.config.json` under `clickup.statuses`.
But **ready for review must not be in the Done/Closed group**. Doctor checks this.

## Before you start: check the account

**This is the most common mistake.** Your token belongs to one ClickUp account. If your browser is logged in
to a different account (for example your company account, and the token is from a test account), the
statuses you create are invisible to the kit. Doctor then says the statuses are missing, even though you can
see them in the browser.

Check it:

1. Run `npx tossana-agents clickup spaces`. It prints the token's user and its workspaces with IDs.
2. In the browser, open the list. The URL is `app.clickup.com/<workspaceId>/v/li/<listId>`.
3. The `<workspaceId>` in the URL must be one of the workspace IDs from step 1. If not, log in to the right
   account (avatar → switch account), or make a token in the account you use.

## The most reliable way: a Space with custom statuses

Statuses are inherited: Space → Folder → List. A list uses the Space's statuses unless it has its own.
Setting them once on the Space is the easiest way.

**New Space:**

1. In the sidebar, click **+** next to Spaces → **Create Space**.
2. Give it a name, then click **Continue** (or **Edit settings**) until you see **Task statuses**.
3. Choose **Custom** (not a template).
4. Make the statuses from the table above. Rename "in progress" to **coding** and "complete" to **done**.
   Put **done** in the Closed / Done group. All others go in Active (to do in Not started).
5. Click **Save** / **Create Space**.
6. Create a list inside the Space. It inherits the 6 statuses.

**Existing Space:** sidebar → hover the Space → **⋯** → **Space settings** (or **Task statuses**) → set the
statuses as above → **Save**.

**Only one list:** hover the list → **⋯** → **Task statuses** → choose **Use custom statuses** (not
"Inherit from Space") → set them → **Apply changes**.

Menu names change a little between ClickUp versions. Look for "Task statuses".

### Check it

```
npx tossana-agents clickup statuses
```

You should see all 6 names. `done` shows **HUMAN ONLY**. If names are missing, read "Before you start" again:
the Board view can show columns that are not real statuses, so trust this command, not the board.

Then run `npx tossana-agents doctor`.

## A list template for new projects

When the statuses are right on one list, save it as a template:

1. Hover the list → **⋯** → **Templates** → **Save as template**.
2. Name it "Agent pipeline list". Include statuses (you can leave out tasks).
3. For a new project: Space → **+ New list** → **Use template** → "Agent pipeline list".

## Tasks the agents work well with

- One small, clear change per task. A title plus a description with the acceptance criteria (for example
  `AC-1: the screen shows "No orders yet" when the list is empty`).
- Status **to do**. Assign yourself if you use `run --next` or `run --all` (they only pick your tasks).
- Links to specs. If the project syncs ClickUp Docs (`clickup.docs.ids` in `agent.config.json`), the agents
  can read them as files.

## Settings in `.env` and `agent.config.json`

| Setting                 | Where               | What                                                          |
| ----------------------- | ------------------- | ------------------------------------------------------------- |
| `CLICKUP_API_TOKEN`     | `.env`              | Your token. Never commit it.                                  |
| `CLICKUP_OWNER_USER_ID` | `.env`              | Who gets the "ready for review" notification (your user ID)   |
| `clickup.listId`        | `agent.config.json` | The project list                                              |
| `clickup.statuses`      | `agent.config.json` | Status name for each role                                     |
| `clickup.customTaskIds` | `agent.config.json` | `true` if you use IDs like `EKM-123` (also set `workspaceId`) |
| `clickup.docs.ids`      | `agent.config.json` | ClickUp Doc IDs to sync with `clickup sync-docs`              |
