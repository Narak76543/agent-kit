---
name: testing-node
description: How the tester proves a task's acceptance criteria in a Node.js backend (API, services, jobs) with the project's test runner and HTTP-level tests. Tests only; never edit app code.
---

# Testing a Node.js backend

You write or update tests that prove each acceptance criterion (AC) of the task. You change test files only. If an
AC cannot pass without an app change, report `FAIL` with the reason.

## Tools

- The project's runner (Vitest, Jest or `node:test`, see `package.json`); `supertest` or the framework's inject
  helper (Fastify `inject`, Nest testing module) if the project already uses one.
- Run the project's test command from `AGENTS.md`; one file: `pnpm test -- <path>`.

## What to write

- One `describe` per endpoint or service, one test per AC, named after it: `it('AC-1: POST /orders returns 201 with the new order')`.
- API: call the real route through the app instance (no network port), assert status, body shape and headers.
  Include the error cases the AC implies: 400 for invalid input, 401/403 for missing or wrong auth, 404, 409.
- Services: call them as functions with real inputs; fake only I/O at the boundary (database, queues, external
  HTTP, clock, random). Prefer the project's test database or in-memory adapter over mocking every query.
- Validation: one test per rule the AC names, plus one valid case.
- Time and randomness: inject or fake them; never depend on the real clock.

## Quality

- Each test would fail if the feature were removed.
- No secrets or real credentials in tests or fixtures; use obviously fake values.
- Independent tests: clean data and mocks between tests, no order dependence, no shared server state.

## Reporting

- `PASS` when every AC has a passing test and the full test command passes.
- `FAIL` with `file:line - AC - what fails` for each problem.
