# Hardened Execution Design

## Goals

The v0.2 executor is designed to make these statements true and testable:

- a model cannot silently upgrade from read-only inspection to host execution
- an approval for one command cannot authorize changed arguments
- a task cannot choose an arbitrary image or network
- a process cannot inherit the agent's API keys
- a normal task has no network, immutable root filesystem, and bounded resources
- the evidence record identifies the exact execution policy
- a crashed task does not leave an Episode permanently locked

## Executor contract

`ExecutionRequest` contains all authority-relevant fields:

```text
run ID
command + argument array
canonical workspace + working directory
workspace read/write mode
network policy name
immutable image reference
secret names
memory / CPU / PID / tmpfs ceilings
timeout and evidence-output ceiling
```

`ExecutionResult` contains:

```text
exit state and duration
bounded, redacted stdout/stderr
executor and immutable image
network and workspace mode
secret names, never values
isolation claims
command hash and policy hash
sandbox identifier
```

The request is already covered by the HMAC capability and the artifact store's argument hash. The execution receipt adds a compact policy identity for comparison, replay, and future attestation.

## Docker argument profile

The executor builds an argument array and invokes Docker without a shell. Its core profile is:

```text
docker run --rm --init --pull never
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges:true
  --network none
  --user <non-root uid:gid>
  --ipc none
  --memory <limit> --memory-swap <same limit>
  --cpus <limit>
  --pids-limit <limit>
  --tmpfs /tmp:rw,nosuid,nodev,size=<limit>
  --tmpfs /run:rw,nosuid,nodev,noexec,size=16m
  --ulimit nofile=1024:1024
  --ulimit core=0:0
  --log-driver none
  --mount type=bind,src=<workspace>,dst=/workspace,readonly
  <pinned allowlisted image>
  <allowlisted executable> <argument array>
```

The runtime does not pass `--privileged`, host PID/IPC/network namespaces, devices, Docker socket, added capabilities, or an unconfined seccomp profile.

## Image policy

An accepted reference has the form:

```text
repository/name[:tag]@sha256:<64 lowercase hexadecimal characters>
```

or a raw local image digest. Tags alone are rejected. The exact value must appear in `EVOLVE_DOCKER_ALLOWED_IMAGES`. `--pull never` makes missing content an error.

This establishes identity, not safety. The operator still owns image review, provenance, and patch policy.

## Network policy

`none` is always available and maps to `deny-all` in the receipt. Built-in broad networks are rejected.

A custom allowlisted network is mapped to `operator-managed:<name>`. The name is not treated as proof of domain-level filtering. External infrastructure must enforce the actual routes.

## Secret broker

The broker separates authorization, materialization, delivery, evidence, and cleanup:

1. validate name syntax
2. require operator allowlist membership
3. fetch value from the host source
4. reject missing, empty, or oversized values
5. write a private per-run directory and `0600` file
6. mount the file read-only
7. expose only `<NAME>_FILE`
8. redact exact values from process output
9. delete files in `finally`
10. sweep expired directories after interrupted cleanup

No secret value appears in the Docker command line, executor receipt, or tool arguments.

## Output and timeout handling

The host runner captures stdout and stderr under one byte ceiling. When the ceiling is crossed, it terminates the entire detached process group, escalates to `SIGKILL`, marks output truncated, and treats the execution as unsuccessful.

A timeout follows the same group-termination path. Docker execution then performs `docker rm -f <deterministic-container-name>` as best-effort cleanup, covering the case where killing the Docker client leaves a container behind.

## Episode leases

A lease file is created with exclusive `open(..., "wx")`. The owning process keeps the file handle open and updates its timestamps on a heartbeat.

Recovery requires:

- heartbeat older than TTL, and
- no live recorded PID on the same hostname

The stale path is atomically renamed before a new lease is created. The old owner cannot delete the replacement because release verifies owner ID.

## Local executor

Local execution exists only as a migration escape hatch. It deliberately refuses claims it cannot enforce:

- `network=none` is rejected; the caller must request `host`
- `workspace_access=read-only` is rejected; the caller must request `read-write`
- secrets are rejected

Its evidence reports `boundary: none`.

## Future adapters

The interface is designed to support Firecracker, Vercel Sandbox, Daytona, or a remote execution service without changing the model-facing tool contract. An adapter must provide equivalent receipts and must not weaken the policy silently.
