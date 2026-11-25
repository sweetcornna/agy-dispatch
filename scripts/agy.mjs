#!/usr/bin/env node
// agy-dispatch: run and supervise agy (Antigravity CLI) sessions on this or other machines.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Session, listSessions, newSessionId, isLiveStatus, sessionsDir } from './lib/store.mjs';
import { getHost, listHosts, loadHosts, saveHosts, probeSsh, authCheck, loginHint } from './lib/hosts.mjs';
import { runBroker, VERSION } from './lib/broker.mjs';
import { renderEvent, END_TYPES, INPUT_TYPES } from './lib/render.mjs';
import { parseArgs, parseDuration, fmtDur, fmtAgo, oneLine, UsageError, sleep, readStdin, isAlive } from './lib/util.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);
const SELF = 'node ' + (/\s/.test(SELF_PATH) ? JSON.stringify(SELF_PATH) : SELF_PATH);
const out = (s = '') => process.stdout.write(s + '\n');

const HELP = `agy-dispatch ${VERSION} — run and supervise agy (Antigravity CLI) sessions here or on other machines

Sessions (each one is a long-lived agy conversation owned by a background broker)
  start  [opts] [--] <task|->                 start a session, send the task, return the session id
  run    [opts] [--] <task|->                 one-shot: start, wait, print agy's reply, stop
  send   <id> [--interrupt] [--] <message|->  talk to agy; mid-turn messages steer the running turn;
                                              stopped/parked sessions are resumed automatically
  watch  <id> [--until turn] [--all] [--verbose]   live progress lines (for Monitor / background)
  wait   <id> [--timeout 9m]                  block until the turn ends (or agy needs approval), print reply
  result <id> [--turn N]                      agy's reply for a turn (partial while running)
  answer <id> [req] <allow|always|deny|cancel|option-id>   answer an approval request
  cancel <id>                                 cancel the running turn (session stays)
  stop   <id> | --all                         end a session (it can still be resumed with send)
  status [id] [--all] [--json]                list sessions, or details for one
  log    <id> [--tail 60] [--verbose]         rendered event history
  prune  [--older 7d]                         delete finished sessions older than this

Hosts (stored in ~/.agy-dispatch/hosts.json)
  hosts                                       list hosts
  hosts add <name> --ssh <alias> [--cwd DIR] [--agy PATH] [--os posix|windows]
  hosts rm <name>
  doctor [--host NAME | --all]                reachability, agy version, sign-in
  models [--host NAME]

Session options (start/run)
  --host NAME        where agy runs (default: local)
  --cwd DIR          working directory on that host (default: here for local, host's cwd or ~ for remote)
  --write            let agy edit files and run commands (default is read-only: plan mode, edits blocked)
  --approve MODE     with --write: ask (default, approvals come to you) | auto | deny
  --yolo             --write plus agy's --dangerously-skip-permissions
  --mode MODE        agy mode: default | accept-edits | auto | plan
  --model ID         e.g. gemini-3.8-flash-high, claude-opus-4-6-thinking (see: models)
  --add-dir DIR      extra workspace directory (repeatable)    --sandbox   agy terminal sandbox
  --file PATH        read the task from a file ("-" or no task text reads stdin)
  Watchdog: --idle-timeout 10m (no output while thinking) --tool-timeout 30m (one tool silent)
            --turn-timeout 3h --ask-timeout 15m (unanswered approval → deny) --startup-timeout 2m
            --idle-exit 20m (stop the idle agy process; the session resumes on send; 0 = never)
  run only:  --timeout 9m (then exit 124, session keeps going)  --keep (do not stop afterwards)
`;

