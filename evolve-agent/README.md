# Evolve Agent

> An evidence-gated autonomous agent kernel for **GPT-5.6 Sol** with hardened execution and evaluation-driven Skill evolution.

Evolve Agent is built around one rule:

> An agent gains authority only when its work is observable, evidence-backed, bounded, isolated, evaluated, and reversible.

OpenClaw is strong at gateway reach. Hermes Agent is strong at persistent learning loops. Evolve Agent focuses on the control layer that a learning agent needs before self-improvement can be trusted: **verifiable execution plus measured, signed, reversible adaptation**.

## v0.3 — Evaluation-Driven Evolution

v0.1 established evidence, exact capabilities, and a governed Skill lifecycle. v0.2 moved process execution behind a Docker-first, deny-by-default boundary. **v0.3 replaces manually entered evaluation scores with a real baseline-versus-candidate evaluation pipeline.**

A Skill cannot be promoted because it looks plausible, because it worked once, or because the same Episodes that created it also approve it. It must pass independent replay fixtures, survive non-intervening shadow canaries, and remain inside a signed production envelope after promotion.

### What v0.3 adds

- content-addressed replay fixtures captured from clean committed Episodes
- strict train/evaluation leakage exclusion
- paired baseline-versus-candidate replay under the same task, tools, observations, budgets, and verifier
- exact model-proposal trace matching plus executed-argument evidence provenance
- success, verifier quality, token, tool-call, latency, trace, and safety metrics
- deterministic paired bootstrap confidence intervals
- configurable non-regression and improvement gates
- Ed25519-signed offline, canary, and production-monitor reports
- promotion enforcement inside `SkillStore`, not only in the CLI facade
- shadow canaries that never replace the production answer
- production monitoring against the signed canary envelope
- automatic rollback when promoted-Skill quality or cost crosses configured limits
- frozen training provenance once evaluation begins, preserving later Episodes as holdout material
- `quarantined` state for candidates that fail offline or canary gates
- 38 invariant, security, evaluation, and end-to-end tests

## Evolution path

```text
Committed Episodes
        |
        v
Repeated successful trace
        |
        v
Candidate Skill
        |
        +---- training Episode IDs and evidence are frozen
        |
        v
Independent replay fixtures
        |
        v
Paired baseline vs candidate execution
        |
        v
Quality + safety + cost + confidence gates
        |
        v
Signed offline report
        |
        v
Shadow canary on real production Episodes
        |      candidate output is discarded
        |      production answer is unchanged
        v
Signed canary report
        |
        v
Explicit promotion
        |
        v
Rolling production monitor
        |
        +---- within signed envelope ----> remain promoted
        |
        +---- regression ---------------> automatic rollback
```

See [docs/EVALUATION_DRIVEN_EVOLUTION.md](docs/EVALUATION_DRIVEN_EVOLUTION.md) for the evaluation contract and [docs/HARDENED_EXECUTION.md](docs/HARDENED_EXECUTION.md) for the execution boundary.

## Core invariants

1. A candidate's supporting Episodes cannot be used as evaluation fixtures.
2. Baseline and candidate receive the same replay world and verifier contract.
3. A replay fails closed if the model changes the recorded tool sequence or proposed arguments.
4. Evidence in a fixture must resolve to the source Episode and actual executed arguments.
5. One new candidate failure blocks promotion by default.
6. Offline evaluation must show improvement without violating quality or cost budgets.
7. Canary evaluation runs in shadow and cannot change production output.
8. Offline and canary reports must be valid signatures from the same evaluation authority.
9. `SkillStore` re-verifies signed reports, Skill identity, policy hash, and key fingerprint before promotion.
10. A promoted Skill is automatically rolled back when the rolling production window breaches its signed canary envelope.
11. Learned Skills never promote themselves.
12. Docker remains the default fail-closed process boundary.

## Requirements

- Node.js 22.6 or newer
- Docker Engine or Docker Desktop for the default process executor
- an OpenAI API key with access to the configured model
- at least one reviewed Docker image available locally under an exact digest for process tools

The package has no runtime npm dependencies.

## Install

```bash
cd evolve-agent
npm install
cp .env.example .env
npm run check
```

Export the API key through the shell or a protected environment manager:

```bash
export OPENAI_API_KEY="..."
```

