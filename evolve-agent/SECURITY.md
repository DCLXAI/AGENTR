# Security

## Security model

Evolve Agent treats model output as untrusted. Tool execution, evidence, memory, Skill activation, evaluation, and promotion are controlled outside the model.

### Core invariants

1. Tool calls pass schema validation, policy, approval, exact capability verification, execution, and evidence capture.
2. A capability binds the Episode, tool, normalized arguments, expiry, and HMAC signature.
3. File tools reject workspace traversal and symlink traversal.
4. Docker is the default executor; local execution is an explicit unsafe escape hatch.
5. Docker images require exact digests, allowlisting, and local presence; implicit pulls are disabled.
6. Network is denied by default; broad built-in network modes are rejected.
7. Container root, added capabilities, privilege escalation, writable root, and unconfined seccomp are not requested.
8. Secret values are delivered as short-lived read-only files, not command arguments or inherited environment values.
9. Evidence is content addressed and tied to the current Episode.
10. Episode events are append-only and predecessor-hash chained.
11. Concurrent ownership of one Episode is rejected by an exclusive lease.
12. Learned Skills remain inactive until signed offline and canary reports pass.
13. Candidate supporting Episodes are excluded from evaluation.
14. Shadow candidate output cannot replace the production answer.
15. `SkillStore` independently verifies signed report identity, authority, policy hash, and decision before promotion.
16. Production regression can automatically revoke a promoted Skill.

## Evaluation authority

Evaluation reports are signed with a local Ed25519 keypair under:

```text
$EVOLVE_HOME/evaluations/authority/
```

The private key is written with mode `0600`. Keep the entire state directory outside `EVOLVE_WORKSPACE`, outside task container mounts, and inaccessible to untrusted users.

A valid signature establishes local integrity and authority continuity. It does **not** provide:

- hardware attestation
- remote witness or quorum
- proof that the host was uncompromised
- proof that the verifier model was correct
- causal proof that a Skill alone created the measured effect

Compromise of the host account or evaluation private key can authorize false reports. Rotate the state directory or keypair after suspected compromise and re-evaluate every affected Skill.

## Replay fixture trust

Fixtures are content addressed and validated, but fixture quality is still part of the trusted evaluation process. Review imported fixtures. Do not accept fixtures from an untrusted party merely because their internal hash is valid.

The capture path rejects incomplete or failed Episodes and verifies:

- source Episode identity
- ordered proposal trace
- evidence source Episode
- evidence tool identity
- executed-argument hash
- artifact hash format
- baseline committed state and score range

A candidate's supporting Episodes are excluded from evaluation. Once evaluation begins, supporting provenance is frozen so later Episodes can remain independent holdout material.

## Shadow and monitor boundary

A shadow canary replays the candidate after a production result has been recorded. Candidate output is stored for evaluation only and never enters the production response path.

Production monitoring compares observed outcomes with a signed canary envelope. Automatic rollback is a safety response, not proof that the Skill caused the regression. Shared model, prompt, tool, traffic, verifier, and environment changes can also move the metrics.

## Docker boundary

Docker substantially reduces authority but is not a perfect kernel-security boundary. The trusted computing base includes:

- host kernel or Docker Desktop VM
- Docker daemon and client
- reviewed image contents
- operator-managed networks
- mounted workspace contents
- Evolve Agent policy and executor code

Use rootless Docker when possible. For hostile multi-tenant workloads, prefer a microVM or restricted remote execution service.

## Secret limitations

Exact secret values are redacted from stdout and stderr before evidence storage. Encoded, hashed, transformed, fragmented, compressed, encrypted, or indirectly derived values may not be recognized. File-secret delivery intentionally lets the approved process read the secret.

Do not expose Docker sockets, cloud metadata endpoints, host credential directories, or broad egress to untrusted workloads.

## State isolation

`EVOLVE_HOME` contains capability authority, evidence, checkpoints, memory, Skills, leases, replay fixtures, evaluation reports, and signing keys. Configuration fails if this directory is located inside `EVOLVE_WORKSPACE`.

Protect backups of the state directory. A backup containing the signing key has the same authority as the live state.

## Vulnerability reporting

Do not open a public issue for a vulnerability that may expose credentials, bypass approval, escape execution isolation, forge evidence, forge an evaluation report, or promote a Skill without valid reports. Use GitHub private vulnerability reporting when enabled.