const SESSION_FLAGS = {
  host: 'string', cwd: 'string', write: 'bool', yolo: 'bool', approve: 'string', mode: 'string', model: 'string',
  'add-dir': 'list', sandbox: 'bool', file: 'string', json: 'bool',
  'idle-timeout': 'string', 'tool-timeout': 'string', 'turn-timeout': 'string', 'ask-timeout': 'string',
  'startup-timeout': 'string', 'idle-exit': 'string', 'cancel-grace': 'string', 'max-restarts': 'string',
  timeout: 'string', keep: 'bool', quiet: 'bool',
};
const MODES = ['default', 'accept-edits', 'auto', 'plan'];

async function readTask(args, rest) {
  if (args.file && args.file !== '-') return fs.readFileSync(args.file, 'utf8');
  if (args.file === '-' || (rest.length === 1 && rest[0] === '-')) return readStdin();
  if (rest.length === 0) return '';
  return rest.join(' ');
}

function buildMeta(args, host) {
  const write = !!(args.write || args.yolo);
  let mode = args.mode;
  if (mode && !MODES.includes(mode)) throw new UsageError(`--mode must be one of ${MODES.join(', ')}`);
  if (!write && mode && mode !== 'plan') throw new UsageError(`--mode ${mode} lets agy edit; add --write`);
  if (!mode) mode = write ? (args.yolo ? 'auto' : 'auto') : 'plan';
  const approve = args.yolo ? 'auto' : write ? (args.approve || 'ask') : 'deny';
  if (!['ask', 'auto', 'deny'].includes(approve)) throw new UsageError('--approve must be ask, auto or deny');
  if (args.model && !/^[A-Za-z0-9._:-]+$/.test(args.model)) throw new UsageError('bad --model');
  const cwd = host.local ? path.resolve(args.cwd || process.cwd()) : (args.cwd || host.cwd || '~');
  if (host.local && !fs.existsSync(cwd)) throw new UsageError(`--cwd ${cwd} does not exist`);
  return {
    host: host.name, cwd, mode, model: args.model || null, readOnly: !write, approve, yolo: !!args.yolo,
    sandbox: !!args.sandbox, addDirs: args['add-dir'] || [],
    limits: {
      startup: parseDuration(args['startup-timeout'], 120000),
      idle: parseDuration(args['idle-timeout'], 600000),
      tool: parseDuration(args['tool-timeout'], 1800000),
      turn: parseDuration(args['turn-timeout'], 3 * 3600000),
      ask: parseDuration(args['ask-timeout'], 900000),
      cancelGrace: parseDuration(args['cancel-grace'], 45000),
      idleExit: parseDuration(args['idle-exit'], 1200000),
      maxRestarts: args['max-restarts'] != null ? Number(args['max-restarts']) : 2,
    },
    createdAt: Date.now(),
    createdFrom: process.cwd(),
  };
}

function spawnBroker(id) {
  const c = spawn(process.execPath, [SELF_PATH, '_broker', id], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
}

async function waitReady(s, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const st = s.effectiveState();
    if (['idle', 'running', 'needs_input'].includes(st.status)) return { ok: true, st };
    if (['failed', 'dead', 'stopped'].includes(st.status)) return { ok: false, st };
    await sleep(200);
  }
  return { ok: false, st: { ...s.state(), error: 'broker did not become ready in ' + fmtDur(ms) } };
}

async function waitAck(s, cmdId, ms, offset = 0) {
  const end = Date.now() + ms;
  let off = offset;
  while (Date.now() < end) {
    const r = s.readEvents(off);
    off = r.offset;
    for (const e of r.events) if (e.type === 'ack' && e.cmdId === cmdId) return e;
    const st = s.effectiveState();
    if (['failed', 'dead', 'stopped', 'parked'].includes(st.status) && !s.pendingInbox().length) return null;
    await sleep(150);
  }
  return null;
}

function describe(meta) {
  const access = meta.readOnly ? 'read-only' : meta.yolo ? 'write (yolo)' : `write, approvals: ${meta.approve}`;
  return `${access} · mode ${meta.mode}${meta.model ? ' · model ' + meta.model : ''}`;
}

