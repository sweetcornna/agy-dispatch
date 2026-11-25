---
name: agy
description: Delegate work to agy (Google Antigravity CLI, Gemini models) and supervise it like a subagent, on this machine or over SSH on another machine (for example the lab Cage).
whenToUse: When the user asks to hand something to agy / Antigravity / Gemini, run agy on another machine, get a second opinion from agy, or check on, talk to, approve, cancel or stop an agy session. 中文：让 agy 做、交给 agy、用 agy、在实验室 cage 上跑 agy、agy 进度、跟 agy 说、停掉 agy。
---

# Driving agy sessions from dsh

Everything goes through one Node script, written below as `{{AGY}}`. Copy that command exactly. Set the `workdir` of the bash call to the directory where agy should work, because a local session's working directory defaults to the shell's cwd.

The script starts background broker processes, writes to `~/.agy-dispatch`, and needs network and SSH. If the sandbox denies a call, retry it once with wider `sandbox_permissions` and a short justification, or run dsh with `--permission-mode danger-full-access`.

Each session is a long-lived agy conversation owned by a background broker. The broker streams progress, passes your messages in, and stops agy from hanging. Nothing runs while a session sits idle: after 20 minutes it parks, and `send` resumes it with its memory.

## Pick the shape

- **Quick, bounded question or review (a few minutes or less):** `run`. It blocks, prints agy's reply and stops the session.
- **Anything longer, or work you want to watch and steer:** `start`, then follow it (below) and talk to it with `send`.

Pass the task on stdin with a quoted heredoc, so quotes, `$`, backticks, newlines and Chinese arrive unchanged:

```bash
{{AGY}} start --host local --write - <<'AGY_TASK'
<task text with enough context for agy to work alone: paths, constraints, the definition of done>
AGY_TASK
```

The first output line is `started <id> on <host> ...`. Keep the id.

## Access

- **Read-only is the default, and it is enforced.** agy must ask before any edit or command. The broker denies edits and allows only plain read commands (`ls`, `cat`, `rg`/`grep`, `git status/diff/log/show`, …, one per call, with no `&&`, `|`, `;` or redirection). Use it for questions, reviews and research.
- `--write` lets agy edit and run commands. Its approval requests come back to you (`--approve ask`). Add it only when the user wants agy to change something.
- `--yolo` skips agy's approvals entirely. Use it only when the user asks for it.
- `--model <id>` picks the model (`models --host <h>` lists them). Leave it unset unless the user names one.

## Follow it live

- **Streaming:** run `{{AGY}} watch <id>` with `run_in_background: true` and read new lines with `job_output` while you do other work. Each line is one event: `turn N started`, `agy: <text>`, `<tool>: <what>`, `steps 2/5 · now: ...`, `QUESTION`, `APPROVAL #n`, `STALL`, `turn N finished`, `parked`/`stopped`/`DEAD`. The job ends by itself when the session stops or parks. `--until turn` makes it end at the end of the current turn, or when agy needs approval, and dsh then sends you a completion notice.
- **Simpler:** run `{{AGY}} wait <id>` with `run_in_background: true`. dsh notifies you when it finishes, which is when the turn ends or agy needs approval (at most 9 minutes; exit 124 means it is still running, so start it again). Then it prints the reply.
- On `turn N finished`, read the full reply with `{{AGY}} result <id>`. Check agy's claims (diffs, test output) as you would any subagent's work.
- Relay only what matters to the user: questions, approvals, stalls, failures and the final result.

## Talk to it

- `send <id> -- "<message>"`: during a turn, the message joins it and agy picks it up at its next step. Use this to steer or correct it. When idle, it starts a new turn. On a parked or stopped session, it resumes the conversation first.
- `send <id> --interrupt -- "<message>"`: cancel the current turn first, then send.
- **QUESTION** (agy asked something and ended its turn): answer with `send`. Ask the user if it's their call.
- **APPROVAL #n**: `answer <id> <n> allow|always|deny`. Allow routine actions inside the task's scope. Ask the user about anything destructive, outside the workspace, or outward-facing. Unanswered approvals are denied after 15 minutes.
- `cancel <id>` stops the turn and keeps the session. `stop <id>` ends it, and `send` can still resume it later. Stop sessions when you're done.

## What the broker does by itself

- **Stalls:** no output for 10 minutes while the model works, or 30 minutes while one tool runs, triggers a **STALL**. The broker cancels the turn; if agy ignores the cancel for 45 seconds, it kills agy, restarts it and reloads the conversation (`recovered`).
- **Crashes and dropped SSH links:** handled with up to 2 automatic restarts.
- **A host that isn't signed in:** fails in seconds with a sign-in hint.

## Hosts

- `hosts` lists them. `hosts add <name> --ssh <alias> [--cwd DIR]` adds one (OS and agy path are detected). `doctor` checks reachability, agy version and sign-in.
- On a remote host, agy works on **that machine's files**. Give `--cwd` as a path on that host (`~` works).
- Not signed in on a host: tell the user to run `ssh -t <alias> agy` themselves and sign in once.

Other commands: `status [id]` · `log <id> [--tail N]` · `result <id> [--turn N]` · `prune [--older 7d]` · `help`.
Exit codes: 0 ok · 1 turn ended badly · 2 could not start or resume · 3 waiting for approval · 64 usage error · 124 still running.
