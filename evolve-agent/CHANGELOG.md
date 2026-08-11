# Changelog

## 0.3.0 — Evaluation-Driven Evolution

### Added

- content-addressed replay fixtures captured from clean committed Episodes
- supporting-Episode leakage exclusion and frozen training provenance
- paired baseline-versus-candidate replay harness
- exact proposal-trace matching and executed-argument evidence validation
- success, verifier, token, tool-call, duration, trace, and safety metrics
- deterministic paired bootstrap confidence intervals
- configurable non-regression and improvement gates
- Ed25519-signed offline, canary, and monitor reports
- shadow canaries that cannot alter production answers
- rolling production monitoring against a signed canary envelope
- automatic rollback on production regression
- `quarantined` Skill state
- evaluation fixture, report, shadow, monitor, verify, and promotion CLI commands
- evaluation authority enforcement inside `SkillStore`
- 12 new evaluation and integration tests, bringing the suite to 38 tests

### Changed

- package version raised to 0.3.0
- manual canary-score recording replaced by report-backed evaluation flow
- promotion now requires verified signed offline and canary reports
- runtime checkpoints record active Skill IDs and final verifier score
- committed Episode capture and shadow sampling are opt-in; promoted-Skill monitoring remains enabled by default

### Security

- direct low-level promotion fails closed without a signed-report verifier
- report tampering, Skill/report identity mismatch, authority-key mismatch, and policy-hash mismatch block promotion
- fixture imports and captures validate evidence provenance and integrity
- candidate training Episodes cannot approve the candidate they produced

## 0.2.0 — Hardened Execution

### Added

- executor interface with Docker and explicit local backends
- immutable image and network policy objects
- Docker resource and privilege hardening
- short-lived file secret broker with output redaction
- execution receipts with command and policy hashes
- Episode leases, heartbeats, duplicate-run protection, and stale recovery
- `doctor`, `executors list`, and `secrets sweep` diagnostics
- dedicated hardened-execution design documentation
- 14 security tests, bringing the suite to 26 tests

### Changed

- Docker became the default process executor
- local execution became disabled by default
- state home defaults outside the workspace and inside-workspace state is rejected
- truncated process output terminates execution and marks it unsuccessful

## 0.1.0 — Evidence-Gated Kernel

- bounded autonomous loop
- evidence artifacts and hash-chained ledger
- exact approval capabilities
- independent final verification
- governed memory and candidate Skill lifecycle