async function cmdStart(argv, { oneShot = false } = {}) {
  const args = parseArgs(argv, { flags: SESSION_FLAGS });
  const host = getHost(args.host);
  const task = (await readTask(args, args._)).replace(/\s+$/, '');
  if (oneShot && !task.trim()) throw new UsageError('run needs a task (text, "-" for stdin, or --file)');
  const meta = buildMeta(args, host);
  const id = newSessionId(host.name);
  const s = new Session(id);
  s.create({ id, ...meta });
  const cmdId = task.trim() ? s.post({ type: 'prompt', text: task }) : null;
  spawnBroker(id);
  const ready = await waitReady(s, meta.limits.startup + 20000);
  if (!ready.ok) {
    const err = ready.st.error || 'session ' + ready.st.status;
    if (args.json) out(JSON.stringify({ id, ok: false, error: err }));
    else out(`failed to start ${id} on ${host.name}: ${err}`);
    process.exitCode = 2;
    return null;
  }
  let ack = null;
  if (cmdId) ack = await waitAck(s, cmdId, 20000);
  const st = s.state();
  if (!oneShot) {
    if (args.json) out(JSON.stringify({ id, ok: true, host: host.name, cwd: st.cwd, agySessionId: st.agySessionId, turn: st.turn, status: st.status }));
    else {
      out(`started ${id} on ${host.name} · ${describe(meta)} · cwd ${st.cwd}`);
      out(cmdId ? (ack ? `task sent (turn ${ack.turn} running)` : 'task queued') : 'no task yet — talk to it with send');
      out(`watch: ${SELF} watch ${id}    wait: ${SELF} wait ${id}    send: ${SELF} send ${id} -- "<msg>"`);
    }
  }
  return { id, s, meta, host };
}

function turnBlock(s, n, { header = true } = {}) {
  const meta = s.meta();
  const st = s.effectiveState();
  const rec = n ? s.turn(n) : null;
  const lines = [];
  if (rec) {
    if (header) lines.push(`── ${s.id} · ${meta.host} · turn ${n} · ${rec.stopReason} · ${fmtDur(rec.endedAt - rec.startedAt)} ──`);
    lines.push(rec.reply.trim() || '(agy sent no text this turn)');
    if (rec.question && rec.question.length) {
      lines.push('', 'agy is asking:');
      for (const q of rec.question) lines.push('  - ' + q.question + (q.options && q.options.length ? '  [' + q.options.join(' | ') + ']' : ''));
      lines.push(`reply with: ${SELF} send ${s.id} -- "<answer>"`);
    }
    if (rec.notes && rec.notes.length) lines.push('', 'notes: ' + rec.notes.join('; '));
    return lines.join('\n');
  }
  // running turn: rebuild partial text from events
  const { events } = s.readEvents(0);
  const parts = events.filter((e) => e.type === 'text' && e.turn === n).map((e) => e.text);
  if (header) lines.push(`── ${s.id} · ${meta.host} · turn ${n || 0} · ${st.status} (partial) ──`);
  lines.push(parts.join('').trim() || '(no reply text yet)');
  return lines.join('\n');
}

async function cmdRun(argv) {
  const args = parseArgs(argv, { flags: SESSION_FLAGS });
  const timeout = parseDuration(args.timeout, 9 * 60000);
  const started = await cmdStart(argv, { oneShot: true });
  if (!started) return;
  const { s, id } = started;
  const r = await waitTurn(s, timeout);
  if (r.kind === 'timeout') {
    out(turnBlock(s, s.state().turn));
    out(`\n[still running after ${fmtDur(timeout)}] session ${id} continues. Wait again: ${SELF} wait ${id}   watch: ${SELF} watch ${id}`);
    process.exitCode = 124;
    return;
  }
  if (r.kind === 'input') { printNeedsInput(s, r.st); process.exitCode = 3; return; }
  const st = s.state();
  out(turnBlock(s, st.turn));
  const rec = s.turn(st.turn);
  const asked = rec && rec.question && rec.question.length;
  if (args.keep || asked) out(`\n(session ${id} kept; continue with: ${SELF} send ${id} -- "<msg>")`);
  else { await stopSession(s, 'one-shot run finished'); out(`\n(session ${id} stopped; resume anytime with: ${SELF} send ${id} -- "<msg>")`); }
  if (r.kind === 'ended' && st.status !== 'idle' && st.status !== 'parked') process.exitCode = 1;
  if (rec && !['end_turn'].includes(rec.stopReason)) process.exitCode = 1;
}

