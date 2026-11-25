---
description: List, add or check the machines agy can run on (doctor checks reachability, version, sign-in)
argument-hint: '[doctor | add <name> --ssh <alias> [--cwd DIR] | rm <name>]'
allowed-tools: Bash(node:*)
---

Raw request: $ARGUMENTS

- Empty request: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" hosts` and then `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" doctor`, and show both.
- `doctor [--host NAME]`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" doctor ...`.
- `add ...` / `rm ...`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" hosts add ...` / `hosts rm ...`, then `doctor --host <name>` for the new host.

When a host is not signed in, show the user the exact command from the output (for example `! ssh -t <alias> agy`). They have to sign in themselves; you can't.
