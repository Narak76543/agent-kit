---
name: explore
description: Refresh the ClickUp specs into {{docs.outDir}} and update the project part of AGENTS.md (below the <!-- PROJECT --> marker) so it matches the code. Use when the user says /explore or asks to re-learn the project.
---

# /explore

1. If the project syncs ClickUp docs, run `{{kit.cmd}} clickup sync-docs` to pull the latest specs into
   `{{docs.outDir}}/`, then `git status --short {{docs.outDir}}` and `git diff --stat {{docs.outDir}}` to see what
   changed. If it says no docs are configured, skip to step 3.
2. Read `{{docs.outDir}}/INDEX.md` and the pages that changed.
3. Explore the codebase: folder structure, navigation, state, API layer, design system, tests, and the
   project's scripts/commands.
4. Update only the part of `AGENTS.md` **below** the `<!-- PROJECT -->` marker where it no longer matches
   reality. Never change anything above the marker: the kit manages it (`{{kit.cmd}} update`).
5. Do not change any other files. Report what you changed in 5 lines or less.
