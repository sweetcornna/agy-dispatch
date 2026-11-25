---
description: Show agy's reply for the latest (or a given) turn of a session
argument-hint: '<session-id> [--turn N]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" result $ARGUMENTS`

Show agy's reply as-is. If it is marked partial, say the turn is still running.