function printNeedsInput(s, st) {
  for (const p of st.pending || []) out(`[${s.id}] APPROVAL #${p.req} needed: ${p.title}\n  answer: ${SELF} answer ${s.id} ${p.req} allow|always|deny`);
  if (!(st.pending || []).length) out(`[${s.id}] agy is waiting for input — see: ${SELF} status ${s.id}`);
}

// Wait until the session is not busy. Returns {kind: 'idle'|'input'|'ended'|'timeout', st}
async function waitTurn(s, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const st = s.effectiveState();
    const queued = s.pendingInbox().length > 0;
    if (st.status === 'needs_input') return { kind: 'input', st };
    if (!queued && st.status === 'idle') return { kind: 'idle', st };
    if (['parked', 'stopped', 'dead', 'failed'].includes(st.status) && !(queued && isAlive(st.brokerPid))) return { kind: 'ended', st };
    if (Date.now() > end) return { kind: 'timeout', st };
    await sleep(400);
  }
}

async function cmdWait(argv) {
  const args = parseArgs(argv, { flags: { timeout: 'string', json: 'bool' } });
  const s = sessionArg(args._[0]);
  const r = await waitTurn(s, parseDuration(args.timeout, 9 * 60000));
  if (r.kind === 'input') { printNeedsInput(s, r.st); process.exitCode = 3; return; }
  out(turnBlock(s, s.state().turn));
  if (r.kind === 'timeout') { out(`\n[still running] wait again: ${SELF} wait ${s.id}`); process.exitCode = 124; }
  if (r.kind === 'ended' && ['dead', 'failed'].includes(r.st.status)) { out(`\n[${r.st.status}] ${r.st.error || r.st.deadReason || ''}`); process.exitCode = 1; }
}

function sessionArg(id) {
  if (!id) throw new UsageError('missing session id (see: status)');
  const s = new Session(id);
  if (!s.exists()) {
    const m = listSessions().filter((x) => x.id.endsWith(id) || x.id.startsWith(id));
    if (m.length === 1) return m[0];
    throw new UsageError(`no session "${id}"`);
  }
  return s;
}

async function cmdSend(argv) {
  const args = parseArgs(argv, { flags: { interrupt: 'bool', file: 'string', json: 'bool' } });
  const s = sessionArg(args._[0]);
  const text = (await readTask(args, args._.slice(1))).replace(/\s+$/, '');
  if (!text.trim()) throw new UsageError('send needs a message (text, "-" for stdin, or --file)');
  const meta = s.meta();
  let st = s.effectiveState();
  if (st.status === 'failed' && !meta.agySessionId) throw new UsageError(`session ${s.id} never started (${st.error || 'failed'}); start a new one`);
  const off = s.eventsSize();
  const cmdId = s.post({ type: 'prompt', text, interrupt: !!args.interrupt });
  let resumed = false;
  if (!isLiveStatus(st.status) || st.status === 'dead') {
    if (isAlive(st.brokerPid)) { /* broker still shutting down */ await sleep(1500); }
    s.setState({ status: 'starting', brokerPid: null, error: null, heartbeatAt: null });
    spawnBroker(s.id);
    resumed = true;
    const ready = await waitReady(s, meta.limits.startup + 20000);
    if (!ready.ok) { out(`could not resume ${s.id}: ${ready.st.error || ready.st.status}`); process.exitCode = 2; return; }
  }
  const ack = await waitAck(s, cmdId, (args.interrupt ? meta.limits.cancelGrace : 0) + 20000, off);
  st = s.state();
  if (!ack) out(`queued for ${s.id} (agy has not picked it up yet; check: ${SELF} status ${s.id})`);
  else out(`sent to ${s.id}${resumed ? ' (session resumed)' : ''}: turn ${ack.turn}${ack.injected ? ', added to the running turn' : ' started'}`);
}

