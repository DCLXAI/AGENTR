# Evolve Agent

> An evidence-gated autonomous agent kernel for **GPT-5.6 Sol**, now with a hardened execution plane.

Evolve Agent is built around one rule:

> An agent should gain authority only when its work is observable, evidence-backed, bounded, isolated, evaluated, and reversible.

OpenClaw is excellent at gateway reach. Hermes Agent is strong at persistent learning loops. Evolve Agent targets the missing control layer between them: **verifiable adaptation with an explicit authority boundary**.

**v0.2 Hardened Execution** moves process tools out of the agent host and into a deny-by-default Docker executor. It does not claim to match the ecosystem or production maturity of OpenClaw or Hermes. It does implement a narrower set of strong invariants around execution, evidence, secrets, and recovery.

## What v0.2 adds

- Docker-first executor abstraction; host execution is disabled by default
- exact `sha256` image pinning and image allowlist
- `--pull never` so a task cannot fetch an unreviewed image implicitly
- `network=none` by default; unsafe built-in networks are rejected
- read-only container root and read-only workspace by default
- non-root numeric container user
- all Linux capabilities dropped and `no-new-privileges` enabled
- default Docker seccomp policy retained; the runtime never requests `seccomp=unconfined`
- memory, swap, CPU, PID, tmpfs, file-descriptor, timeout, and output limits
- process-group termination plus best-effort orphan-container cleanup
- short-lived `0600` secret files, name allowlist, TTL sweep, and exact-value output redaction
- execution receipts containing command and policy hashes
- per-Episode lease, heartbeat, duplicate-resume rejection, and stale-lock recovery
- agent authority state is required to live outside the mounted workspace
- 26 invariant and end-to-end tests

The v0.1 evidence and learning controls remain:

- GPT-5.6 Sol through the OpenAI Responses API
- bounded autonomous loop and durable checkpoints
- separate final-answer verification pass
- content-addressed artifacts and current-Episode evidence IDs
- append-only SHA-256 hash-chained episode ledger
- exact expiring HMAC capabilities bound to normalized tool arguments
- explicit approval for protected actions
- evidence-aware memory
- candidate → evaluation → canary → explicit promotion → rollback Skill lifecycle
- no automatic Skill promotion

## Hardened process path

```text
GPT-5.6 Sol proposes run_process
        |
        v
schema validation + task tool boundary
        |
        v
human approval of exact normalized arguments
        |
        v
HMAC capability bound to episode + tool + arguments + expiry
        |
        v
ExecutorRegistry
        |
        +--> DockerExecutor (default)
        |      exact pinned image allowlist
        |      network deny-all by default
        |      read-only root/workspace
        |      non-root + cap-drop ALL + no-new-privileges
        |      cgroup/resource limits + output limit
        |      ephemeral file secrets + redaction
        |
        +--> LocalExecutor (disabled unsafe escape hatch)
        |
        v
execution receipt + stdout/stderr artifact
        |
        v
hash-chained ledger + checkpoint + independent verifier
```

