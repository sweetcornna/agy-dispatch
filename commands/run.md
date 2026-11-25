---
description: Ask agy (Antigravity CLI) to do a bounded task and return its answer — here or on another host
argument-hint: '[--host <name>] [--write] [--model <id>] [--cwd <dir>] <task>'
allowed-tools: Bash(node:*)
---

Hand this task to agy as a one-shot run and show agy's answer.

Raw request: $ARGUMENTS

- Split routing flags (`--host`, `--write`, `--yolo`, `--model`, `--mode`, `--cwd`, `--keep`, `--timeout`) from the task text. Pass the task on stdin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" run [flags] - <<'AGY_TASK'
<task text>
AGY_TASK
```

- Stay read-only unless the request includes `--write` or clearly asks agy to change files. Add enough context (paths, constraints) for agy to work alone.
- Show agy's reply as-is, then add one line only if you see a problem with it.
- Exit 124: agy is still working. Say so, give the session id, and follow it as in the `agy` skill (Monitor on `watch`, or a background `wait`).
- Exit 3: agy needs approval. Show the request and ask the user, or answer it per the `agy` skill.
- Exit 2 with "not signed in": show the sign-in command to the user.
- No task given: ask what agy should do.