async function cmdWatch(argv) {
  const args = parseArgs(argv, { flags: { until: 'string', all: 'bool', verbose: 'bool', json: 'bool', follow: 'bool', interval: 'string' } });
  const s = sessionArg(args._[0]);
  const until = args.until || 'end';
  if (!['end', 'turn'].includes(until)) throw new UsageError('--until must be turn or end');
  const opts = { verbose: !!args.verbose, self: SELF };
  let off = args.all ? 0 : s.eventsSize();
  const st0 = s.effectiveState();
  if (!args.all && !args.json) {
    const meta = s.meta();
    out(`[${s.id}] watching · ${meta.host} · ${st0.status}${st0.turn ? ' · turn ' + st0.turn : ''}${st0.title ? ' · ' + st0.title : ''}`);
  }
  if (!args.all && ['stopped', 'parked', 'dead', 'failed'].includes(st0.status) && !s.pendingInbox().length) {
    out(`[${s.id}] session is ${st0.status}; nothing to watch (send resumes it)`);
    return;
  }
  if (!args.all && until === 'turn' && st0.status === 'idle' && !s.pendingInbox().length) {
    out(`[${s.id}] idle — no turn running`);
    return;
  }
  let toolBuf = [];
  let toolBufAt = 0;
  let lastSteps = '';
  const flushTools = () => {
    if (!toolBuf.length) return;
    if (toolBuf.length === 1) out(toolBuf[0].line);
    else out(`[${s.id}] ${toolBuf.length} tools: ` + toolBuf.map((t) => `${t.e.name} ${oneLine(t.e.title, 60)}`).join(' · '));
    toolBuf = [];
  };
  let deadChecks = 0;
  for (;;) {
    const r = s.readEvents(off);
    off = r.offset;
    for (const e of r.events) {
      if (args.json) { out(JSON.stringify(e)); }
      else {
        const line = renderEvent(e, s.id, opts);
        if (line) {
          if (e.type === 'tool' && !opts.verbose) { toolBuf.push({ e, line }); if (!toolBufAt) toolBufAt = Date.now(); }
          else if (e.type === 'steps') { if (line !== lastSteps) { flushTools(); out(line); lastSteps = line; } }
          else { flushTools(); out(line); }
        }
      }
      if (END_TYPES.has(e.type)) { flushTools(); return; }
      if (until === 'turn' && (e.type === 'turn_end' || INPUT_TYPES.has(e.type))) { flushTools(); return; }
    }
    if (toolBuf.length && Date.now() - toolBufAt > 3000) { flushTools(); toolBufAt = 0; }
    if (!toolBuf.length) toolBufAt = 0;
    if (!r.events.length) {
      const st = s.effectiveState();
      if (st.status === 'dead' && !s.pendingInbox().length) {
        if (++deadChecks > 3) { flushTools(); out(`[${s.id}] DEAD: ${st.error || st.deadReason || 'broker gone'} — ${SELF} send ${s.id} -- "<msg>" tries to resume`); return; }
      } else deadChecks = 0;
    }
    await sleep(400);
  }
}

async function cmdResult(argv) {
  const args = parseArgs(argv, { flags: { turn: 'string', json: 'bool' } });
  const s = sessionArg(args._[0]);
  const st = s.effectiveState();
  const n = args.turn ? Number(args.turn) : st.turn;
  if (args.json) { out(JSON.stringify({ id: s.id, status: st.status, turn: n, record: s.turn(n) })); return; }
  out(turnBlock(s, n));
}