See [docs/HARDENED_EXECUTION.md](docs/HARDENED_EXECUTION.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Requirements

- Node.js 22.6 or newer
- Docker Engine or Docker Desktop for the default executor
- an OpenAI API key with access to the configured model
- at least one reviewed Docker image available locally under an exact digest

## Install

```bash
cd evolve-agent
npm install
cp .env.example .env
npm run check
```

Export the API key in the shell or a protected environment manager:

```bash
export OPENAI_API_KEY="..."
```

## Configure a pinned image

Pull an image deliberately, inspect its immutable repository digest, then allowlist that exact value:

```bash
docker pull node:22-bookworm-slim
IMAGE="$(docker image inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}')"

export EVOLVE_DOCKER_DEFAULT_IMAGE="$IMAGE"
export EVOLVE_DOCKER_ALLOWED_IMAGES="$IMAGE"
```

The runtime itself uses `--pull never`. A missing local image therefore fails rather than silently changing the execution environment.

For stricter host configuration:

```bash
export EVOLVE_DOCKER_REQUIRE_ROOTLESS=true
```

Run the readiness check:

```bash
npm run dev -- doctor
```

`doctor` reports API readiness, the default executor, image presence, rootless status, resource ceilings, network allowlist, secret names, stale-secret cleanup, and lease settings. It never prints secret values.

## Run a read-only task

Only read tools are enabled when no `--tool` boundary is supplied:

```bash
npm run dev -- run \
  "Read package.json and explain the scripts" \
  --workspace . \
  --tool read_file \
  --success "Every package-specific claim cites current-Episode evidence"
```

Evidence-backed final answers use this syntax:

```text
The test script compiles the test tree and invokes Node's test runner. [evidence:ev_...]
```

The evidence ID is accepted only if that exact Episode produced it.

## Run code in the hardened executor

```bash
npm run dev -- run \
  "Inspect the package and run its typecheck without network access" \
  --workspace . \
  --tool list_files read_file search_text run_process \
  --constraint "Use the Docker executor, network none, and a read-only workspace" \
  --success "The typecheck result is backed by run_process evidence"
```

The model's `run_process` proposal can contain:

```json
{
  "command": "npm",
  "args": ["run", "typecheck"],
  "executor": "docker",
  "network": "none",
  "workspace_access": "read-only",
  "memory_mb": 1024,
  "cpus": 1,
  "pids_limit": 128,
  "tmpfs_mb": 64
}
```

The exact normalized object is shown for approval and bound into the capability token. Altering an argument after approval invalidates the token.

### Writable workspace

A writable bind mount is available only when the proposal explicitly requests:

```json
{ "workspace_access": "read-write" }
```

This changes the approved authority and is visible in the execution receipt. Prefer read-only inspection followed by narrow `write_file` or `replace_text` operations when possible.

## Secret delivery

Allowlist secret **names**, not values:

```bash
export EVOLVE_SECRET_ALLOWLIST="NPM_TOKEN"
export NPM_TOKEN="..."
```

A process request may then include:

```json
{ "secrets": ["NPM_TOKEN"] }
```

The executor writes a short-lived `0600` host file, mounts it read-only at `/run/secrets/NPM_TOKEN`, and sets only:

```text
NPM_TOKEN_FILE=/run/secrets/NPM_TOKEN
```

The value is never placed in Docker CLI arguments or the child environment. Exact occurrences in stdout and stderr are replaced with `[REDACTED_SECRET:NPM_TOKEN]` before evidence is stored. Applications must deliberately read the `_FILE` path.

Redaction is a last line of defense, not a data-loss-prevention system. Encoded, transformed, fragmented, or encrypted derivatives of a secret cannot be reliably recognized.

## Network policy

The default is:

```json
{ "network": "none" }
```

`host`, `bridge`, `default`, and container-sharing modes are rejected. Additional names must be configured by the operator:

```bash
export EVOLVE_DOCKER_ALLOWED_NETWORKS="evolve-egress"
```

An allowlisted named network is only a delegation to an **operator-managed network boundary**. Evolve Agent does not claim that a Docker network name by itself provides domain-level egress control. Configure firewall, proxy, DNS, or service-mesh policy outside the process container.

## State isolation

Agent state contains the capability authority, checkpoints, memory, Skills, evidence metadata, and leases. It must not be exposed to sandboxed code.

For that reason, v0.2 rejects configurations where `EVOLVE_HOME` is inside `EVOLVE_WORKSPACE`. When `EVOLVE_HOME` is omitted, a per-workspace state directory is derived under:

```text
$XDG_STATE_HOME/evolve-agent/<workspace-hash>
```

or, when `XDG_STATE_HOME` is absent:

```text
~/.local/state/evolve-agent/<workspace-hash>
```

## Crash recovery and Episode leases

Every run or resume acquires an atomic Episode lease and refreshes its heartbeat. A second process cannot resume the same Episode concurrently.

If the heartbeat is older than the configured TTL, the runtime checks whether the recorded process is still alive on the same host. It recovers only a dead or remote stale owner and writes `episode.stale_lock_recovered` to the ledger.

```bash
npm run dev -- resume <episode-id> --workspace .
```

Committed and budget-exhausted Episodes remain terminal.

## Unsafe local escape hatch

The local executor is intentionally unavailable by default. Enabling it requires an explicit operator decision:

```bash
npm run dev -- doctor --executor local --allow-local-executor
```

A local process request must acknowledge both unenforceable properties:

```json
{
  "executor": "local",
  "network": "host",
  "workspace_access": "read-write"
}
```

It cannot receive brokered secrets. Evidence marks its isolation boundary as `none`. Do not use it for untrusted code.

## Inspect executors and clean stale secret leases

```bash
npm run dev -- executors list
npm run dev -- secrets sweep
```

## Verify the ledger

```bash
npm run dev -- ledger verify
```

## Govern learned Skills

```bash
npm run dev -- skills list
npm run dev -- skills evaluate <skill-id>
npm run dev -- skills canary <skill-id> --passed --score 0.91 --note "isolated replay passed"
npm run dev -- skills promote <skill-id>
npm run dev -- skills rollback <skill-id> --note "regression detected"
```

A repeated successful flow creates only an inactive candidate. A model cannot promote its own Skill.

## Built-in tools

| Tool | Risk | Main controls |
|---|---:|---|
| `list_files` | read | workspace boundary, recursion and entry caps |
| `read_file` | read | regular-file check, byte cap, SHA-256 output |
| `search_text` | read | literal search, file/result/size caps |
| `write_file` | write | exact approval, create-only option, SHA compare-and-swap |
| `replace_text` | write | exact approval, occurrence count, SHA compare-and-swap |
| `run_process` | execute | exact approval, executor policy, image/network/resource/secret controls |

## Validation

```bash
npm run check
```

The v0.2 suite covers:

- capability argument binding and expiry
- registry revalidation after approval
- ledger mutation detection
- workspace traversal and symlink rejection
- agent-state separation from the workspace
- Docker image digest and allowlist enforcement
- unsafe Docker network rejection
- non-root container user enforcement
- hardening flag construction
- secret non-leakage into Docker arguments and environment
- secret file permissions, cleanup, TTL sweep, and stdout/stderr redaction
- resource receipt generation
- output-flood termination
- local executor explicit-risk acknowledgement
- active Episode duplicate rejection
- dead stale-lock recovery and live-process protection
- evidence-backed final commit and independent verification
- fabricated evidence rejection
- durable budget exhaustion
- governed Skill promotion and rollback

## Honest limits

v0.2 substantially narrows execution authority, but it is not a formal sandbox proof.

- The Docker daemon and approved image remain trusted computing base.
- A Docker named network needs external egress enforcement.
- Exact-value redaction cannot catch transformed secrets.
- Read-write workspace approval permits the container to alter the mounted project.
- Docker Desktop uses a VM boundary, while native Docker security depends on host configuration.
- Firecracker, per-request microVM images, signed execution attestations, and remote secret brokers remain future work.
- No live GPT-5.6 Sol request is performed by the test suite; provider integration uses a deterministic local HTTP test server.

Read [SECURITY.md](SECURITY.md) before using the executor on hostile workloads.

## Repository layout

```text
src/execution     executor interface, Docker/local backends, policies, runner
src/secrets       short-lived file secret broker and redaction
src/runtime       bounded loop, checkpoints, Episode leases
src/ledger        event hash chain and content-addressed evidence
src/policy        risk decisions, approval, exact capabilities
src/tools         workspace tools and executor-backed run_process
src/providers     GPT-5.6 Sol Responses API and mock provider
src/verification  deterministic and model-based final verification
src/memory        evidence-aware durable memory
src/learning      repeated-Episode pattern detection
src/skills        candidate/evaluation/canary/promotion lifecycle
tests             security invariants and end-to-end tests
```

## License

MIT
