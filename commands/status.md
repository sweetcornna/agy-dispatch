---
description: List agy sessions, or show one session's state and recent events
argument-hint: '[session-id] [--all]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" status $ARGUMENTS`

Without a session id, show the table above compactly. With one, show the details as they are, then point out anything that needs action: a pending approval, a question, a stall, or a dead session.