## Configure hardened execution

Pull an image deliberately, inspect its immutable repository digest, and allowlist that exact value:

```bash
docker pull node:22-bookworm-slim
IMAGE="$(docker image inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}')"

export EVOLVE_DOCKER_DEFAULT_IMAGE="$IMAGE"
export EVOLVE_DOCKER_ALLOWED_IMAGES="$IMAGE"
```

Evolve Agent uses `--pull never`. A missing image fails closed instead of silently changing the execution environment.

Recommended strict mode:

```bash
export EVOLVE_DOCKER_REQUIRE_ROOTLESS=true
```

Check readiness without revealing secret values:

```bash
npm run dev -- doctor
```

## Run an evidence-backed task

```bash
npm run dev -- run \
  "Read package.json and explain the scripts" \
  --workspace . \
  --tool read_file \
  --success "Every package-specific claim cites current-Episode evidence"
```

A valid evidence-backed answer cites IDs created by that exact Episode:

```text
The test script compiles the test tree and invokes Node's test runner. [evidence:ev_...]
```

## Evaluation workflow

### 1. Capture replay fixtures

Fixture capture is opt-in by default. Capture a known clean committed Episode explicitly:

```bash
npm run dev -- evaluations fixtures capture <episode-id> --split validation
```

List fixtures:

```bash
npm run dev -- evaluations fixtures list
npm run dev -- evaluations fixtures list --split validation --split holdout
```

Import a reviewed fixture JSON file:

```bash
npm run dev -- evaluations fixtures import ./fixture.json
```

A captured fixture contains:

- original `TaskSpec` and budgets
- ordered model-proposed tool trace
- proposal argument hashes
- executed-argument evidence records and artifact hashes
- recorded observations
- baseline verifier score, usage, turns, tool calls, duration, and active Skill IDs
- source Episode ID, split, integrity hash, and deterministic fixture ID

Only clean committed Episodes are accepted. Policy denial, approval denial, rejected arguments, terminal failure, incomplete traces, missing artifacts, and provenance mismatch cause fixture rejection.

### 2. Run offline baseline-versus-candidate evaluation

```bash
npm run dev -- evaluations run <skill-id> \
  --split validation \
  --split holdout \
  --repeats 2
```

Select exact fixtures when needed:

```bash
npm run dev -- evaluations run <skill-id> \
  --fixture fixture_... \
  --fixture fixture_...
```

`skills evaluate` is an alias:

```bash
npm run dev -- skills evaluate <skill-id>
```

The harness alternates execution order to reduce ordering bias. Each arm receives the same fixture, tools, budgets, evidence observations, and verifier. The candidate arm differs only by inclusion of the candidate Skill.

Default offline gates require:

- at least three unique matching fixtures
- complete baseline/candidate pairs
- zero new failures
- no success-rate regression
- no verifier-score regression beyond 0.02
- lower confidence bounds within non-regression limits
- no more than 20% token or tool-call regression
- no trace or safety regression
- measurable success, score, token, or tool-call improvement

A failed report moves the Skill to `quarantined`. A passing report moves it to `evaluated`. In both cases, the report is signed and retained.

### 3. Run shadow canaries

Shadow a production Episode whose answer was produced without the candidate Skill:

```bash
npm run dev -- evaluations shadow <skill-id> <episode-id> \
  --mode production-baseline
```

The actual production result becomes the baseline. The candidate is replayed counterfactually against the recorded fixture. Its answer is measured and discarded; it cannot alter the response already delivered to the user.

After enough independent shadow samples, finalize the canary report:

```bash
npm run dev -- evaluations canary <skill-id>
```

Canary gates require non-regression. The offline report is responsible for proving improvement.

### 4. Promote explicitly

```bash
npm run dev -- skills promote <skill-id>
```

Promotion fails unless:

- the latest attached offline report is signed, valid, passing, and of kind `offline`
- the latest attached canary report is signed, valid, passing, and of kind `canary`
- both reports identify the same Skill ID and fingerprint
- both reports were signed by the same authority key
- the authorization policy hash matches the policies inside the signed reports
- the Skill is in a passing `canary` state

The low-level `SkillStore` performs this verification again, so bypassing the CLI does not bypass the signed-report gate.

### 5. Monitor and roll back

