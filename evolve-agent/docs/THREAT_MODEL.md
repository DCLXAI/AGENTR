# Threat Model

## Protected assets

- workspace integrity
- OpenAI and external-service credentials
- capability-signing authority
- Episode and evidence integrity
- memory and Skill integrity
- human approval intent
- host availability

## Adversaries

- malicious or compromised model output
- prompt injection embedded in repository content or tool output
- hostile code proposed for execution
- poisoned Docker image or dependency
- concurrent worker racing the same Episode
- crash leaving files, containers, or locks behind
- local user able to edit unprotected state

## Threats and controls

| Threat | Primary controls | Residual risk |
|---|---|---|
| Prompt injection requests a dangerous tool | requested-tool boundary, external policy, explicit approval | user may still approve a harmful exact action |
| Arguments change after approval | HMAC capability over normalized arguments | compromised host authority can sign anything |
| Arbitrary image substitution | digest syntax, exact allowlist, `--pull never` | allowlisted image itself may be malicious |
| Host filesystem escape | only workspace bind mount; state required outside workspace | approved read-write workspace can be damaged |
| Container privilege escalation | non-root UID:GID, read-only root, cap-drop ALL, no-new-privileges, default seccomp | kernel or Docker vulnerabilities remain |
| Unrestricted internet | `network=none`; unsafe built-ins rejected | custom network enforcement is external |
| Secret appears in CLI or env | read-only file mount and `_FILE` pointer | task can read the file by design |
| Secret appears in evidence output | exact-value redaction before artifact storage | transformed or fragmented values can evade detection |
| Process fork bomb | PID limit, CPU/memory limits, timeout | daemon/host-level resource pressure remains possible |
| Infinite output | byte cap, process-group termination, unsuccessful truncated result | disk writes inside approved writable workspace remain |
| Docker client killed but container survives | deterministic name and `docker rm -f` cleanup | daemon outage can delay cleanup |
| Fabricated evidence | current-Episode evidence set and content-addressed artifacts | malicious host can rewrite authority and state together |
| Ledger editing | predecessor hash and event hash verification | no external signature or quorum yet |
| Duplicate Episode execution | exclusive lease and heartbeat | distributed filesystems may have weaker atomicity semantics |
| Unsafe stale-lock steal | TTL plus same-host live-PID check and owner-safe release | PID reuse may delay recovery |
| Poisoned memory | evidence requirement and provenance | evidence can still support an incorrect inference |
| Self-promoted unsafe Skill | candidate-only synthesis and explicit gated promotion | human evaluator can approve a bad Skill |
| Host execution masquerades as sandbox | local executor disabled; explicit host/read-write acknowledgement; receipt boundary `none` | operator can intentionally opt out |

## Out of scope for v0.2

- formal verification of the Docker or kernel boundary
- zero-trust protection from the host administrator or Docker daemon operator
- Firecracker microVM isolation
- domain-aware egress enforcement built into the runtime
- remote secret minting and revocation
- signed or hardware-attested execution receipts
- distributed consensus for leases or the Episode ledger
- semantic detection of all secret-derived output