async function cmdAnswer(argv) {
  const args = parseArgs(argv, { flags: {} });
  const s = sessionArg(args._[0]);
  let req = null, value;
  if (args._.length >= 3) { req = args._[1]; value = args._.slice(2).join(' '); } else value = args._[1];
  if (value == null) throw new UsageError('answer <id> [req] <allow|always|deny|cancel|option-id>');
  const off = s.eventsSize();
  const cmdId = s.post({ type: 'answer', req, value });
  const ack = await waitAck(s, cmdId, 10000, off);
  if (!ack) { out('no response from the session broker'); process.exitCode = 2; return; }
  if (!ack.ok) { out('not answered: ' + ack.error); process.exitCode = 1; return; }
  out(`answered${req ? ' #' + req : ''}: ${value}`);
}

async function cmdCancel(argv) {
  const args = parseArgs(argv, { flags: {} });
  const s = sessionArg(args._[0]);
  const st = s.effectiveState();
  if (!isLiveStatus(st.status)) { out(`${s.id} is ${st.status}; nothing to cancel`); return; }
  const off = s.eventsSize();
  const cmdId = s.post({ type: 'cancel', reason: 'cancelled by Claude/user' });
  const ack = await waitAck(s, cmdId, 10000, off);
  out(ack ? (ack.ok ? `cancel sent to ${s.id}` : `not cancelled: ${ack.error}`) : 'no response from the session broker');
}

async function stopSession(s, reason) {
  const st = s.effectiveState();
  if (!isLiveStatus(st.status) || !isAlive(st.brokerPid)) {
    if (isLiveStatus(st.status) || st.status === 'dead') s.setState({ status: 'stopped', stopReason: reason, stoppedAt: Date.now() });
    return 'stopped';
  }
  s.post({ type: 'stop', reason });
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const x = s.effectiveState();
    if (!isLiveStatus(x.status)) return x.status;
    await sleep(200);
  }
  return 'stop requested (still shutting down)';
}

async function cmdStop(argv) {
  const args = parseArgs(argv, { flags: { all: 'bool' } });
  const targets = args.all ? listSessions().filter((s) => isLiveStatus(s.effectiveState().status)) : [sessionArg(args._[0])];
  if (!targets.length) { out('no live sessions'); return; }
  for (const s of targets) out(`${s.id}: ${await stopSession(s, 'stop requested')}`);
}

function sessionRow(s) {
  const m = s.meta();
  const st = s.effectiveState();
  const t1 = s.turn(1);
  const task = st.title || (t1 && t1.prompts && t1.prompts[0]) || '';
  return { id: s.id, host: m.host, status: st.status, turn: st.turn || 0, access: m.readOnly ? 'ro' : 'rw', activity: st.lastActivity || st.updatedAt, title: oneLine(task, 60) };
}

