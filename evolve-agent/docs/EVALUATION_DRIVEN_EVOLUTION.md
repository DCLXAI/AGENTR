# Evaluation-Driven Evolution

## Purpose

The v0.3 evaluation system answers a narrow question:

> Does activating this exact Skill improve outcomes on independent tasks without introducing safety, quality, or cost regressions?

It does not treat model confidence, one successful Episode, or human-entered scores as sufficient evidence.

## Data lifecycle

### Training provenance

The repeated-pattern learner records the Episodes and evidence that created a candidate. These IDs form the candidate's training provenance. The first attached offline report freezes that set.

### Replay fixtures

A fixture is an immutable snapshot of a clean committed Episode. The fixture ID is derived from the SHA-256 hash of its normalized payload.

Default split assignment is deterministic from the source Episode ID:

- buckets 0–5: `train`
- buckets 6–7: `validation`
- buckets 8–9: `holdout`

Operators may choose a split explicitly during reviewed capture. Offline evaluation defaults to validation and holdout fixtures and always excludes supporting Episode IDs regardless of split labels.

### Why traces are replayed instead of tools re-executed

The harness reuses recorded tool observations and evidence rather than re-running external side effects. This gives both arms the same world and avoids duplicating writes, payments, messages, deployments, or unstable network reads.

The model must still propose the recorded tool sequence and raw proposal arguments. A mismatch fails closed. When a step matches, the harness reveals the recorded observation. This tests whether the Skill improves planning and answer construction under a fixed environment.

This is not a substitute for separate live integration tests. It intentionally measures policy behavior under controlled replay.

## Paired experiment

For each fixture and repeat:

```text
baseline arm  = currently promoted matching Skills, candidate excluded
candidate arm = same baseline Skills plus candidate
```

Execution order alternates by fixture and repeat. Pair keys are `fixture_id:repeat`.

Both arms use the same provider and verifier. For stochastic model behavior, increase `EVOLVE_EVAL_REPEATS`; one repeat is the safe low-cost default, not a claim of statistical sufficiency.

## Metrics

Each run records:

- committed success
- final verifier score
- input, output, and total tokens
- turns and tool calls
- duration
- exact trace match
- safety violations
- active Skill IDs
- failure reason

Aggregate comparison includes:

- success-rate delta
- verifier-score delta
- token, tool-call, and duration ratios
- wins, losses, and ties
- candidate failures where baseline succeeded
- deterministic paired bootstrap intervals

The bootstrap seed is derived from the paired data and policy, making reports reproducible for identical inputs.

## Default offline gates

| Gate | Default |
|---|---:|
| unique fixtures | at least 3 |
| repeats | 1 |
| new candidate failures | 0 |
| success regression | 0 |
| score regression | at most 0.02 |
| token ratio | at most 1.20 |
| tool-call ratio | at most 1.20 |
| confidence | 0.90 |
| improvement | success +0.05, score +0.02, or efficiency ratio ≤0.90 |

The candidate must pass all non-regression gates and at least one improvement route.

## Shadow canary

A shadow observation combines:

- the actual production result for an Episode
- one counterfactual replay of the opposite arm

For `production-baseline`, production did not use the candidate and the candidate is replayed. For `production-candidate`, production used the candidate and the baseline is replayed.

Pre-promotion canaries use `production-baseline`. Candidate output is never delivered to the user. Observations are deduplicated by Skill, Episode, and mode.

After the configured minimum sample count, a canary report uses non-regression gates. It does not need to re-prove improvement because the signed offline report already carries that burden.

## Signed promotion authorization

The local Ed25519 authority signs every report. Promotion authorization includes:

- offline report ID
- canary report ID
- combined policy hash
- authority key fingerprint

Before changing state to `promoted`, `SkillStore` asks the report store to verify:

1. both signatures
2. report IDs and payload hashes
3. report kinds
4. passing decisions
5. Skill ID and fingerprint
6. authority fingerprint
7. combined policy hash

This prevents a caller from bypassing the evaluation engine by invoking the store directly with invented report IDs.

## Production rollback

A promoted Skill's terminal outcomes are stored in a bounded rolling window. The monitor compares observed success, verifier score, and token use with the candidate aggregate in the signed canary report.

A failed gate produces a signed monitor report and immediately records an automatic rollback. The rollback is conservative: it can react to correlated system changes that are not caused solely by the Skill. This is intentional because revocation is safer than preserving suspect authority.

## Known statistical limitations

v0.3 uses deterministic paired bootstrap intervals, but it does not yet implement:

- sequential probability ratio tests
- multiple-hypothesis correction across many Skills
- hierarchical modeling across task families
- evaluator calibration drift correction
- minimum detectable effect planning
- treatment of non-independent repeated Episodes
- causal isolation from model, prompt, tool, or traffic changes

Use larger, adversarial, and independently reviewed fixture sets for consequential promotion decisions.

## Operational checklist

Before promotion:

1. verify the candidate training provenance
2. review fixture sources and split assignment
3. run multiple repeats for stochastic models
4. inspect run-level failures, not just averages
5. verify the offline report signature
6. collect independent production-baseline shadow samples
7. verify the canary report signature
8. confirm policy thresholds match the risk level
9. promote explicitly
10. watch the production monitor and retain a manual kill path
