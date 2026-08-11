# Changelog

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
- 14 new security tests, bringing the suite to 26 tests

### Changed

- Docker is the default process executor
- local execution is disabled by default
- state home defaults outside the workspace and inside-workspace state is rejected
- truncated process output now terminates execution and marks it unsuccessful
- package version raised to 0.2.0

### Security

- image tags without digest are rejected
- unsafe built-in Docker networks are rejected
- container root UID/GID is rejected
- API keys and most host environment variables are excluded from child processes
- secret values are absent from Docker arguments and inherited environment

## 0.1.0 — Evidence-gated kernel

- bounded autonomous loop
- evidence artifacts and hash-chained ledger
- exact approval capabilities
- independent final verification
- governed memory and Skill lifecycle
