# Threat model

## Protected assets

- workspace files
- local credentials and environment
- tool permissions
- episode integrity
- memory and skill integrity
- human approval intent

## Main threats and controls

| Threat | Control |
|---|---|
| Prompt injection requests a dangerous tool | Policy and approval remain outside the model |
| Arguments change after approval | HMAC capability binds exact normalized arguments |
| Path or symlink traversal | Canonical workspace containment and symlink rejection |
| Shell injection | No shell, executable allowlist, argument array |
| Environment-variable secret theft | Minimal child environment excludes API keys and most inherited variables |
| Fabricated evidence | Content-addressed artifacts and current-episode evidence set |
| Ledger editing | Per-event hash plus previous-event hash chain |
| Poisoned memory | Confidence/evidence rule and append-only provenance |
| Unsafe self-modification | Candidate-only generation, evaluation, canary, explicit promotion |
| Infinite loop or runaway cost | Hard turn, tool, token, and wall-time budgets |
| Host compromise through approved process | Not fully solved by local backend; use hardened sandbox adapter |

## Out of scope in v0.1

- hostile native binaries after explicit approval
- kernel isolation
- multi-tenant secret isolation
- distributed consensus for the ledger
- formal verification of model-generated instructions
