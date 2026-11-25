---
description: Cancel the running turn of an agy session (the session stays open)
argument-hint: '<session-id>'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" cancel $ARGUMENTS`

Report the outcome in one line.
