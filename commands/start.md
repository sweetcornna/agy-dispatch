---
description: Start an agy session in the background and follow it live (progress, questions, approvals)
argument-hint: '[--host <name>] [--write] [--model <id>] [--cwd <dir>] <task>'
allowed-tools: Bash(node:*), Monitor
---

Start a supervised agy session for this task and follow it live.

Raw request: $ARGUMENTS

1. Split routing flags (`--host`, `--write`, `--yolo`, `--approve`, `--model`, `--mode`, `--cwd`, `--idle-timeout`, `--tool-timeout`) from the task text, then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" start [flags] - <<'AGY_TASK'
<task text, with enough context for agy to work alone>
AGY_TASK
```

   Stay read-only unless the request includes `--write` or clearly asks for changes.
2. Take the id from `started <id> ...`. Start a Monitor on `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" watch <id>` (description: `agy <id> progress`). If Monitor isn't available, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" wait <id>` with Bash `run_in_background: true`.
3. Tell the user the session id and host in one line, then carry on. Handle events as the `agy` skill describes: relay questions, approvals and stalls; read `result <id>` when a turn finishes; talk to agy with `send`.
