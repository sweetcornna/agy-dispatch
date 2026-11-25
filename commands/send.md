---
description: Send a message to a running or parked agy session (steers the current turn, or resumes the session)
argument-hint: '<session-id> [--interrupt] <message>'
allowed-tools: Bash(node:*), Monitor
---

Send this message to the agy session.

Raw request: $ARGUMENTS

The first word is the session id; `--interrupt` (if present) cancels the running turn first; the rest is the message. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" send <id> [--interrupt] - <<'AGY_MSG'
<message>
AGY_MSG
```

Report the one-line outcome. If the session was resumed, or no watch is running for it, start a Monitor on `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" watch <id>` (or a background `wait`) so the reply reaches you.
No id given: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" status` and ask which session.
