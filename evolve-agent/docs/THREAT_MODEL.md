# Threat Model

## Protected assets

- workspace files and side effects
- host credentials and brokered secrets
- tool and executor authority
- Episode integrity and evidence provenance
- memory integrity
- Skill training provenance and activation state
- replay fixture integrity
- evaluation signing key
- offline, canary, and monitor reports
- human approval intent

## Principal threats and controls

| Threat | Primary control | Residual risk |
|---|---|---|
| Prompt injection requests a dangerous tool | model has no direct authority; policy, approval, capability, executor | operator may approve malicious intent |
| Arguments change after approval | HMAC binds exact normalized arguments | compromised host can replace authority code |
| Workspace path escape | canonical containment and symlink rejection | approved process may damage read-write workspace |
| Arbitrary image or implicit update | exact digest allowlist and `--pull never` | allowlisted image may itself be malicious |
| Broad network access | `network=none`; unsafe built-ins rejected | operator-managed custom network may be permissive |
| Container privilege escalation | non-root, read-only root, cap-drop ALL, no-new-privileges, seccomp | kernel or Docker vulnerability remains |
| Secret in command line or environment | short-lived read-only files and `_FILE` pointers | approved process can read the secret by design |
| Secret in evidence output | exact-value redaction before artifact storage | transformed or fragmented secret may evade detection |
| Fork bomb or output flood | cgroup/PID limits, timeout, output cap, process-group kill | host daemon pressure remains possible |
| Fabricated evidence | current-Episode evidence set and content-addressed artifacts | compromised host can rewrite state and authority together |
| Ledger editing | predecessor and event hashes | no remote witness or quorum yet |
| Duplicate Episode execution | exclusive lease and heartbeat | distributed filesystem semantics may differ |
| Unsafe stale-lock steal | TTL plus same-host live-PID check | PID reuse can delay recovery |
| Poisoned memory | evidence requirement and provenance | valid evidence can support a wrong inference |
| Training/evaluation leakage | supporting Episode exclusion and provenance freeze | semantically duplicated tasks may still leak |
| Fixture tampering | content hash, deterministic ID, structural and evidence validation | malicious but internally consistent fixture remains possible |
| Candidate changes replay side effects | recorded observations; no tool re-execution | replay does not test live integration behavior |
| Candidate wins by changing trace | exact proposal tool/argument hash matching | semantically equivalent alternative trace is scored as mismatch |
| Candidate invents evidence | evidence availability and citation contract | verifier can still misjudge answer quality |
| Weak average hides new failure | paired new-failure gate | small fixture set may miss rare failures |
| Report modified after evaluation | Ed25519 signature and payload hash | local signing key compromise defeats integrity |
| Fake report IDs passed directly to SkillStore | store-level signed-report verifier | malicious code with signing-key access can forge authority |
| Candidate output affects users during canary | shadow output discarded | counterfactual replay consumes model cost and may leak to provider logs according to provider policy |
| Promoted Skill regresses | rolling monitor and automatic rollback | correlation does not prove causation; detection waits for minimum samples |
| Evaluator drift | same verifier within paired report | drift across report generations remains |
| Automatic unsafe promotion | no automatic promotion path | operator can explicitly promote a poor but passing Skill |

## Out of scope for v0.3

- protection from a hostile host administrator or Docker daemon operator
- formal verification of model, verifier, Docker, or kernel behavior
- hardware-backed signing or remote attestation
- remote consensus for evaluation reports or ledger heads
- domain-aware egress filtering implemented inside the runtime
- proof that fixture distribution matches future production traffic
- causal attribution of outcome changes to one Skill
- complete statistical treatment of repeated, adaptive, or multiple experiments
- automatic Skill promotion
- distributed multi-agent lease consensus