async function cmdStatus(argv) {
  const args = parseArgs(argv, { flags: { all: 'bool', json: 'bool', tail: 'string' } });
  if (args._[0]) {
    const s = sessionArg(args._[0]);
    const m = s.meta();
    const st = s.effectiveState();
    if (args.json) { out(JSON.stringify({ meta: m, state: st })); return; }
    out(`${s.id} · ${m.host} · ${st.status}${st.turn ? ' · turn ' + st.turn : ''} · ${describe(m)}`);
    out(`cwd ${st.cwd || m.cwd} · agy conversation ${st.agySessionId || m.agySessionId || '-'}`);
    if (st.title) out('title: ' + st.title);
    if (st.activeTool) out(`running: ${st.activeTool.name} ${st.activeTool.title} (${fmtDur(Date.now() - st.activeTool.startedAt)})`);
    if (st.lastActivity && isLiveStatus(st.status)) out('last activity ' + fmtAgo(st.lastActivity));
    if (st.context) out(`context ${Math.round(st.context.used / 1000)}k / ${Math.round(st.context.size / 1000)}k tokens`);
    if (st.error) out('error: ' + st.error);
    for (const p of st.pending || []) out(`APPROVAL #${p.req}: ${p.title} → ${SELF} answer ${s.id} ${p.req} allow|always|deny`);
    const { events } = s.readEvents(0);
    const lines = events.map((e) => renderEvent(e, s.id, { self: SELF })).filter(Boolean);
    const n = Number(args.tail || 12);
    if (lines.length) { out('', 'recent:'); for (const l of lines.slice(-n)) out('  ' + l); }
    return;
  }
  let rows = listSessions().map(sessionRow);
  if (!args.all) rows = rows.filter((r, i) => isLiveStatus(r.status) || i < 15);
  if (args.json) { out(JSON.stringify(rows)); return; }
  if (!rows.length) { out('no sessions yet — start one with: ' + SELF + ' start --host <name> -- "<task>"'); return; }
  const cols = ['id', 'host', 'status', 'turn', 'access', 'activity', 'title'];
  const view = rows.map((r) => ({ ...r, activity: r.activity ? fmtAgo(r.activity) : '-' }));
  const w = cols.map((c) => Math.max(c.length, ...view.map((r) => String(r[c]).length)));
  out(cols.map((c, i) => c.toUpperCase().padEnd(w[i])).join('  '));
  for (const r of view) out(cols.map((c, i) => String(r[c]).padEnd(w[i])).join('  ').trimEnd());
}

async function cmdLog(argv) {
  const args = parseArgs(argv, { flags: { tail: 'string', verbose: 'bool' } });
  const s = sessionArg(args._[0]);
  const { events } = s.readEvents(0);
  const lines = events.map((e) => {
    const l = renderEvent(e, s.id, { verbose: !!args.verbose, self: SELF });
    return l ? new Date(e.t).toISOString().slice(11, 19) + ' ' + l : null;
  }).filter(Boolean);
  for (const l of lines.slice(-Number(args.tail || 60))) out(l);
}

async function cmdPrune(argv) {
  const args = parseArgs(argv, { flags: { older: 'string' } });
  const age = parseDuration(args.older, 7 * 86400000);
  let n = 0;
  for (const s of listSessions()) {
    const st = s.effectiveState();
    if (isLiveStatus(st.status) && st.status !== 'dead') continue;
    if (Date.now() - (st.updatedAt || 0) < age) continue;
    fs.rmSync(s.dir, { recursive: true, force: true });
    n++;
  }
  out(`removed ${n} session(s) from ${sessionsDir()}`);
}

async function cmdHosts(argv) {
  const sub = argv[0];
  if (!sub || sub === 'list') {
    for (const h of listHosts()) {
      out(`${h.name.padEnd(14)} ${(h.local ? 'this machine' : 'ssh ' + h.ssh).padEnd(26)} ${(h.os || '?').padEnd(8)} agy ${h.agy || 'agy (PATH)'}${h.cwd ? '  cwd ' + h.cwd : ''}`);
    }
    return;
  }
  if (sub === 'add') {
    const args = parseArgs(argv.slice(1), { flags: { ssh: 'string', cwd: 'string', agy: 'string', os: 'string', 'ssh-option': 'list' } });
    const name = args._[0];
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name) || name === 'local') throw new UsageError('hosts add <name> --ssh <alias>   (name: letters, digits, - or _; not "local")');
    const ssh = args.ssh || name;
    let os = args.os, agy = args.agy, version = '';
    if (!os || !agy) {
      const pr = await probeSsh(ssh, args['ssh-option']);
      if (!pr.ok) throw new UsageError(`cannot reach ${ssh}: ${pr.error}`);
      os = os || pr.os; agy = agy || pr.agy; version = pr.version;
    }
    const cfg = loadHosts();
    cfg.hosts[name] = { ssh, os, ...(agy ? { agy } : {}), ...(args.cwd ? { cwd: args.cwd } : {}), ...(args['ssh-option'].length ? { sshOptions: args['ssh-option'] } : {}) };
    saveHosts(cfg);
    out(`saved host ${name}: ssh ${ssh} · ${os} · ${agy ? 'agy ' + agy + (version ? ' (' + version + ')' : '') : 'agy NOT FOUND on that machine — install it there first'}`);
    if (agy) out(`check sign-in with: ${SELF} doctor --host ${name}`);
    return;
  }
  if (sub === 'rm' || sub === 'remove') {
    const cfg = loadHosts();
    if (!cfg.hosts[argv[1]]) throw new UsageError(`no host "${argv[1]}"`);
    delete cfg.hosts[argv[1]];
    saveHosts(cfg);
    out('removed ' + argv[1]);
    return;
  }
  throw new UsageError('hosts [list | add <name> --ssh <alias> | rm <name>]');
}

