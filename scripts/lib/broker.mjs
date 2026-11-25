import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Session } from './store.mjs';
import { getHost, agySpawnSpec, sshCapture, loginHint, writeLocalRoProfile, CWD_MARK, PID_MARK, RO_PROFILE } from './hosts.mjs';
import { Rpc } from './acp.mjs';
import { IS_WIN, killTree, oneLine, fmtDur, sleep, isAlive } from './util.mjs';

export const VERSION = '0.4.0';
const RO_NOTE = '[agy-dispatch: this session is read-only. Editing files is denied. Shell commands are allowed only if they are plain read-only ones (ls, cat, rg/grep, git status/diff/log/show), one per call, without &&, ;, | or redirection; anything else is denied. Work with read-only tools and say what you would change instead of changing it.]';
const RO_CONTINUE = '[agy-dispatch: that action was denied because this session is read-only. Carry on with read-only tools (file viewing and search; plain read-only shell commands one per call, without &&, ;, | or redirection), then give your answer, including what you could not do.]';
const RAW_CAP = 20 * 1024 * 1024;
const AGY_PRIVATE = /[\\/]\.gemini[\\/]antigravity-cli[\\/]/i; // plan/brain artifacts agy keeps for itself
const AUTH_RE = /Authentication required|Please visit the URL to log in|paste the authorization code|Please sign in/i;

function summarizeArgs(a) {
  if (!a || typeof a !== 'object') return '';
  const v = a.CommandLine || a.Command || a.Path || a.TargetFile || a.AbsolutePath || a.Query || a.Url || a.SearchPath || a.DirectoryPath || Object.values(a).find((x) => typeof x === 'string');
  return oneLine(v || '', 160);
}

