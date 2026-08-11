# Contributing

1. Create a focused branch.
2. Add or update tests for every invariant touched.
3. Run `npm run check` before publishing.
4. Keep tool permissions narrow and fail closed.
5. Do not add unrestricted shell execution, silent approval bypasses, implicit image pulls, broad network defaults, or automatic Skill promotion.
6. Any mutating tool must define its risk class, argument validation, evidence output, and rollback story.
7. Any executor must state which isolation claims it actually enforces and encode them in the execution receipt.
8. Never put secret values in arguments, logs, artifacts, fixtures, or committed environment files.
9. Keep agent authority state outside task-mounted workspaces.
10. Document the trusted computing base and residual risk rather than describing containers as a perfect sandbox.
