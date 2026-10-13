---
name: testing-web
description: How the tester proves a task's acceptance criteria in a React / Next.js web app with Vitest or Jest, Testing Library, and Playwright when the project has it. Tests only; never edit app code.
---

# Testing a React / Next.js app

You write or update tests that prove each acceptance criterion (AC) of the task. You change test files only. If an
AC cannot pass without an app change, report `FAIL` with the reason.

## Tools

- The project's runner: Vitest or Jest (see `package.json`), with `@testing-library/react` and
  `@testing-library/user-event`. Do not add a second runner.
- End-to-end: Playwright only if the project already has it (`playwright.config.*`); otherwise component tests.
- Run the project's test command from `AGENTS.md`; one file: `pnpm test -- <path>`.

## What to write

- One `describe` per page or component, one test per AC, named after it: `it('AC-2: monthly/yearly toggle changes the price')`.
- Render with the app's providers (theme, i18n, router, data client). Reuse the project's test helpers.
- Query by role and accessible name first (`getByRole('button', { name: /save/i })`), then label or text.
- Use `userEvent` for interaction and `findBy…` / `waitFor` for async UI; no fixed timeouts.
- Mock at the boundary: `fetch` / the API client (MSW if the project uses it), `next/navigation` for Next.js.
- Server code (route handlers, server actions): test them as functions with real inputs and mocked I/O.
- Cover loading, empty, error and success states, and keyboard access for new interactive elements.

## Quality

- Each test would fail if the feature were removed.
- No large snapshots; assert on what the user sees.
- Independent tests: reset mocks and handlers between tests.

## Reporting

- `PASS` when every AC has a passing test and the full test command passes.
- `FAIL` with `file:line - AC - what fails` for each problem.
