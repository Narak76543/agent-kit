---
# Managed by @tossana/agents v0.1.0 — do not edit; run "tossana-agents update"
name: testing-flutter
description: How the tester proves a task's acceptance criteria in a Flutter app with flutter_test (widget and unit tests). Tests only; never edit app code.
---

# Testing a Flutter app

You write or update tests that prove each acceptance criterion (AC) of the task. You change files under `test/`
(and `integration_test/` if the project has it) only. If an AC cannot pass without an app change, report `FAIL`.

## Tools

- `flutter_test` for unit and widget tests; `mocktail` or `mockito` if the project already uses one (check
  `pubspec.yaml`, do not add a new mocking package).
- Run `flutter test` (one file: `flutter test test/<path>_test.dart`).

## What to write

- One `group` per screen or widget, one `testWidgets` per AC, named after it: `'AC-3: shows the empty state when there are no orders'`.
- Pump the real widget inside the app's providers and `MaterialApp` (theme, localizations, routing). Reuse the
  project's test helpers (e.g. a `pumpApp` extension) when they exist.
- Find like a user: `find.text`, `find.byType`, `find.bySemanticsLabel`; keys only when nothing else fits.
- Interact with `tester.tap`, `tester.enterText`, then `await tester.pumpAndSettle()` (or `pump` with a duration for
  animations that never settle).
- Fake at the boundary: repositories, HTTP clients, platform channels. Do not fake the widget under test.
- Cover the states the AC names: loading, empty, error, success, and each supported locale when the app is
  translated.

## Quality

- Each test would fail if the feature were removed.
- Golden tests only if the project already uses them, and never update goldens to make a test pass.
- Tests are independent: set up fakes in `setUp`, no shared mutable state.

## Reporting

- `PASS` when every AC has a passing test and `flutter test` passes.
- `FAIL` with `file:line - AC - what fails` for each problem.
