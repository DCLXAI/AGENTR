# Architecture

Evolve Agent separates five loops that agent frameworks often blur together.

```text
1. Decision loop
   TaskSpec -> Context Compiler -> GPT-5.6 Sol -> tool/final proposal

2. Authority loop
   schema -> task boundary -> policy -> human approval -> exact capability

3. Execution loop
   ExecutorRegistry -> Docker policy -> isolated process -> execution receipt

4. Evidence loop
   artifact -> hash-chained ledger -> deterministic checks -> independent verifier

5. Learning loop
   committed Episodes -> repeated pattern -> candidate Skill -> evaluation -> canary -> promotion/rollback
```

## End-to-end flow

```text
Ingress / TaskSpec
        |
        v
Episode lease -----------------------> duplicate or live-stale reject
        |
        v
Context Compiler <---- promoted Skills + evidence-backed memory
        |
        v
GPT-5.6 Sol decision
        |
        +---- final answer ---> evidence checks ---> independent verifier
        |                                             |
        |                                             +--> commit / retry
        v
tool proposal
        |
        v
schema + requested-tool boundary + risk policy
        |
        v
human approval of exact arguments
        |
        v
expiring HMAC capability
        |
        v
ToolRegistry revalidates schema + capability
        |
        v
ExecutorRegistry
        |
        +---- DockerExecutor
        |       image policy
        |       network policy
        |       resource policy
        |       secret broker
        |       process runner
        |
        +---- LocalExecutor (disabled by default, no isolation claim)
        |
        v
execution receipt + content-addressed artifact
        |
        v
hash-chained ledger + checkpoint
        |
        v
next turn / budget stop / final verification
        |
        v
committed Episode -> governed learning loop
```

## State separation

The mounted workspace is treated as potentially adversarial. Agent authority state therefore lives outside it:

```text
state home
  capability.key
  episodes.jsonl
  checkpoints/
  artifacts/
  evidence/
  memory.json
  patterns.json
  skills.json
  leases/
  runtime/secrets/   short-lived only
```

A configuration placing the state home inside the workspace is rejected.

## Core invariants

1. No protected tool executes without an unexpired capability bound to exact normalized arguments.
2. No task can invoke a tool outside its initial requested-tool boundary.
3. No factual claim can cite evidence absent from the current Episode.
4. Every execution result becomes a content-addressed artifact before the next model turn.
5. Every ledger event commits to the predecessor hash.
6. Docker images are immutable digest references from an exact allowlist.
7. Docker execution is network-denied and read-only unless the approved request explicitly changes those fields.
8. Secret values do not enter the Docker command line or evidence payload.
9. One Episode has at most one active lease under the host lease model.
10. High-confidence memory requires evidence.
11. A Skill cannot become promoted without policy, replay support, canary, score, and explicit promotion.
12. Every model loop is bounded by turns, tools, tokens, wall time, process time, and process output.

## Trust boundaries

The model is not trusted with policy, capability signing, evidence identity, lease ownership, secret materialization, or executor construction.

The local host process is trusted. The Docker daemon, host kernel or Docker Desktop VM, approved image, and operator-managed network are part of the execution trusted computing base.