Inspect the current production window:

```bash
npm run dev -- evaluations monitor <skill-id>
```

When monitoring is enabled, every terminal Episode that used a promoted Skill contributes a production outcome. Once the minimum sample count is reached, Evolve Agent compares the rolling window with the signed canary candidate envelope.

Default rollback thresholds permit at most:

- 0.10 success-rate drop
- 0.10 mean verifier-score drop
- 1.5× mean token use

Any failed gate creates a signed monitor report and automatically changes the Skill to `rolled_back`.

Manual rollback remains available:

```bash
npm run dev -- skills rollback <skill-id> --note "operator-observed regression"
```

## Opt-in automation

Safe defaults are conservative:

```text
EVOLVE_EVAL_CAPTURE_COMMITTED=false
EVOLVE_EVAL_SHADOW_PERCENT=0
EVOLVE_EVAL_MONITOR_PROMOTED=true
```

To capture clean committed Episodes and shadow a percentage of matching traffic:

```bash
export EVOLVE_EVAL_CAPTURE_COMMITTED=true
export EVOLVE_EVAL_SHADOW_PERCENT=10
```

The shadow percentage is deterministic per Episode and Skill. Shadow evaluation remains off the response path. Automatic **promotion is never enabled**; promotion is always explicit. Automatic rollback is enabled for promoted Skills when monitoring is on.

## Reports and provenance

```bash
npm run dev -- evaluations reports list
npm run dev -- evaluations reports show <report-id>
npm run dev -- evaluations verify <report-id>
```

Evaluation authority keys are generated under the state directory:

```text
$EVOLVE_HOME/evaluations/authority/ed25519-private.pem  mode 0600
$EVOLVE_HOME/evaluations/authority/ed25519-public.pem
```

A signed report binds:

- report kind and engine version
- Skill ID and Skill fingerprint
- fixture IDs and integrity hashes
- complete baseline and candidate runs
- aggregate metrics and paired comparison
- evaluation policy and gate results
- provider identity and notes
- payload hash, Ed25519 signature, and key fingerprint

The local key proves that the report came from the local evaluation authority and was not modified afterward. It is not hardware attestation and does not prove that the host itself was uncompromised.

## Evaluation configuration

Key settings are shown below; see `.env.example` for the complete list.

```text
EVOLVE_EVAL_MIN_FIXTURES=3
EVOLVE_EVAL_REPEATS=1
EVOLVE_EVAL_MAX_NEW_FAILURES=0
EVOLVE_EVAL_MAX_SUCCESS_REGRESSION=0
EVOLVE_EVAL_MAX_SCORE_REGRESSION=0.02
EVOLVE_EVAL_MIN_SUCCESS_IMPROVEMENT=0.05
EVOLVE_EVAL_MIN_SCORE_IMPROVEMENT=0.02
EVOLVE_EVAL_MAX_TOKEN_RATIO=1.2
EVOLVE_EVAL_MAX_TOOL_RATIO=1.2
EVOLVE_EVAL_EFFICIENCY_RATIO=0.9
EVOLVE_EVAL_CONFIDENCE=0.9
EVOLVE_EVAL_BOOTSTRAP_SAMPLES=1000
EVOLVE_EVAL_CANARY_MIN_SAMPLES=5
EVOLVE_EVAL_MONITOR_MIN_SAMPLES=10
EVOLVE_EVAL_MONITOR_WINDOW=50
EVOLVE_EVAL_MONITOR_MAX_SUCCESS_DROP=0.1
EVOLVE_EVAL_MONITOR_MAX_SCORE_DROP=0.1
EVOLVE_EVAL_MONITOR_MAX_TOKEN_RATIO=1.5
```

`EVOLVE_EVAL_MONITOR_WINDOW` must be at least both the canary and monitor minimum sample counts.

## Hardened process execution

`run_process` remains behind the v0.2 authority boundary:

- Docker default; local host execution disabled unless explicitly enabled
- exact digest image allowlist and `--pull never`
- network `none` by default
- read-only root and workspace by default
- numeric non-root user
- all Linux capabilities dropped
- `no-new-privileges`
- memory, swap, CPU, PID, tmpfs, file-descriptor, timeout, and output limits
- short-lived file secrets with output redaction
- execution receipt with command and policy hashes
- Episode lease, heartbeat, duplicate-run prevention, and stale recovery

