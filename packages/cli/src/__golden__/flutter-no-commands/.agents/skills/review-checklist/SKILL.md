---
# Managed by @tossana/agents v0.1.0 — do not edit; run "tossana-agents update"
name: review-checklist
description: What the reviewer checks on every task branch, in order, and how to write issues the coder can act on. Read-only review; never edit files.
---

# Review checklist

You review the diff of the task branch against the base branch (`git diff <base>...HEAD`), the ClickUp task and
`AGENTS.md`. You never edit files. Go through the list in order; stop adding nits once you have real problems.

## 1. Does it do the task?

- Every acceptance criterion (AC) of the task is met. Name the AC code in each issue about it.
- Nothing extra: no unrelated refactors, renames or "while I was here" changes. Unrelated changes are an issue.
- The task's edge cases are handled: empty, loading, error, no network, long text, other languages.

## 2. Is it correct?

- Logic errors, off-by-one, wrong conditions, missing `await`, unhandled promise rejections.
- Null/undefined handling at boundaries (API responses, route params, storage).
- State: no stale closures, no updates after unmount, no duplicated sources of truth.
- Errors are shown to the user or reported, never swallowed silently.

## 3. Is it safe?

- No secrets, tokens or personal data in code, logs, tests or fixtures.
- Input from users or APIs is validated before use; no string-built SQL, shell or HTML.
- No new dependency without a reason in the handoff note.

## 4. Does it follow the project?

- The conventions in the project section of `AGENTS.md` and in the stack skill (structure, naming, components,
  design tokens, translations). Hard-coded colors, sizes or user-facing strings are issues when the project has
  tokens or translation files for them.
- Existing helpers and components are reused instead of copied.

## 5. Is it tested?

- New logic has unit tests; changed behaviour has updated tests. The tester proves the ACs, but the coder's own
  tests must not be missing for non-trivial logic.
- The quality gate passes (lint, typecheck, tests). If you can run it read-only, do; otherwise say what you could
  not check.

## Writing the result

- `APPROVED` only when nothing in sections 1–3 is open. Style nits alone never block.
- `CHANGES_NEEDED`: one issue per line, `file:line - what is wrong and what to do`, most important first. Be
  concrete ("`OrdersScreen.tsx:42` - empty list shows a blank screen; show the empty state from AC-3"), never vague
  ("improve error handling").
- In a later round, first check that every issue from the previous round is fixed; list any that are not.
