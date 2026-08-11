# Security

## v0.2 security invariants

1. Agent authority state must remain outside the mounted workspace.
2. `run_process` cannot execute outside the task's declared tool boundary.
3. Protected actions require approval of the exact normalized arguments.
4. A capability token binds Episode, tool, arguments, nonce, and expiry.
5. Docker images must use an exact `sha256` digest and appear in the operator allowlist.
6. The runtime never pulls an image during task execution.
7. Docker execution defaults to no network, read-only root, read-only workspace, non-root user, dropped capabilities, and no new privileges.
8. Runtime CPU, memory, PID, tmpfs, timeout, output, and file-descriptor ceilings are enforced through the executor contract.
9. Secret values enter the container only as short-lived read-only files; they do not enter Docker CLI arguments or inherited environment variables.
10. Tool evidence records the executor, immutable image, network policy, workspace access, isolation properties, and command/policy hashes.
11. An Episode has one active lease. Concurrent resume is rejected; stale recovery is ledgered.
12. Learned Skills remain inactive until evaluation, canary, score, and explicit-promotion gates pass.

## Docker trust boundary

The Docker executor is materially safer than host process execution, but it is not independent of Docker security.

Trusted components include:

- the host kernel or Docker Desktop VM
- Docker daemon and client
- the exact allowlisted image
- the operator's named-network policy
- Evolve Agent's process runner and policy code

Do not expose the Docker socket to a task container. Do not run the daemon with weakened seccomp or AppArmor/SELinux configuration. Evolve Agent does not request privileged mode, host namespaces, devices, added capabilities, or `seccomp=unconfined`.

`EVOLVE_DOCKER_REQUIRE_ROOTLESS=true` makes rootless mode part of readiness. Even without it, each container is forced to a non-root numeric UID:GID.

## State placement

`EVOLVE_HOME` contains `capability.key`, evidence, checkpoints, memory, Skills, and leases. v0.2 rejects a home directory located inside `EVOLVE_WORKSPACE`, because the workspace is mounted into task containers.

Protect the state directory with normal host access controls. A local attacker who can edit the ledger and capability key together remains outside the guarantees of a plain hash chain.

## Secret handling

- Only names in `EVOLVE_SECRET_ALLOWLIST` can be requested.
- Missing, empty, malformed, and oversized secrets are denied.
- Materialized directories use mode `0700`; value files use `0600`.
- Each file is mounted read-only under `/run/secrets`.
- Only `<NAME>_FILE` is set inside the container.
- Leases are deleted after execution and swept after TTL on interrupted cleanup.
- Exact secret values are redacted from stdout and stderr before artifact storage.

Limitations:

- encoded, hashed, split, compressed, encrypted, or otherwise transformed values may evade redaction
- a task with read-write workspace access can intentionally write secret-derived data into the workspace
- host administrators and Docker daemon operators can inspect mounted files

Use narrow, short-lived credentials with server-side scope and revocation. A future version should integrate an external secret broker that mints per-run credentials rather than exposing long-lived environment values.

## Network policy

`network=none` is the only self-contained deny-all setting. Additional allowlisted Docker networks are labeled `operator-managed:<name>` in evidence. The operator must make that network enforce egress through firewall, proxy, DNS, or service policy.

The runtime rejects Docker's `host`, `bridge`, `default`, and container-sharing modes.

## Unsafe local executor

The local executor is disabled unless `EVOLVE_ALLOW_LOCAL_EXECUTOR=true` or the equivalent CLI flag is supplied. It additionally requires `network=host` and `workspace_access=read-write`, because pretending to enforce narrower access would be misleading. It cannot receive brokered secrets.

Local execution is not an isolation boundary and should not run hostile code.

## Denial of service

The executor applies time, output, CPU, memory, swap, PID, tmpfs, and file-descriptor limits. Output overflow terminates the process and marks the result unsuccessful. Remaining risks include Docker daemon exhaustion, disk pressure in the writable workspace, image decompression cost before execution, and host-level attacks against Docker itself.

## Stale-lock recovery

Lease heartbeat age alone is not enough to steal a local lock. If the record belongs to the same hostname and its PID is alive, recovery is rejected even after TTL. Dead or remote stale owners are atomically quarantined, removed, replaced, and recorded in the Episode ledger.

PID reuse can still produce conservative false positives. It should delay recovery rather than permit duplicate execution.

## Vulnerability reporting

Do not open a public issue for a vulnerability that could expose credentials, bypass approval, escape the sandbox, forge evidence, or enable unauthorized execution. Use GitHub private vulnerability reporting when enabled.
