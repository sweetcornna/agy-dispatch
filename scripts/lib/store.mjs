import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic, randomId, UsageError, isAlive } from './util.mjs';

export function home() { return process.env.AGY_DISPATCH_HOME || path.join(os.homedir(), '.agy-dispatch'); }
export const sessionsDir = () => path.join(home(), 'sessions');
export const hostsFile = () => path.join(home(), 'hosts.json');

const LIVE = new Set(['starting', 'idle', 'running', 'needs_input', 'recovering']);
export const isLiveStatus = (s) => LIVE.has(s);

export class Session {
  constructor(id) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(String(id))) throw new UsageError(`bad session id "${id}"`);
    this.id = id;
    this.dir = path.join(sessionsDir(), id);
  }
  f(name) { return path.join(this.dir, name); }
  exists() { return fs.existsSync(this.f('meta.json')); }
  create(meta) {
    fs.mkdirSync(path.join(this.dir, 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'turns'), { recursive: true });
    writeJsonAtomic(this.f('meta.json'), meta);
    writeJsonAtomic(this.f('state.json'), { status: 'new', turn: 0, updatedAt: Date.now() });
  }
  meta() { const m = readJson(this.f('meta.json')); if (!m) throw new UsageError(`no session "${this.id}"`); return m; }
  setMeta(patch) { const m = { ...this.meta(), ...patch }; writeJsonAtomic(this.f('meta.json'), m); return m; }
  state() { return readJson(this.f('state.json'), {}) || {}; }
  setState(patch) { const s = { ...this.state(), ...patch, updatedAt: Date.now() }; writeJsonAtomic(this.f('state.json'), s); return s; }

  // Status as seen from outside: a live status whose broker is gone is reported as dead.
  effectiveState() {
    const st = this.state();
    if (isLiveStatus(st.status) && st.status !== 'starting') {
      const stale = st.heartbeatAt && Date.now() - st.heartbeatAt > 30000;
      if (!isAlive(st.brokerPid) || stale) return { ...st, status: 'dead', deadReason: 'broker gone' };
    }
    if (st.status === 'starting' && st.brokerPid && !isAlive(st.brokerPid)) return { ...st, status: 'dead', deadReason: 'broker gone during startup' };
    return st;
  }

  post(cmd) {
    const cmdId = Date.now().toString(36) + '-' + randomId(4);
    const dir = this.f('inbox');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, cmdId + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ ...cmd, cmdId, at: Date.now() }));
    fs.renameSync(tmp, path.join(dir, cmdId + '.json'));
    return cmdId;
  }
  pendingInbox() {
    try { return fs.readdirSync(this.f('inbox')).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  }
  takeInbox() {
    const out = [];
    for (const n of this.pendingInbox()) {
      const p = path.join(this.f('inbox'), n);
      try { out.push(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch {}
      try { fs.unlinkSync(p); } catch {}
    }
    return out;
  }

  appendEvent(ev) { fs.appendFileSync(this.f('events.ndjson'), JSON.stringify(ev) + '\n'); }
  readEvents(offset = 0) {
    let fd;
    try { fd = fs.openSync(this.f('events.ndjson'), 'r'); } catch { return { events: [], offset }; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return { events: [], offset };
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      const lastNl = buf.lastIndexOf(10);
      if (lastNl < 0) return { events: [], offset };
      const events = [];
      for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch {}
      }
      return { events, offset: offset + lastNl + 1 };
    } finally { fs.closeSync(fd); }
  }
  eventsSize() { try { return fs.statSync(this.f('events.ndjson')).size; } catch { return 0; } }

  writeTurn(n, rec) { writeJsonAtomic(path.join(this.dir, 'turns', n + '.json'), rec); }
  turn(n) { return readJson(path.join(this.dir, 'turns', n + '.json')); }
  log(line) { try { fs.appendFileSync(this.f('broker.log'), new Date().toISOString() + ' ' + line + '\n'); } catch {} }
}

export function listSessions() {
  let names = [];
  try { names = fs.readdirSync(sessionsDir()); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { const s = new Session(n); if (s.exists()) out.push(s); } catch {}
  }
  return out.sort((a, b) => (b.meta().createdAt || 0) - (a.meta().createdAt || 0));
}

export function newSessionId(hostName) {
  const base = String(hostName).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 's';
  for (;;) { const id = base + '-' + randomId(5); if (!new Session(id).exists()) return id; }
}
