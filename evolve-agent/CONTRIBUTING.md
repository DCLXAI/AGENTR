# Contributing

1. Create a focused branch and keep unrelated application changes out of the PR.
2. Add or update tests for every invariant touched.
3. Run `npm run check` and `npm pack --dry-run` before publishing.
4. Keep tool, executor, fixture, evaluator, and promotion permissions narrow and fail closed.
5. Do not add unrestricted shell execution, silent approval bypasses, implicit image pulls, broad network defaults, automatic Skill promotion, or unsigned promotion shortcuts.
6. A mutating tool must define risk class, validation, evidence output, and rollback behavior.
7. An executor must state which isolation properties it actually enforces and encode them in its receipt.
8. An evaluation metric must define its direction, pairing unit, failure semantics, sample requirements, and regression threshold.
9. Evaluation fixtures must preserve provenance and must not reuse a candidate's supporting Episodes as approval data.
10. Never put secret values, private signing keys, or production credentials in arguments, logs, artifacts, fixtures, tests, or committed environment files.
11. Keep agent authority and evaluation state outside task-mounted workspaces.
12. Document the trusted computing base and residual risk; do not describe containers, model verification, or signed reports as stronger guarantees than they provide.
