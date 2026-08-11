# Architecture

Evolve Agent deliberately separates four loops that many agent frameworks blur together.

```text
Ingress / TaskSpec
        |
        v
Risk Gate ----------------------------> reject
        |
        v
Context Compiler <---- promoted skills + evidence-backed memory
        |
        v
GPT-5.6 Sol decision turn
        |
        +---- final answer ---> deterministic checks ---> independent verifier
        |                                                |
        |                                                +--> commit / retry
        v
tool proposal
        |
        v
policy -> human approval -> exact capability token -> schema validation
        |
        v
workspace tool / executor -> content-addressed artifact
        |
        v
hash-chained episode ledger -> checkpoint -> next turn

Committed episodes
        |
        v
pattern detector -> skill candidate -> static policy -> replay support -> canary
        |
        v
explicit promotion / rollback
```

## Why this is different

Gateway-first systems optimize reach. Learning-loop systems optimize accumulated procedures. Evolve Agent adds a third axis: **verifiable adaptation**. An answer, memory, or learned skill is not trusted merely because a model produced it. It carries episode and artifact provenance, passes explicit gates, and remains reversible.

## Invariants

1. No tool executes without an unexpired capability bound to exact normalized arguments.
2. No final answer may cite evidence that was not produced in the current episode.
3. The episode ledger is append-only and hash chained.
4. High-confidence memory requires evidence provenance.
5. A skill cannot move from candidate to promoted without policy, replay support, canary, and score gates.
6. Every loop is bounded by turns, tool calls, tokens, and wall time.
7. Workspace tools reject path and symlink escapes.
8. Process execution never uses a shell and never receives the OpenAI API key.
