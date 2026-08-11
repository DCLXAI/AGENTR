# Security

## Defaults

- File tools are confined to one configured workspace and reject path traversal and symlink traversal.
- Process execution uses `spawn` without a shell and only permits allowlisted executables.
- Process children receive a minimal inherited environment that excludes API keys and most host environment variables.
- File mutation and process execution require an exact human-approved capability token by default.
- Capability tokens bind the episode, tool, normalized arguments, expiry, and HMAC signature.
- Model output cannot directly execute a tool. Calls pass schema validation, policy, approval, capability verification, execution, and evidence capture.
- Learned skills never auto-promote. Promotion requires policy evaluation, repeated supporting episodes, canary success, and a score threshold.

## Important limitation

The built-in local process backend is not an operating-system security boundary. An approved executable may access resources available to the current user. Run untrusted tasks in a container, microVM, or restricted remote executor. A hardened executor adapter is planned for v0.2.

## Reporting

Do not open a public issue for a vulnerability that could expose credentials or enable unauthorized execution. Use GitHub private vulnerability reporting when enabled.