See [docs/HARDENED_EXECUTION.md](docs/HARDENED_EXECUTION.md).

## State layout

State must remain outside the mounted task workspace:

```text
$EVOLVE_HOME/
  capability.key
  episodes.jsonl
  checkpoints/
  artifacts/
  evidence/
  memory.json
  patterns.json
  skills.json
  leases/
  runtime/secrets/
  evaluations/
    fixtures/
    reports/
    shadow.json
    authority/
      ed25519-private.pem
      ed25519-public.pem
```

When `EVOLVE_HOME` is omitted, a per-workspace directory is derived under `$XDG_STATE_HOME/evolve-agent/` or `~/.local/state/evolve-agent/`.

## Built-in tools

| Tool | Risk | Main controls |
|---|---:|---|
| `list_files` | read | workspace boundary, recursion and entry caps |
| `read_file` | read | regular-file check, byte cap, SHA-256 output |
| `search_text` | read | literal search, file/result/size caps |
| `write_file` | write | approval, exact capability, create-only and SHA compare-and-swap |
| `replace_text` | write | approval, exact occurrence count and SHA compare-and-swap |
| `run_process` | execute | approval, exact capability, executor policy, isolation receipt and evidence limits |

## Validation

```bash
npm run check
```

The v0.3 suite contains **38 tests** covering:

- exact capability binding and post-approval argument mutation
- evidence contract and fabricated evidence rejection
- ledger tamper detection
- workspace traversal and symlink rejection
- Docker digest, network, privilege, resource, timeout, and output policy
- secret file permissions, cleanup, and output redaction
- Episode concurrency and stale-lock recovery
- replay fixture capture and tamper detection
- supporting-Episode leakage exclusion
- paired baseline/candidate trace replay
- trace mismatch fail-closed behavior
- evaluation metrics, bootstrap gates, and new-failure rejection
- Ed25519 report signing and tamper rejection
- promotion-store authority enforcement
- shadow canary non-intervention
- production regression automatic rollback
- runtime active-Skill attribution and optional fixture capture
- frozen Skill training provenance

## Honest status

This is a serious **v0.3 kernel**, not a claim that it already exceeds OpenClaw or Hermes Agent in integrations, users, community, reliability history, or production maturity.

The implementation has been validated with deterministic providers and fake Docker runners. The current build environment did not make a live GPT-5.6 Sol request and did not run the Evolve Docker executor against a live Docker daemon. Real-model variance, real rootless-Docker behavior, long-duration traffic, evaluator drift, and adversarial fixture quality still require qualification.

v0.3 also does not provide:

- hardware-attested evaluation or execution receipts
- a remote quorum for reports or the Episode ledger
- domain-level egress enforcement inside the runtime
- automatic Skill promotion
- causal proof that a Skill alone produced an observed improvement
- large-sample sequential testing or multiple-hypothesis correction
- distributed multi-agent lease coordination

## Repository layout

```text
src/runtime       bounded loop, checkpoints, leases, evolution hooks
src/ledger        hash-chained events and content-addressed evidence
src/policy        risk decisions, approval, exact capabilities
src/execution     Docker/local executor adapters and receipts
src/secrets       short-lived file secret broker
src/tools         workspace and process tools
src/providers     GPT-5.6 Sol Responses API and deterministic mocks
src/verification  deterministic and model-based final verification
src/memory        evidence-aware durable memory
src/learning      repeated-Episode pattern detection
src/skills        candidate/quarantine/evaluation/canary/promotion/rollback state
src/evaluation    fixtures, replay, metrics, signing, shadow, monitor, orchestration
src/context       controlled prompt assembly
```

## Next milestones

The next defensible work is **v0.3.1 Real Evaluation Qualification**, followed by **v0.4 Distributed Evidence Control Plane**:

1. live GPT-5.6 Sol repeated-run variance matrix
2. rootless Docker and Docker Desktop integration tests
3. adversarial and mutation-generated replay fixtures
4. sequential tests, evaluator calibration, and multiple-comparison control
5. signed image and executor-policy provenance
6. remote or hardware-backed evaluation signing
7. lease-based multi-agent work graph
8. ACP/EDL Episode binding and quorum evidence receipts

## License

MIT
