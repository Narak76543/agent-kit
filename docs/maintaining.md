# Maintaining the kit

For the people who change the kit itself (this repo).

## Repo layout

| Folder               | What                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `packages/core`      | ClickUp client, Done guard, config, comment protocol. Not published: bundled into the CLI. |
| `packages/cli`       | The `tossana-agents` command. **The only published package** (`@tossana/agents`).          |
| `packages/templates` | Agent files, `AGENTS.base.md`, Antigravity files, skills. Copied into the CLI at build.    |
| `docs/`              | These guides                                                                               |

`PROGRESS.md` has the decisions and the current state. Read it before big changes.

## Daily work

```
pnpm install
pnpm check      # lint + format + typecheck + tests
pnpm build
pnpm coverage   # guard.ts and protocol.ts must stay at 100%
```

- Small commits, one change each.
- Windows + PowerShell is the main platform. Use `node:path`, no bash-only scripts.
- Template files are not formatted by Prettier. Their exact text matters.
- After changing templates, run `pnpm build` before the PowerShell e2e tests (they use the built CLI).

## Release a new version

1. **Choose the version** (semver):
   - patch (`0.1.1`): bug fixes, wording in templates.
   - minor (`0.2.0`): new commands, new options, new template files.
   - major (`1.0.0`): changes that need people to edit `agent.config.json` or change how they work.
2. **Set it** in `packages/cli/package.json` (`version`). The CLI and the "Managed by" header in every kit file
   read it from there.
3. **Check:**
   ```
   pnpm install
   pnpm check
   pnpm coverage
   pnpm build
   ```
4. **Test the package** like a user gets it:
   ```
   cd packages/cli
   pnpm pack                       # makes tossana-agents-<version>.tgz
   ```
   In an empty temp folder (better: a path with spaces), install the `.tgz` and run
   `npx tossana-agents --version`, `init --help` and `doctor`. Also run `init` and `update` in a test copy of a
   real project, and `opencode agent list` there.
5. **Write what changed** in the release notes: new features, fixes, and anything users must do
   (for example "run `tossana-agents update`").
6. **Commit and tag:**
   ```
   git commit -am "chore: release v0.2.0"
   git tag v0.2.0
   git push && git push --tags
   ```
7. **Publish.** The registry is not decided yet (npm under `@tossana`, or GitHub Packages).
   When it is, the command is `pnpm publish` in `packages/cli` (with `--access restricted` for a private
   package). Until then, share the `.tgz` file.

## How users update

```
pnpm add -D @tossana/agents@latest     # or npm install -g @tossana/agents@latest
npx tossana-agents update
```

`update` replaces the kit files they did not edit. For edited files it shows a diff and asks (or keeps them
when there is no terminal). It always makes a backup in `.agents/kit/backup/`. The part of `AGENTS.md` below
`<!-- PROJECT -->` is never changed.

## Adding a kit file

1. Add the template in `packages/templates/`.
2. Add it to `kitFiles()` in `packages/cli/src/templates.ts`.
3. Use `{{placeholders}}` from `packages/cli/src/template-vars.ts`. An unknown placeholder is an error.
4. Update the file counts in the init/update tests.
