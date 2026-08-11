# Roadmap

## v0.1 — Evidence-gated kernel — complete

- bounded task loop
- hash-chained Episode ledger
- content-addressed artifacts
- exact capability tokens
- policy and human approval boundary
- independent final verification
- checkpoints and budgets
- governed Skill lifecycle

## v0.2 — Hardened Execution — complete in this branch

- executor interface and registry
- Docker-first fail-closed backend
- exact digest image allowlist and `--pull never`
- deny-all default network and custom-network delegation
- non-root, read-only root, dropped capabilities, no-new-privileges
- memory/CPU/PID/tmpfs/timeout/output limits
- short-lived file secret broker and exact-value output redaction
- execution command/policy receipts
- state/workspace separation
- Episode lease, heartbeat, duplicate rejection, stale recovery
- explicit non-isolated local escape hatch

## v0.2.1 — Stronger sandbox adapters

- Firecracker executor with prebuilt measured rootfs
- remote sandbox executor interface
- per-run ephemeral writable overlay
- seccomp/AppArmor profile attestation
- daemon orphan reaper and startup reconciliation
- platform-specific Docker Desktop and native-Linux policy checks

## v0.3 — Evaluation-driven evolution

- replayable Episode fixtures
- counterfactual Skill evaluation
- shadow execution and automatic canaries
- regression-triggered rollback
- signed Skill provenance and private registry
- benchmark comparison against OpenClaw and Hermes on long-running tasks

## v0.4 — Distributed control plane

- channel adapters separated from the kernel
- multi-agent work graph with lease-based ownership
- durable queue and idempotent tool commits
- quorum evidence receipts
- ACP/EDL off-chain Episode binder
- distributed observability and cost attribution

## v0.5 — Attested autonomous operations

- external secret broker with per-run credentials
- signed execution and evaluation receipts
- policy-as-code bundles
- multi-party approval for high-impact actions
- tamper-evident remote ledger anchoring
