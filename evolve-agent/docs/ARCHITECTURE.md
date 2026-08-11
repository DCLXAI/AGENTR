# Architecture

Evolve Agent separates five loops that are often collapsed into one opaque agent process.

## 1. Task loop

```text
TaskSpec
  -> Context Compiler
  -> GPT-5.6 Sol decision
  -> tool proposal or final proposal
  -> evidence-aware verification
  -> commit, retry, interruption, or budget stop
```

The loop is bounded by turns, tool calls, input tokens, output tokens, and wall time. Checkpoints preserve all consumed budget across resume.

## 2. Authority and execution loop

```text
model proposal
  -> schema validation
  -> task tool boundary
  -> risk policy
  -> human approval for protected actions
  -> exact HMAC capability
  -> Executor Registry
  -> Docker sandbox by default
  -> execution receipt
  -> content-addressed evidence
  -> hash-chained ledger
```

The model never receives direct execution authority. The local executor is disabled unless the operator explicitly enables an unsafe escape hatch.

## 3. Learning loop

```text
committed Episodes
  -> repeated successful tool trace
  -> candidate Skill
  -> frozen supporting Episode/evidence provenance
```

A candidate remains inactive. Once its first offline report is attached, its training provenance no longer expands. Later matching Episodes can therefore become evaluation or canary data rather than silently contaminating the training set.

## 4. Evaluation loop

```text
clean committed Episode
  -> content-addressed replay fixture

candidate Skill + independent fixtures
  -> baseline replay without candidate
  -> candidate replay with candidate
  -> paired metrics and bootstrap interval
  -> policy gates
  -> Ed25519-signed offline report

production baseline Episodes
  -> candidate counterfactual replay in shadow
  -> paired non-regression gates
  -> signed canary report

signed offline + signed canary
  -> SkillStore re-verification
  -> explicit promotion
```

### Replay-world contract

Baseline and candidate receive the same:

- `TaskSpec`
- requested tool descriptions
- budgets
- ordered recorded observations
- evidence IDs and artifact provenance
- verifier provider

They differ only in the active Skill set. A model-proposed tool name or proposal-argument hash that differs from the fixture causes a trace-mismatch failure. The original normalized executed-argument hash remains in the evidence record and is checked during fixture capture.

### Report contract

A signed report includes the complete run-level data rather than only aggregate scores. It binds Skill identity, fixture hashes, policy, results, decision gates, engine version, provider identity, payload hash, signature, and public-key fingerprint.

## 5. Production control loop

```text
promoted Skill used by Episode
  -> terminal production outcome
  -> rolling window
  -> compare with signed canary candidate envelope
  -> signed monitor report
  -> remain promoted or automatic rollback
```

The monitor is deliberately asymmetric: it may revoke authority automatically, but it never promotes authority automatically.

## State boundaries

```text
Task workspace
  mounted into executor
  may be read-only or explicitly read-write

Authority state
  capability key
  ledger and evidence
  checkpoints and memory
  Skills and training provenance
  evaluation fixtures and reports
  Ed25519 evaluation key
  leases and secret materialization
  never mounted as the task workspace
```

## Main invariants

1. No protected tool executes without exact approval and a valid capability.
2. No final factual claim may cite evidence absent from the current Episode.
3. No clean fixture exists without source checkpoint, ledger, and artifact agreement.
4. No candidate is evaluated on its supporting Episodes.
5. No offline comparison is accepted without complete paired runs.
6. No promotion succeeds without two verified passing reports from one authority.
7. No shadow candidate output reaches the production response path.
8. No production regression keeps authority merely because the Skill was previously promoted.
9. No process execution silently falls back from Docker to the host.
10. No concurrent process owns the same Episode lease.
