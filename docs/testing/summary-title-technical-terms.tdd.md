# Summary title technical terms TDD evidence

## Source and user journey

This task was derived from the production failure investigation. An administrator needs summary jobs to keep safe English technical terms in article titles while producing Vietnamese summary text.

## Task report

| Guarantee | Test target | Type | Result | Evidence |
|---|---|---|---|---|
| Safe English technical terms are accepted in `titleVi` | `test/unit/ai/summary.test.js` | Unit | PASS | RED first failed with `Vietnamese summary title must be plain Vietnamese text`; GREEN passed after separating title and summary validation. |
| `summaryVi` still requires Vietnamese text and rejects markup or excessive length | `test/unit/ai/summary.test.js` | Unit | PASS | `npm test -- --run test/unit/ai/summary.test.js` |
| Safe NFKC and whitespace normalization is accepted without accepting markup | `test/unit/ai/summary.test.js` | Unit | PASS | RED first failed with `Vietnamese summary must be plain text`; GREEN passed after comparing sanitized output with normalized input. |
| Provider instructions preserve proper names and technical terms and define a Vietnamese metadata-only fallback | `test/unit/ai/provider-adapters.test.js` | Unit | PASS | RED first failed on the missing prompt requirements; GREEN passed after updating the summary instruction. |
| DeepSeek and the indexing artifact path remain compatible | DeepSeek/provider/indexing focused tests | Integration | PASS | 5 test files and 59 tests passed before the final fallback test was added. |

## Coverage and operational evidence

- `npm test -- --run test/unit/ai/summary.test.js --coverage --coverage.include=server/ai/summary.js`: 100% statements, branches, functions, and lines before the final fallback-only test was added.
- The local runtime regenerated all 20 failed summary artifacts. Final Atlas state: zero queued jobs, zero published summary artifact failures, and zero published embedding artifact failures.
- Historical failed job records remain in Atlas as audit history.

## Known gap

The metadata-only fallback is an LLM instruction, not a deterministic application-layer invariant. Any other safe Vietnamese summary can still pass validation.
