# agy-dispatch

Run **agy** (the Google Antigravity CLI) as a supervised subagent from **Claude Code**, **Codex** or **DeepSeek Harness (dsh)**, on this machine or on other machines over SSH. You start a task, follow its progress line by line, talk to agy while it works, answer its approval requests, and get its reply back. A watchdog keeps a stuck agy from blocking you.

The three hosts share one dispatcher, `scripts/agy.mjs`. Each host gets a thin adapter that teaches its model how to call it.

| Host | Adapter | What you get |
|---|---|---|
| Claude Code | `.claude-plugin/`, `commands/`, `skills/agy/` | `/agy:*` slash commands, the `agy` skill, a live feed through Monitor |
| Codex | `.codex-plugin/`, `codex/skills/agy/` | the `agy` skill |
| dsh | `dsh/` | a Cordis plugin that registers the `agy` skill, or the same skill as a file in `~/.dsh/skills` |

## Features

- **Live progress.** One background broker per session runs `agy acp` (Agent Client Protocol) and turns its stream into one line per event: `turn 1 started`, `read_file: calc.py`, `steps 1/3 · now: ...`, `APPROVAL #2`, `turn 1 finished`. You follow it with Claude Code's Monitor, a background command in Codex, or a background job plus `job_output` in dsh.
- **Live conversation.** `send` while agy is working adds the message to the current turn, and agy picks it up at its next step. `--interrupt` cancels the turn first. agy's questions and approval requests come back to you, and you reply with `send` or `answer`.
- **No hangs.**
  - A watchdog cancels a turn that goes silent, and kills agy if it ignores the cancel.
  - The broker then restarts agy and reloads the conversation. It does the same after a crash or a dropped SSH link.
  - Unanswered approvals are denied after a timeout.
  - A host that isn't signed in fails in seconds instead of waiting on OAuth.
  - `wait` and `run` never block longer than `--timeout`.
- **Nothing runs when idle.** A session whose agy has been idle for 20 minutes stops that process (`parked`). `send` resumes it with its memory.
- **Read-only by default, and enforced.**
  - agy runs with its own settings profile (`--cli_dir_name agy-dispatch-ro`, `request-review`), so it must ask before any edit or command.
  - The broker denies edits and allows only plain read commands (`ls`, `cat`, `rg`, `git status/diff/log/show`, ...) without shell operators.
  - A write that completes anyway cancels the turn.
  - `--write` allows edits and commands, and sends approvals to you.
- **Several machines.** `hosts add <name> --ssh <alias>` detects the OS (Linux, macOS or Windows PowerShell) and the agy path. Messages go over the wire as ASCII-only JSON, so Chinese text and quotes survive PowerShell 5.1.

## Requirements

- Node 20 or later wherever the dispatcher runs.
- `agy` on every machine that runs sessions, signed in once: run `agy` locally, or `ssh -t <alias> agy` for a remote host.
- For remote hosts: key-based SSH (`BatchMode`) to an alias in `~/.ssh/config`.

## Install

### Claude Code

```bash
claude plugin marketplace add sweetcornna/agy-dispatch      # or a local checkout path
claude plugin install agy@agy-dispatch
```

Update: `claude plugin marketplace update agy-dispatch && claude plugin update agy@agy-dispatch`, then restart Claude Code.

### Codex

Codex 0.17x and later reads `.codex-plugin/plugin.json`.

```bash
codex plugin marketplace add sweetcornna/agy-dispatch
codex plugin add agy@agy-dispatch
```

Update: `codex plugin marketplace upgrade agy-dispatch`.

### DeepSeek Harness (dsh 0.2.2+)

Clone the repo, then pick one way:

```bash
git clone https://github.com/sweetcornna/agy-dispatch.git
node agy-dispatch/dsh/install-skill.mjs                              # every profile: writes ~/.dsh/skills/agy/SKILL.md
dsh headless --patch agy-dispatch/dsh/cordis.patch.yml "..."        # this run only, nothing installed
dsh plugin --profile <name> add "$PWD/agy-dispatch/dsh"             # one profile (dsh hands this to pnpm)
```

- `install-skill.mjs` writes the skill with the absolute path of this checkout's dispatcher. Run it again after you move or update the checkout. `--dir <skills-dir>` writes somewhere else, and `--uninstall` removes it.
- The plugin (`dsh/index.mjs`) registers the same skill with `ctx.skills.register` each time dsh boots, so it always uses the current checkout.
- On macOS the desktop app's CLI is at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`. Link it onto your `PATH` if `dsh` isn't found.
- dsh keeps running when a plugin fails to load. It only prints `dsh: warning: 1 entry did not activate` on stderr, so look for that line if the skill seems missing. `dsh <profile> --patch .../cordis.patch.yml --dump-config` shows whether the `agy-dispatch` line was added.

## Use

Ask in plain words in any host, for example "用 agy 看看这个 bug", "让 agy 在 labcage 上把测试跑一遍并修好", or "ask agy for a second opinion on this diff". The skill picks one of two ways to run it:

