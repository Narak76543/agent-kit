---
name: testing-react-native
description: How the tester proves a task's acceptance criteria in a React Native / Expo app with Jest and React Native Testing Library. Tests only; never edit app code.
---

# Testing a React Native app

You write or update tests that prove each acceptance criterion (AC) of the task. You change test files only.
If an AC cannot pass without an app change, report `FAIL` with the reason; do not fix the app yourself.

## Tools

- Jest (`jest-expo` preset when the project uses Expo) and React Native Testing Library (`@testing-library/react-native`).
- Run the project's test command from `AGENTS.md` (e.g. `pnpm test`); run one file with `pnpm test -- <path>`.

## What to write

- One `describe` per screen or component, one `it` per AC, named after it: `it('AC-3: shows the empty state when there are no orders')`.
- Render the real component with its providers (theme, i18n, navigation, query client). Reuse the project's test
  helpers (look for `test-utils`, `renderWithProviders` or similar) instead of building new wrappers.
- Query like a user: `getByText`, `getByRole`, `getByLabelText`; `getByTestId` only when nothing else fits.
- Interact with `fireEvent` / `userEvent`, wait with `findBy…` or `waitFor`, never with fixed timeouts.
- Mock at the boundary only: network (the project's API client or `fetch`), native modules, navigation. Do not mock
  the component under test.
- Cover the states the AC names: loading, empty, error, success, and other languages when the app is translated
  (render with each locale and check one key string).

## Quality

- Each test fails if the feature is removed (check one by temporarily reasoning about it, not by editing app code).
- No snapshot tests for whole screens; small, stable snapshots only if the project already uses them.
- Tests are independent: reset mocks in `beforeEach`, no shared mutable state, no order dependence.

## Reporting

- `PASS` when every AC has a passing test and the full test command passes.
- `FAIL` with `file:line - AC - what fails` for each problem, and whether it is the app or the test environment.