// Commands a read-only session may run: one plain command, no shell operators, from a short list.
const SAFE_CMD = /^(ls|pwd|cat|head|tail|wc|stat|file|tree|du|df|which|whoami|uname|date|echo|rg|grep|egrep|fgrep|dir|type|Get-ChildItem|Get-Content|Get-Location|Select-String|git (status|diff|log|show|blame|branch|ls-files|rev-parse|grep|remote -v|config --get|describe|shortlog))(\s|$)/;
const SHELL_META = /[;&|<>`$(){}\n\r]/;
export function isSafeReadCommand(cmd) {
  const c = String(cmd || '').trim();
  if (!c || SHELL_META.test(c)) return false;
  if (/\s-(delete|exec|execdir|ok|fprint\S*)\b|\s--output(=|\s)|\s-o\s|\s--pre(-glob)?(=|\s)|\s-O\b|--open-files-in-pager|\s--ext-diff\b/.test(c)) return false;
  if (/^git branch\b/.test(c) && !/^git branch(\s+(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--contains\s+\S+|--merged|--no-merged))*\s*$/.test(c)) return false;
  return SAFE_CMD.test(c);
}

function isWorkspaceWrite(u) {
  if (!['edit', 'delete', 'move'].includes(u.kind)) return false;
  const a = u.rawInput || u.args || {};
  const paths = [...(u.locations || []).map((l) => l.path), a.Path, a.TargetFile, a.AbsolutePath].filter(Boolean);
  if (!paths.length) return true;
  return paths.some((p) => !AGY_PRIVATE.test(p));
}

export async function runBroker(id) {
  const s = new Session(id);
  const lockFile = s.f('broker.lock');
  try {
    const fd = fs.openSync(lockFile, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
  } catch {
    const other = Number(fs.readFileSync(lockFile, 'utf8')) || 0;
    if (other && other !== process.pid && isAlive(other)) return; // another broker owns this session
    fs.writeFileSync(lockFile, String(process.pid));
  }
  const releaseLock = () => { try { if (Number(fs.readFileSync(lockFile, 'utf8')) === process.pid) fs.unlinkSync(lockFile); } catch {} };
  process.on('exit', releaseLock);

  let meta = s.meta();
  const host = getHost(meta.host);
  const L = meta.limits;
  const prev = s.state();

  let status = 'starting';
  let turn = prev.turn || 0;
  let agySid = meta.agySessionId || null;
  let cwd = meta.cwdResolved || null;
  let child = null, rpc = null, childExited = true, remotePid = null, authProblem = false;
  let stderrTail = '';
  let rawBytes = 0;
  let inflight = 0;
  let turnStartedAt = 0, turnText = '', turnPrompts = [], lastStop = prev.lastStop || null, lastUsage = null, turnQuestion = null, turnNotes = [];
  let pendingText = '', pendingSince = 0;
  let lastActivity = Date.now(), lastBusyAt = Date.now(), lastHeartbeat = 0;
  let cancelAt = 0, killing = false, stopping = false, processing = false, replaying = false;
  let restarts = 0, connectGen = 0, reqNo = prev.reqNo || 0;
  let orphanPid = prev.remotePid || null; // from an earlier broker of this session
  let lastTick = Date.now();
  let deniedThisTurn = 0, nudged = false;
  const tools = new Map();
  const reqs = new Map();
  const queue = [];

  const ev = (type, data = {}) => { try { s.appendEvent({ t: Date.now(), type, turn, ...data }); } catch {} };
  const save = (patch = {}) => {
    lastHeartbeat = Date.now();
    try {
      s.setState({
        status, turn, brokerPid: process.pid, heartbeatAt: lastHeartbeat, agySessionId: agySid, inflight, reqNo,
        pending: [...reqs.entries()].map(([n, r]) => ({ req: n, title: r.title, at: r.at })),
        activeTool: [...tools.values()].at(-1) || null, lastActivity, ...patch,
      });
    } catch (e) { s.log('state write failed: ' + e.message); }
  };
  const raw = (dir, line) => {
    if (rawBytes > RAW_CAP) return;
    rawBytes += line.length + 3;
    try { fs.appendFileSync(s.f('raw.ndjson'), dir + ' ' + line + '\n'); } catch {}
  };
  const flushText = () => {
    if (pendingText.trim()) ev('text', { text: pendingText });
    pendingText = ''; pendingSince = 0;
  };
  const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await sleep(100); return pred(); };
  const sel = (o) => ({ outcome: { outcome: 'selected', optionId: o.optionId } });

  async function killOrphan() {
    const pid = orphanPid;
    orphanPid = null;
    if (!pid || host.local || !host.ssh) return;
    const script = host.os === 'windows' ? `taskkill /PID ${pid} /T /F 2>&1 | Out-Null` : `kill -9 -- -${pid} 2>/dev/null || kill -9 ${pid} 2>/dev/null; true`;
    try { await sshCapture(host, script, { timeoutMs: 20000 }); s.log('killed orphan remote pid ' + pid); } catch {}
  }

  function killChild() {
    const c = child;
    if (!c || childExited) return;
    if (remotePid && host.ssh) {
      const script = host.os === 'windows' ? `taskkill /PID ${remotePid} /T /F` : `kill -9 -- -${remotePid} 2>/dev/null || kill -9 ${remotePid} 2>/dev/null; true`;
      sshCapture(host, script, { timeoutMs: 20000 }).catch(() => {});
    }
    try { killTree(c.pid, 'SIGKILL'); } catch {}
  }

  async function connect(resume) {
    const gen = ++connectGen;
    const agyArgs = ['acp'];
    if (meta.sandbox) agyArgs.push('--sandbox');
    if (meta.yolo) agyArgs.push('--dangerously-skip-permissions');
    for (const d of meta.addDirs || []) agyArgs.push('--add-dir', d);
    if (meta.readOnly) {
      agyArgs.push('--cli_dir_name', RO_PROFILE);
      if (host.local) writeLocalRoProfile();
    }
    const spec = agySpawnSpec(host, agyArgs, meta.cwd, { roProfile: !!meta.readOnly });
    s.log(`spawn ${spec.cmd} ${JSON.stringify(spec.args)}`);
    let gotCwd;
    const cwdKnown = new Promise((r) => (gotCwd = r));
    if (!spec.remote) gotCwd(spec.cwd);
    authProblem = false; remotePid = null; stderrTail = '';
    const c = spawn(spec.cmd, spec.args, { cwd: spec.remote ? undefined : spec.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !IS_WIN });
    child = c; childExited = false;
    c.on('error', (e) => { stderrTail += '\nspawn error: ' + e.message; });
    c.stderr.setEncoding('utf8');
    c.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-4000);
      s.log('[agy stderr] ' + d.trimEnd());
      const m = d.match(new RegExp(CWD_MARK + '(.+)'));
      if (m) gotCwd(m[1].trim());
      const p = d.match(new RegExp(PID_MARK + '(\\d+)'));
      if (p) { remotePid = Number(p[1]); save({ remotePid }); }
      if (AUTH_RE.test(d)) authProblem = true;
    });
    c.on('exit', (code, signal) => { if (child === c) childExited = true; onExit(gen, code, signal); });
    const r = new Rpc(c.stdin, c.stdout, { onRaw: raw });
    rpc = r;
    r.on('activity', () => { lastActivity = Date.now(); });
    r.on('notification', onNotification);
    r.on('request', onRequest);
    r.on('garbage', (line) => { s.log('[non-json] ' + line.slice(0, 500)); if (AUTH_RE.test(line)) authProblem = true; });

    await r.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agy-dispatch', version: VERSION },
    }, L.startup);
    const resolved = await Promise.race([cwdKnown, sleep(8000).then(() => null)]);
    if (resolved) cwd = resolved;
    if (!cwd) throw new Error('could not learn the remote working directory');
    if (resume && agySid) {
      replaying = true;
      try { await r.call('session/load', { sessionId: agySid, cwd, mcpServers: [] }, Math.max(L.startup, 180000)); }
      finally { replaying = false; }
    } else {
      const res = await r.call('session/new', { cwd, mcpServers: [] }, L.startup);
      agySid = res.sessionId;
      meta = s.setMeta({ agySessionId: agySid, cwdResolved: cwd, models: (res.models?.availableModels || []).map((m) => m.modelId) });
    }
    if (meta.model) {
      try { await r.call('session/set_model', { sessionId: agySid, modelId: meta.model }, 30000); }
      catch (e) { ev('warn', { message: `model "${meta.model}" rejected: ${e.message}` }); }
    }
    if (meta.mode) {
      try { await r.call('session/set_mode', { sessionId: agySid, modeId: meta.mode }, 30000); }
      catch (e) { ev('warn', { message: `mode "${meta.mode}" rejected: ${e.message}` }); }
    }
  }

  function onExit(gen, code, signal) {
    if (gen !== connectGen) return;
    orphanPid = remotePid; // the remote agy may outlive a dropped SSH link; killed before reconnecting
    const tail = oneLine(stderrTail.split('\n').filter((l) => !l.includes(CWD_MARK) && !l.includes(PID_MARK)).slice(-4).join(' | '), 400);
    try { rpc?.close(`agy exited (code ${code}${signal ? ', ' + signal : ''})`); } catch {}
    if (stopping || status === 'starting' || status === 'recovering') return;
    ev('agent_exit', { code, signal, stderr: tail });
    setImmediate(() => recover(`agy exited (code ${code}${signal ? ', ' + signal : ''})`));
  }

  async function recover(reason) {
    if (stopping) return;
    await waitFor(() => inflight === 0, 3000);
    if (!agySid || restarts >= L.maxRestarts) {
      status = 'dead'; save({ error: reason }); ev('dead', { reason: reason + (restarts ? ` after ${restarts} restart(s)` : '') });
      setTimeout(() => process.exit(1), 200);
      return;
    }
    restarts++;
    status = 'recovering'; save();
    await killOrphan();
    ev('recovering', { attempt: restarts, reason });
    try {
      await connect(true);
      status = 'idle'; cancelAt = 0; killing = false; lastBusyAt = Date.now(); save({ error: null });
      ev('recovered', { attempt: restarts });
      processQueue();
    } catch (e) {
      killChild();
      status = 'dead'; save({ error: e.message }); ev('dead', { reason: 'could not reload the conversation: ' + e.message });
      setTimeout(() => process.exit(1), 200);
    }
  }

  function startPrompt(text, cmdId) {
    const fresh = inflight === 0;
    if (fresh) {
      turn++; turnStartedAt = Date.now(); turnText = ''; turnPrompts = []; lastStop = null; lastUsage = null;
      turnQuestion = null; turnNotes = []; cancelAt = 0; killing = false; lastActivity = Date.now();
      deniedThisTurn = 0; nudged = false;
      status = 'running';
      ev('turn_start');
    }
    turnPrompts.push(text);
    save();
    ev('user', { text, cmdId, injected: !fresh });
    const wire = meta.readOnly && !meta.roNoted ? RO_NOTE + '\n\n' + text : text;
    if (meta.readOnly && !meta.roNoted) meta = s.setMeta({ roNoted: true });
    sendPrompt(wire);
  }

  function sendPrompt(text) {
    inflight++;
    save();
    rpc.call('session/prompt', { sessionId: agySid, prompt: [{ type: 'text', text }] })
      .then((r) => { lastStop = r?.stopReason || 'end_turn'; if (r?.usage) lastUsage = r.usage; return false; },
        (e) => { lastStop = e.closed ? 'agent_exited' : 'error'; turnNotes.push('prompt failed: ' + e.message); if (!e.closed) ev('error', { message: e.message }); return !!e.closed; })
      .then(async (closed) => {
        if (closed) await waitFor(() => childExited, 2000); // let agent_exit (with the exit code) land before turn_end
        inflight--;
        if (inflight > 0) { save(); return; }
        // agy stops its turn when an action is denied; in a read-only session nudge it once to carry on.
        if (meta.readOnly && deniedThisTurn && !nudged && !cancelAt && lastStop === 'end_turn' && !stopping && rpc && !rpc.closed) {
          nudged = true;
          turnNotes.push('nudged agy to continue read-only after a denial');
          ev('nudge', { denied: deniedThisTurn });
          sendPrompt(RO_CONTINUE);
          return;
        }
        endTurn();
      });
  }

  function endTurn() {
    flushText();
    const now = Date.now();
    if (cancelAt && lastStop === 'end_turn') lastStop = 'cancelled';
    s.writeTurn(turn, { turn, prompts: turnPrompts, reply: turnText, stopReason: lastStop, usage: lastUsage, question: turnQuestion, notes: turnNotes, startedAt: turnStartedAt, endedAt: now });
    tools.clear();
    for (const [, r] of reqs) { try { rpc.respond(r.rpcId, { outcome: { outcome: 'cancelled' } }); } catch {} }
    reqs.clear();
    cancelAt = 0; killing = false;
    if (status === 'running' || status === 'needs_input') status = 'idle';
    lastBusyAt = now;
    save({ lastStop, lastTurnEndedAt: now, question: turnQuestion });
    ev('turn_end', { stopReason: lastStop, ms: now - turnStartedAt, chars: turnText.length, question: turnQuestion, notes: turnNotes, usage: lastUsage });
    setImmediate(processQueue);
  }

  function cancel(reason) {
    if (!rpc || !agySid) return;
    rpc.notify('session/cancel', { sessionId: agySid });
    for (const [, r] of reqs) rpc.respond(r.rpcId, r.generic ? { cancelled: true } : { outcome: { outcome: 'cancelled' } });
    reqs.clear();
    if (status === 'needs_input') status = 'running';
    if (!cancelAt) cancelAt = Date.now();
    turnNotes.push('cancelled: ' + reason);
    ev('cancel', { reason });
    save();
  }

  function onNotification(method, params) {
    if (method !== 'session/update' || replaying) return;
    const u = params.update || {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = u.content && u.content.type === 'text' ? u.content.text : '';
        if (t) { turnText += t; pendingText += t; if (!pendingSince) pendingSince = Date.now(); }
        break;
      }
      case 'tool_call': {
        flushText();
        const a = u.rawInput || u.args || {};
        const name = u.name || u.kind || 'tool';
        if (name === 'update_steps') {
          if (Array.isArray(a.steps)) ev('steps', { steps: a.steps.map((x) => ({ title: x.title, status: x.status })) });
          break;
        }
        if (name === 'ask_question') { turnQuestion = a.questions || []; ev('question', { questions: turnQuestion }); break; }
        tools.set(u.toolCallId, { name, title: oneLine(u.title || summarizeArgs(a), 200), kind: u.kind, startedAt: Date.now() });
        ev('tool', { id: u.toolCallId, name, kind: u.kind, title: oneLine(u.title || summarizeArgs(a), 200) });
        save();
        break;
      }
      case 'tool_call_update': {
        if (u.status === 'completed' || u.status === 'failed') {
          const t = tools.get(u.toolCallId);
          if (t) {
            tools.delete(u.toolCallId);
            // The profile makes agy ask before writing and the broker denies it; a write that still
            // completes means the guard failed, so stop the turn.
            if (meta.readOnly && u.status === 'completed' && isWorkspaceWrite({ kind: u.kind || t.kind, locations: u.locations, rawInput: u.rawInput || u.args })) {
              turnNotes.push(`read-only violation: ${t.name} ${t.title}`);
              ev('violation', { name: t.name, title: t.title });
              cancel('read-only session completed a write');
            }
            const exit = u.rawOutput && u.rawOutput.exit_code;
            ev('tool_done', { id: u.toolCallId, name: t.name, title: t.title, ok: u.status === 'completed' && !exit, exit, ms: Date.now() - t.startedAt });
          }
        }
        break;
      }
      case 'plan':
        ev('steps', { steps: (u.entries || []).map((e) => ({ title: e.content, status: e.status })) });
        break;
      case 'session_info_update':
        if (u.title) { save({ title: u.title }); ev('title', { title: u.title }); }
        break;
      case 'current_mode_update':
        save({ mode: u.currentModeId });
        break;
      case 'usage_update':
        if (u.size) save({ context: { used: u.used, size: u.size } });
        break;
      default:
        break;
    }
  }

  function onRequest(rpcId, method, params) {
    if (method === 'session/request_permission') {
      const opts = params.options || [];
      const tc = params.toolCall || {};
      const title = oneLine(tc.title || summarizeArgs(tc.rawInput) || tc.name || 'permission', 200);
      const pick = (...kinds) => kinds.map((k) => opts.find((o) => o.kind === k)).find(Boolean);
      if (meta.readOnly) {
        const a = tc.rawInput || tc.args || {};
        const cmd = a.CommandLine || a.Command;
        const readish = tc.kind === 'read' || tc.kind === 'search' || tc.kind === 'fetch';
        if ((tc.kind === 'execute' && isSafeReadCommand(cmd)) || readish) {
          const o = pick('allow_once') || opts.find((x) => x.kind && x.kind.startsWith('allow'));
          if (o) { rpc.respond(rpcId, sel(o)); ev('permission_auto', { title, option: o.optionId }); return; }
        }
        const o = pick('reject_once', 'reject_always');
        rpc.respond(rpcId, o ? sel(o) : { outcome: { outcome: 'cancelled' } });
        turnNotes.push('read-only: denied ' + title);
        deniedThisTurn++;
        ev('permission_denied', { title: title + ' (read-only)' });
        return;
      }
      const policy = meta.approve;
      if (policy === 'auto') {
        const o = pick('allow_once', 'allow_always') || opts[0];
        rpc.respond(rpcId, o ? sel(o) : { outcome: { outcome: 'cancelled' } });
        ev('permission_auto', { title, option: o && o.optionId });
        return;
      }
      if (policy === 'deny') {
        const o = pick('reject_once', 'reject_always');
        rpc.respond(rpcId, o ? sel(o) : { outcome: { outcome: 'cancelled' } });
        turnNotes.push('denied: ' + title);
        ev('permission_denied', { title });
        return;
      }
      const n = ++reqNo;
      reqs.set(n, { rpcId, title, options: opts, at: Date.now() });
      status = 'needs_input'; save();
      ev('permission', { req: n, title, options: opts.map((o) => ({ id: o.optionId, kind: o.kind, name: o.name })), timeoutMs: L.ask });
      return;
    }
    if (method.startsWith('fs/') || method.startsWith('terminal/')) { rpc.respondError(rpcId, -32601, 'client does not provide ' + method); return; }
    const n = ++reqNo;
    reqs.set(n, { rpcId, title: method, generic: true, at: Date.now() });
    status = 'needs_input'; save();
    ev('request', { req: n, method, params: JSON.stringify(params).slice(0, 2000), timeoutMs: L.ask });
  }

  function answer(c) {
    const n = c.req != null && c.req !== '' ? Number(c.req) : (reqs.size === 1 ? [...reqs.keys()][0] : NaN);
    const r = reqs.get(n);
    if (!r) return { ok: false, error: reqs.size ? `no pending request #${c.req}; pending: ${[...reqs.keys()].join(', ')}` : 'nothing is waiting for an answer' };
    const v = String(c.value ?? '').trim();
    if (r.generic) {
      let result; try { result = JSON.parse(v); } catch { result = { answer: v }; }
      rpc.respond(r.rpcId, result);
    } else {
      const kinds = {
        allow: ['allow_once', 'allow_always'], yes: ['allow_once', 'allow_always'], approve: ['allow_once', 'allow_always'],
        always: ['allow_always', 'allow_once'], 'allow-always': ['allow_always', 'allow_once'],
        deny: ['reject_once', 'reject_always'], no: ['reject_once', 'reject_always'], reject: ['reject_once', 'reject_always'],
        'deny-always': ['reject_always', 'reject_once'],
      }[v.toLowerCase()];
      const o = kinds ? kinds.map((k) => r.options.find((x) => x.kind === k)).find(Boolean) : r.options.find((x) => x.optionId === v);
      if (o) rpc.respond(r.rpcId, sel(o));
      else if (v.toLowerCase() === 'cancel') rpc.respond(r.rpcId, { outcome: { outcome: 'cancelled' } });
      else return { ok: false, error: 'unknown choice; use allow, always, deny, cancel or one of: ' + r.options.map((x) => x.optionId).join(', ') };
    }
    reqs.delete(n);
    lastActivity = Date.now();
    if (!reqs.size && status === 'needs_input') status = 'running';
    save();
    ev('answered', { req: n, value: v.slice(0, 200) });
    return { ok: true };
  }

  async function shutdown(finalStatus, reason) {
    if (stopping) return;
    stopping = true;
    if (inflight > 0) { cancel('session ' + finalStatus); await waitFor(() => inflight === 0, 6000); }
    if (rpc && !rpc.closed && agySid) { try { await rpc.call('session/close', { sessionId: agySid }, 3000); } catch {} }
    try { child && child.stdin.end(); } catch {}
    await waitFor(() => childExited, 4000);
    if (!childExited) { killChild(); await waitFor(() => childExited, 3000); }
    status = finalStatus;
    save({ stoppedAt: Date.now(), stopReason: reason, activeTool: null, inflight: 0 });
    ev(finalStatus, { reason });
    setTimeout(() => process.exit(0), 100);
  }

  function handleControl(c) {
    let res = { ok: true };
    if (c.type === 'cancel') {
      if (inflight > 0) cancel(c.reason || 'cancel requested');
      else res = { ok: false, error: 'no turn is running' };
    } else if (c.type === 'answer') {
      res = answer(c);
    } else if (c.type === 'stop') {
      ev('ack', { cmdId: c.cmdId, ok: true });
      shutdown('stopped', c.reason || 'stop requested');
      return;
    } else {
      res = { ok: false, error: 'unknown command ' + c.type };
    }
    ev('ack', { cmdId: c.cmdId, ...res });
  }

  function processQueue() {
    if (processing || stopping) return;
    processing = true;
    try {
      while (queue.length && (status === 'idle' || status === 'running' || status === 'needs_input')) {
        const c = queue[0];
        if (c.interrupt && inflight > 0) {
          if (!c.cancelSent) { c.cancelSent = true; cancel('interrupted by a new message'); }
          break; // endTurn() calls back here once the turn is over
        }
        queue.shift();
        startPrompt(c.text, c.cmdId);
        ev('ack', { cmdId: c.cmdId, ok: true, turn, injected: inflight > 1 });
      }
    } finally { processing = false; }
  }

  function pollInbox() {
    if (stopping) return;
    for (const c of s.takeInbox()) {
      if (c.type === 'prompt') queue.push(c);
      else if (status === 'starting' || status === 'recovering') { if (c.type === 'stop') { stopping = false; shutdown('stopped', 'stop requested'); } else queue.push(c); }
      else handleControl(c);
    }
    if (status !== 'starting' && status !== 'recovering') {
      // control commands parked during startup/recovery
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].type !== 'prompt') handleControl(queue.splice(i, 1)[0]);
    }
    processQueue();
  }

  function tick() {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap > 15000) {
      // The machine slept (or the broker was frozen): don't count that time against agy.
      const shift = gap - 1000;
      lastActivity += shift; if (turnStartedAt) turnStartedAt += shift; if (cancelAt) cancelAt += shift;
      for (const r of reqs.values()) r.at += shift;
      s.log(`clock gap ${fmtDur(gap)}; watchdog timers shifted`);
    }
    if (pendingText && (now - pendingSince > 8000 || pendingText.length > 2000)) flushText();
    if (inflight > 0 && !stopping) {
      for (const [n, r] of reqs) {
        if (now - r.at > L.ask) {
          const o = r.generic ? null : r.options.find((x) => x.kind === 'reject_once') || r.options.find((x) => x.kind === 'reject_always');
          rpc.respond(r.rpcId, r.generic ? { cancelled: true } : o ? sel(o) : { outcome: { outcome: 'cancelled' } });
          reqs.delete(n);
          turnNotes.push(`approval #${n} timed out → denied: ${r.title}`);
          ev('permission_timeout', { req: n, title: r.title });
          lastActivity = now;
          if (!reqs.size && status === 'needs_input') status = 'running';
          save();
        }
      }
      if (!reqs.size && !cancelAt) {
        const idle = now - lastActivity;
        const limit = tools.size ? L.tool : L.idle;
        if (idle > limit) {
          const phase = tools.size ? 'tool ' + [...tools.values()].at(-1).name + ' running' : 'waiting on the model';
          ev('stall', { idleMs: idle, phase });
          cancel(`watchdog: no activity for ${fmtDur(idle)} (${phase})`);
        } else if (now - turnStartedAt > L.turn) {
          ev('turn_timeout', { ms: now - turnStartedAt });
          cancel('turn ran longer than ' + fmtDur(L.turn));
        }
      }
      if (cancelAt && !killing && now - cancelAt > L.cancelGrace) {
        killing = true;
        turnNotes.push('agy did not stop after cancel; process killed');
        ev('kill', { reason: `agy still busy ${fmtDur(now - cancelAt)} after cancel` });
        killChild();
      }
    } else if (status === 'idle' && !queue.length && !stopping && L.idleExit > 0 && now - lastBusyAt > L.idleExit) {
      shutdown('parked', 'idle for ' + fmtDur(now - lastBusyAt));
    }
    if (now - lastHeartbeat > 5000) save();
  }

  process.on('uncaughtException', (e) => {
    s.log('uncaught: ' + (e.stack || e));
    ev('error', { message: 'broker crashed: ' + e.message });
    status = 'dead'; save({ error: 'broker crashed: ' + e.message });
    killChild();
    setTimeout(() => process.exit(1), 200);
  });
  process.on('unhandledRejection', (e) => { s.log('unhandled rejection: ' + (e && e.stack || e)); });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) { try { process.on(sig, () => shutdown('stopped', sig)); } catch {} }

  save({ error: null });
  ev('broker_start', { pid: process.pid, resume: !!agySid });
  const resume = !!agySid;
  try {
    if (resume) await killOrphan();
    await connect(resume);
  } catch (e) {
    if (stopping) return;
    const auth = authProblem || AUTH_RE.test(e.message);
    const tail = oneLine(stderrTail.split('\n').filter((l) => !l.includes(CWD_MARK) && !l.includes(PID_MARK)).slice(-4).join(' | '), 400);
    const msg = auth
      ? `agy on "${host.name}" is not signed in. ${loginHint(host)}`
      : `${resume ? 'resume' : 'startup'} failed: ${e.message}${tail ? ' | ' + tail : ''}`;
    stopping = true;
    killChild();
    status = resume ? 'dead' : 'failed';
    save({ error: msg });
    ev(status === 'failed' ? 'failed' : 'dead', { message: msg, reason: msg, auth });
    setTimeout(() => process.exit(1), 300);
    return;
  }
  status = 'idle';
  lastBusyAt = Date.now();
  save({ cwd, startedAt: Date.now(), error: null });
  ev('ready', { agySessionId: agySid, cwd, resumed: resume, mode: meta.mode, model: meta.model || null, host: host.name });
  setInterval(pollInbox, 250);
  setInterval(tick, 1000);
  pollInbox();
}