- **One-shot** (`run`): a quick, bounded question. The command waits and prints agy's answer.
- **Session** (`start`): longer work. The model follows progress, steers with `send`, answers approvals, reads the reply with `result`, and ends with `stop`.

### Claude Code

| Command | What it does |
|---|---|
| `/agy:run [--host h] [--write] <task>` | one-shot task; returns agy's answer |
| `/agy:start [--host h] [--write] <task>` | background session plus a live Monitor feed |
| `/agy:send <id> [--interrupt] <msg>` | talk to a session: steer it, answer a question, resume it |
| `/agy:status [id]`, `/agy:result <id>` | sessions table or one session's details; latest reply |
| `/agy:cancel <id>`, `/agy:stop <id>\|--all` | cancel the current turn; end the session |
| `/agy:hosts [doctor\|add\|rm]` | manage machines; check reachability and sign-in |

### Codex

The `agy` skill follows progress with a long-running `watch` or `wait` command. The dispatcher starts background processes, writes to `~/.agy-dispatch`, and uses the network and SSH, so it has to run outside Codex's sandbox: run Codex with `danger-full-access`, or approve the escalated commands. In a read-only sandbox (the default for `codex exec` in some setups) agy can't start a session.

### dsh

The skill runs `watch` or `wait` with `run_in_background: true` and reads it with `job_output`. dsh sends a completion notice when the turn ends or agy needs approval. A foreground command that outlives dsh's timeout becomes a background job anyway, so a long `run` doesn't get lost. If the sandbox denies a call, the skill retries it once with wider `sandbox_permissions`. You can also run dsh with `--permission-mode danger-full-access`.

## Remote hosts

```bash
node scripts/agy.mjs hosts add lab --ssh my-lab-box                 # detects OS and agy path
node scripts/agy.mjs hosts add win --ssh my-windows-box --cwd 'C:\src'
node scripts/agy.mjs doctor --all                                  # reachability, agy version, sign-in
node scripts/agy.mjs run --host lab -- "summarize the README in ~/proj"
```

- Windows hosts run through PowerShell 5.1. Paths with spaces and non-ASCII text work.
- A remote agy that isn't signed in fails fast. Sign it in once with `ssh -t <alias> agy`.
- If the SSH link drops, the broker kills any orphaned remote agy by PID and reconnects with the conversation reloaded.

## CLI

`node scripts/agy.mjs help` prints the full reference. State lives in `~/.agy-dispatch/` (`hosts.json`, `sessions/<id>/`), or in `$AGY_DISPATCH_HOME` if it is set.

```bash
node scripts/agy.mjs start --host win --write - <<'EOF'
Run the test suite in C:\src\app and fix what fails.
EOF
node scripts/agy.mjs watch win-ab3cd                 # live lines; ends when the session stops or parks
node scripts/agy.mjs send win-ab3cd -- "skip the flaky network tests"
node scripts/agy.mjs answer win-ab3cd allow          # approve a pending request
node scripts/agy.mjs result win-ab3cd
node scripts/agy.mjs stop win-ab3cd
```

| Option | Meaning |
|---|---|
| `--host NAME` | where agy runs (default `local`) |
| `--cwd DIR` | working directory on that host |
| `--write` | allow edits and commands; approvals come to you (`--approve ask\|auto\|deny`) |
| `--yolo` | `--write` plus agy's `--dangerously-skip-permissions` |
| `--model ID`, `--mode MODE` | agy model (see `models`) and mode (`default`, `accept-edits`, `auto`, `plan`) |
| `--idle-timeout 10m`, `--tool-timeout 30m`, `--turn-timeout 3h` | watchdog limits |
| `--ask-timeout 15m` | an unanswered approval is denied after this |
| `--idle-exit 20m` | park an idle session (`0` = never) |
| `--timeout 9m` | the longest `run`/`wait` blocks before it exits 124 |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | the turn failed or the session died |
| 2 | the session could not start or resume |
| 3 | agy is waiting for your answer |
| 64 | usage error |
| 124 | still running; run `wait` again |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Authentication required` / doctor says not signed in | run `agy` once on that machine (`ssh -t <alias> agy` for a remote host) |
| Codex answers by itself and no agy session appears | Codex is in a read-only sandbox; allow the escalated command or use `danger-full-access` |
| dsh doesn't know the skill | check stderr for `did not activate`; rerun `dsh/install-skill.mjs` after moving the checkout |
| A turn shows `STALL` | the watchdog is cancelling it; if agy ignores the cancel, the broker restarts agy and reloads the conversation |
| A session shows `parked` | normal after 20 minutes idle; `send` resumes it |

## Tests

`npm test` runs two suites:

- `tests/` drives the broker against a scripted fake agy (`tests/fake-agy.mjs`), so it uses no agy quota. It covers stalls, kill and reload, crashes, approvals and their timeouts, read-only violations, mid-turn messages, interrupts, parking and resume, and sign-in failure.
- `dsh/test/` checks the dsh plugin: skill registration, path quoting, and install and uninstall.

## License

MIT
