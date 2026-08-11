# Roadmap

## v0.1 — Evidence-Gated Kernel — complete

- bounded autonomous loop
- exact approval capabilities
- content-addressed evidence
- hash-chained Episode ledger
- independent final verifier
- evidence-aware memory
- inactive learned Skill candidates

## v0.2 — Hardened Execution — complete

- Docker-first executor abstraction
- pinned image and deny-by-default network policy
- non-root, read-only, capability-dropped containers
- resource, timeout, and output limits
- short-lived file secret broker
- execution receipts
- Episode leases and stale-lock recovery

## v0.3 — Evaluation-Driven Evolution — complete in this branch

- immutable replay fixtures
- train/evaluation leakage guard
- paired baseline-versus-candidate replay
- quality, safety, cost, and confidence gates
- signed offline and canary reports
- shadow canaries with no production intervention
- explicit report-backed promotion
- rolling production monitor
- automatic rollback

## v0.3.1 — Real Evaluation Qualification

- live GPT-5.6 Sol repeated-run variance matrix
- rootless Docker integration tests on Linux
- Docker Desktop integration tests on macOS
- real image digest, network-none, timeout, and orphan-cleanup tests
- adversarial fixture corpus
- mutation-generated trace and evidence attacks
- evaluator consistency and calibration dashboard

## v0.3.2 — Statistical Hardening

- sequential testing
- multiple-comparison control
- minimum detectable effect planning
- stratified task-family reports
- evaluator drift alarms
- holdout rotation and fixture expiration
- provenance for dataset review and approvals

## v0.4 — Distributed Evidence Control Plane

- signed executor-policy and image-provenance receipts
- remote or hardware-backed report authority
- append-only remote witness for ledger heads
- lease-based multi-agent work graph
- quorum evidence receipts
- ACP/EDL off-chain Episode binding
- signed private Skill registry

## v0.5 — Production Agent Platform

- channel adapters separated from the kernel
- multi-tenant authority isolation
- remote microVM executors
- policy-as-code distribution
- cost attribution and fleet observability
- staged Skill rollout across worker cohorts
