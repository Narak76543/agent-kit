---
# Managed by @tossana/agents v0.1.0 — do not edit; run "tossana-agents update"
name: explore
description: Refresh the ClickUp specs into docs/clickup and update the project part of AGENTS.md (below the <!-- PROJECT --> marker) so it matches the code. Use when the user says /explore or asks to re-learn the project.
---

# /explore

1. If the project syncs ClickUp docs, run `tossana-agents clickup sync-docs` to pull the latest specs into
   `docs/clickup/`, then `git status --short docs/clickup` and `git diff --stat docs/clickup` to see what
   changed. If it says no docs are configured, skip to step 3.
2. Read `docs/clickup/INDEX.md` and the pages that changed.
3. Explore the codebase: folder structure, navigation, state, API layer, design system, tests, and the
   project's scripts/commands.
4. Update only the part of `AGENTS.md` **below** the `<!-- PROJECT -->` marker where it no longer matches
   reality. Never change anything above the marker: the kit manages it (`tossana-agents update`).
5. Do not change any other files. Report what you changed in 5 lines or less.
