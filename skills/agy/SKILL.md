---
name: agy
description: Delegate work to agy (Google Antigravity CLI, Gemini models) and supervise it like a subagent — on this machine or on another machine over SSH (e.g. the Windows box). Use when the user asks to hand something to agy / Antigravity / Gemini, run agy on another machine, get a second opinion from agy, or check on, talk to, approve, cancel or stop an agy session. 中文触发：让 agy 做、交给 agy、用 agy、在 Windows 上跑 agy、agy 进度、跟 agy 说、停掉 agy。
---

# Driving agy sessions

Everything goes through one script (Node, no dependencies):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" <command> ...
```

Each session is a long-lived agy conversation owned by a background broker. The broker streams progress, passes your messages in, and stops agy from hanging. Nothing runs while a session sits idle: after 20 minutes it parks, and `send` resumes it with its memory.

## Pick the shape

- **Quick, bounded question or review (a few minutes or less):** `run`. It blocks, prints agy's reply and stops the session.
- **Anything longer, or work you want to watch and steer:** `start`, then follow it with Monitor (below) and talk to it with `send`.

Pass task text on stdin with a quoted heredoc, so quotes, `$`, backticks, newlines and Chinese reach agy unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" start --host local --write - <<'AGY_TASK'
<task text, with enough context for agy to work alone: paths, constraints, the definition of done>
AGY_TASK
```

The first output line is `started <id> on <host> ...`. Keep the id.

## Access

- Read-only is the default: agy runs in plan mode, approval requests are denied, and any workspace edit cancels the turn. Use it for questions, reviews and research.
- `--write` lets agy edit files and run commands (mode `auto`). Approval requests come to you (`--approve ask`). Add `--write` only when the user wants agy to change something.
- `--yolo` skips agy's approvals entirely. Use it only when the user asks for it.
- `--model <id>` picks a model (`models --host <h>` lists them). Leave it unset unless the user names one.

## Watch it live (the subagent loop)

1. Start a **Monitor** on `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" watch <id>` with a description such as `agy <id> progress`. Each line is one event: `turn N started`, `agy: <text>`, `<tool>: <what>`, `steps 2/5 · now: ...`, `QUESTION`, `APPROVAL #n`, `STALL`, `turn N finished`, `parked`/`stopped`/`DEAD`. The watch ends by itself when the session stops or parks.
   - If Monitor is not available, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" wait <id>` with Bash `run_in_background: true`. You get one notification when the turn ends or agy needs approval. Re-arm it after each `send`.
2. While it runs, keep doing other work. Relay only what matters to the user: questions, approvals, stalls, failures and the final result. Don't echo every tool line.
3. On `turn N finished`, read the full reply with `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy.mjs" result <id>` before you summarise or act on it. Check agy's claims (diffs, test output) like any subagent's work.

## Talk to it

- `send <id> -- "<message>"`: while a turn is running, the message joins that turn and agy picks it up at its next step. Use this to steer, add context or correct course. When idle, it starts a new turn. On a parked or stopped session, it resumes the conversation first.
- `send <id> --interrupt -- "<message>"`: cancel the current turn first, then send.
- **QUESTION** (agy asked something and ended its turn): answer with `send`. Ask the user if it's their call.
- **APPROVAL #n**: `answer <id> <n> allow|always|deny`. Decide as the user would: allow routine actions inside the task's scope; ask the user about anything destructive, outside the workspace, or outward-facing (push, publish, delete). Unanswered approvals are denied after `--ask-timeout` (15m).
- `cancel <id>` stops the current turn and keeps the session. `stop <id>` ends it, and `send` can still resume it later. Stop sessions you're finished with.

## Anti-hang guarantees (what the broker does by itself)

- No output for `--idle-timeout` (10m) while the model works, or `--tool-timeout` (30m) while one tool runs, triggers a **STALL**. The broker cancels the turn; if agy ignores the cancel for 45s, it kills agy, restarts it and reloads the conversation (`recovered`). Send "continue" if the work should go on.
- `--turn-timeout` (3h) caps a single turn.
- If agy crashes or the SSH link drops, the broker restarts it up to 2 times and reloads the conversation. After that the session is **DEAD**, and `send` still tries to resume it.
- A host that isn't signed in fails in seconds with a sign-in hint instead of waiting on an OAuth prompt.
- `wait` and `run` give up after `--timeout` (9m) with exit 124 and leave the session running. Never block a foreground Bash call longer than that.

## Hosts

- `hosts` lists hosts. `hosts add <name> --ssh <alias> [--cwd DIR]` registers one (OS and agy path are detected). `doctor` checks every host: reachability, agy version, sign-in.
- On a remote host, agy works on **that machine's files**. Give `--cwd` as a path on that host (`~` works); otherwise the host's configured cwd, or its home, is used. Local paths mean nothing there; move code with git first if needed.
- Not signed in on a host: tell the user to run the hinted command themselves, for example `! ssh -t <alias> agy`, and sign in once.

## Other commands

`status [id]` (sessions table, or one session's details and recent events) · `log <id> [--tail N]` · `result <id> [--turn N]` · `prune [--older 7d]` · `help`.
Exit codes: 0 ok · 1 turn ended badly · 2 could not start or resume · 3 waiting for approval · 64 usage error · 124 still running.
