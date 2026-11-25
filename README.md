# agy-dispatch

One repo, three hosts: plugins for **Claude Code**, **Codex** and **DeepSeek Harness (dsh)** that all share one dispatcher (`scripts/agy.mjs`) and drive **agy** (the Google Antigravity CLI) like a subagent, on this machine or on other machines over SSH.

- **Live progress**: a background broker runs `agy acp` (Agent Client Protocol) and turns its stream into one line per event. Watch it with Claude Code's Monitor.
- **Live conversation**: `send` while agy is working adds the message to the current turn, and agy picks it up at its next step. `--interrupt` cancels the turn first. agy's questions and approval requests come back to Claude (`answer`).
- **No hangs**: a watchdog cancels a turn that goes silent and kills agy if it ignores the cancel. The broker then restarts agy and reloads the conversation, and it does the same after a crash or a dropped SSH link. Unanswered approvals are denied after a timeout. A host that isn't signed in fails in seconds instead of waiting on OAuth. `wait` and `run` never block longer than `--timeout`.
- **Nothing runs when idle**: an idle session stops its agy process after 20 minutes (parked). `send` resumes it with its memory.
- **Enforced read-only by default**: agy runs with its own settings profile (`--cli_dir_name agy-dispatch-ro`, `request-review`), so it must ask before any edit or command. The broker denies edits and allows only plain read commands, and a write that completes anyway cancels the turn. `--write` allows edits and commands, with approvals routed to you.
- **Several machines**: `hosts add <name> --ssh <alias>` detects the OS (Linux, macOS or Windows PowerShell) and the agy path. The wire is ASCII-only JSON, so Chinese and quotes survive PowerShell 5.1.

## Install

Claude Code:

```bash
claude plugin marketplace add sweetcornna/agy-dispatch      # or a local checkout path
claude plugin install agy@agy-dispatch
```

Codex (0.17x and later, which reads `.codex-plugin/plugin.json`):

```bash
codex plugin marketplace add sweetcornna/agy-dispatch
codex plugin add agy@agy-dispatch
```

DeepSeek Harness (dsh 0.2.2+), any of:

```bash
node <checkout>/dsh/install-skill.mjs                 # skill for every profile: ~/.dsh/skills/agy/SKILL.md
dsh headless --patch <checkout>/dsh/cordis.patch.yml "..."   # per run, nothing installed
dsh plugin --profile <name> add <checkout>/dsh        # into one profile (needs pnpm)
```

The dsh side is a Cordis plugin (`dsh/index.mjs`) that registers the `agy` skill with `ctx.skills.register`, or the same skill written as a filesystem skill. The skill text holds the absolute path of this checkout's dispatcher, so rerun `install-skill.mjs` after moving the checkout. dsh moves a foreground command that outlives its timeout to a background job, so the skill tells the model to run `wait`/`watch` with `run_in_background` and read them with `job_output`.

Layout: `scripts/` (shared dispatcher and broker), `commands/` + `skills/` + `.claude-plugin/` (Claude Code), `codex/` + `.codex-plugin/` (Codex), `dsh/` (dsh).

Codex gets the `agy` skill (`codex/skills/agy`). Ask in plain words, for example "用 agy 看看这个 bug" or "让 agy 在 labcage 上跑测试". The dispatcher starts background processes, writes `~/.agy-dispatch`, and uses the network and SSH, so Codex must run it outside its sandbox: `danger-full-access`, or escalated commands.

Requires Node 20+ and `agy` on each machine that runs sessions, signed in once (`agy`; over SSH: `ssh -t <alias> agy`).

## Use in Claude Code

| Command | What it does |
|---|---|
| `/agy:run [--host h] [--write] <task>` | one-shot task, returns agy's answer |
| `/agy:start [--host h] [--write] <task>` | background session plus a live Monitor feed |
| `/agy:send <id> [--interrupt] <msg>` | talk to a session (steer, answer a question, resume) |
| `/agy:status [id]`, `/agy:result <id>` | sessions table or details; latest reply |
| `/agy:cancel <id>`, `/agy:stop <id>|--all` | cancel the turn; end the session |
| `/agy:hosts [doctor|add|rm]` | manage machines; check reachability and sign-in |

The `agy` skill also triggers on plain requests ("让 agy 在 Windows 上把测试跑一遍", "ask agy to review this").

## CLI

`node scripts/agy.mjs help` prints the full reference. State lives in `~/.agy-dispatch/` (`hosts.json`, `sessions/<id>/`), or in `$AGY_DISPATCH_HOME` if set.

```bash
node scripts/agy.mjs hosts add win --ssh my-windows-box --cwd 'C:\\src'
node scripts/agy.mjs doctor
node scripts/agy.mjs start --host win --write - <<'EOF'
Run the test suite in C:\src\app and fix what fails.
EOF
node scripts/agy.mjs watch win-ab3cd          # live lines; ends when the session stops
node scripts/agy.mjs send win-ab3cd -- "skip the flaky network tests"
node scripts/agy.mjs result win-ab3cd
```

Watchdog flags: `--idle-timeout 10m --tool-timeout 30m --turn-timeout 3h --ask-timeout 15m --startup-timeout 2m --idle-exit 20m`.

## Tests

`npm test` runs the broker against a scripted fake agy (`tests/fake-agy.mjs`), covering stalls, kill and reload, crashes, approvals and their timeouts, read-only violations, mid-turn messages, parking and resume, and sign-in failure. It uses no agy quota. `dsh/test/` checks the dsh plugin (skill registration, path quoting, install and uninstall).
