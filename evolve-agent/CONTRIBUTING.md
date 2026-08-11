# Contributing

1. Create a focused branch.
2. Add or update tests for every invariant touched.
3. Run `npm run check`.
4. Keep tool permissions narrow and fail closed.
5. Do not add unrestricted shell execution, silent approval bypasses, or automatic skill promotion.
6. Any new mutating tool must define its risk class, argument validation, evidence output, and rollback story.
