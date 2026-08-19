# TDD evidence: Admin Source Registry navigation

## Scope

This journey was derived from the user request; no separate plan file was supplied.

As an admin, I want a visible Source Registry destination in the dashboard so that I can review source policy and lifecycle state through the existing Source Registry screen.

## RED/GREEN checkpoints

| Stage | Commit | Evidence |
|---|---|---|
| RED | `0401ca2` | `npm test -- --run test/client/app-shell.test.js` executed before the implementation: 3 failed, 3 passed. Failures were the missing Source Registry desktop destination and mobile control. |
| GREEN | `d033d7f` | The same target passed: 1 file, 6 tests. |
| Refactor | `cf0812c` | Mobile `aria-current` styling was aligned with the existing admin navigation styles; the focused suite remained green. |

## Guarantees

| # | Guarantee | Test | Type | Result |
|---|---|---|---|---|
| 1 | Desktop admin navigation exposes `Source Registry` and marks it current when selected. | `test/client/app-shell.test.js` | unit | PASS |
| 2 | Selecting the desktop Source Registry button calls `onNavigate('sources')`. | `test/client/app-shell.test.js` | unit | PASS |
| 3 | Mobile admin workspaces expose both Source Registry and account controls, including Jobs and Sources routes. | `test/client/app-shell.test.js` | unit | PASS |
| 4 | The existing Source Registry screen and mounted admin route regressions remain green. | `test/client/source-registry.test.js`, `test/ui/admin/admin-mounted.test.js` | unit/mounted | PASS |

## Verification

Commands actually run on the branch:

- `npm test -- --run test/client/app-shell.test.js`: PASS, 1 file/6 tests.
- `npm test -- --run test/client/app-shell.test.js test/client/source-registry.test.js test/ui/admin/admin-mounted.test.js`: PASS, 3 files/33 tests.
- `npx eslint client/App.jsx client/styles.css test/client/app-shell.test.js`: no errors; `styles.css` is intentionally ignored by the project ESLint configuration.
- `npm run build`: PASS, Vite built 70 modules.
- `git diff --check`: PASS.
- `npm test -- --run`: PASS, 169 files/1,013 tests; 16 files/66 tests remain skipped by the repository's existing configuration.

The full coverage command `npm test -- --run --coverage` completed all 169 files and 1,013 tests, reporting 67.09% statements, 65.44% branches, 72.13% functions, and 73.98% lines; the repository global thresholds (80% statements/lines/functions and 75% branches) therefore remain unmet outside this feature's scope. A prior coverage attempt also observed an intermittent RSS parser timeout, but the normal full suite and the final coverage run completed all tests. The focused coverage command cannot represent the global project threshold because Vitest instruments the whole application while selecting only two files.

## Merge evidence

Before merge, rerun the focused suite, lint, build, and `git diff --check` on this branch. Merge with fast-forward only after those checks pass; no push is performed by this task.