async function doctorOne(h) {
  const parts = [h.name.padEnd(14)];
  if (!h.local) {
    const pr = await probeSsh(h.ssh, h.sshOptions || []);
    if (!pr.ok) return parts.concat(`UNREACHABLE (ssh ${h.ssh}): ${pr.error}`).join(' ');
    if (!pr.agy && !h.agy) return parts.concat(`${pr.os}: agy not installed`).join(' ');
    parts.push(`${pr.os} · agy ${pr.version || '?'}`);
  } else {
    parts.push(`${h.os} · local`);
  }
  const a = await authCheck(h);
  if (a.signedIn) parts.push(`· signed in · ${a.models.length} models`);
  else if (a.signedIn === false) parts.push(`· NOT SIGNED IN → ${loginHint(h)}`);
  else parts.push(`· sign-in unknown (${a.detail})`);
  return parts.join(' ');
}

async function cmdDoctor(argv) {
  const args = parseArgs(argv, { flags: { host: 'string', all: 'bool' } });
  out(`agy-dispatch ${VERSION} · node ${process.version} · state ${sessionsDir()}`);
  const hosts = args.host ? [getHost(args.host)] : listHosts();
  const lines = await Promise.all(hosts.map((h) => doctorOne(h).catch((e) => h.name + ' error: ' + e.message)));
  for (const l of lines) out(l);
  const live = listSessions().filter((s) => isLiveStatus(s.effectiveState().status));
  out(`live sessions: ${live.length}${live.length ? ' (' + live.map((s) => s.id).join(', ') + ')' : ''}`);
}

async function cmdModels(argv) {
  const args = parseArgs(argv, { flags: { host: 'string' } });
  const h = getHost(args.host);
  const a = await authCheck(h);
  if (a.signedIn) for (const m of a.models) out(m);
  else out(a.signedIn === false ? `not signed in on ${h.name}: ${loginHint(h)}` : `could not list models: ${a.detail}`);
}

const COMMANDS = {
  start: (a) => cmdStart(a), run: cmdRun, send: cmdSend, watch: cmdWatch, wait: cmdWait, result: cmdResult,
  answer: cmdAnswer, cancel: cmdCancel, stop: cmdStop, status: cmdStatus, log: cmdLog, prune: cmdPrune,
  hosts: cmdHosts, doctor: cmdDoctor, models: cmdModels,
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '_broker') { await runBroker(rest[0]); return; }
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { out(HELP); return; }
  if (cmd === '--version' || cmd === 'version') { out(VERSION); return; }
  const fn = COMMANDS[cmd];
  if (!fn) throw new UsageError(`unknown command "${cmd}" (try: help)`);
  await fn(rest);
}

main().then(() => {
  if (process.argv[2] !== '_broker') process.exit(process.exitCode || 0);
}, (e) => {
  if (e instanceof UsageError) { process.stderr.write('agy-dispatch: ' + e.message + '\n'); process.exit(64); }
  process.stderr.write('agy-dispatch: ' + (e.stack || e) + '\n');
  process.exit(1);
});
