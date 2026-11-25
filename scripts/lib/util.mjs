import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';

export class UsageError extends Error {}

// Minimal flag parser: --name value, --name=value, booleans, repeatable lists, "--" ends flags.
export function parseArgs(argv, spec = {}) {
  const flags = spec.flags || {};
  const out = { _: [] };
  for (const [k, t] of Object.entries(flags)) if (t === 'list') out[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-') || /^-\d/.test(a)) { out._.push(a); continue; }
    let name = a.replace(/^--?/, '');
    let val;
    const eq = name.indexOf('=');
    if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
    name = (spec.aliases && spec.aliases[name]) || name;
    const type = flags[name];
    if (!type) throw new UsageError(`unknown option ${a}`);
    if (type === 'bool') { out[name] = val === undefined ? true : !/^(0|false|no|off)$/i.test(val); continue; }
    if (val === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      val = argv[++i];
    }
    if (type === 'list') out[name].push(val); else out[name] = val;
  }
  return out;
}

export function parseDuration(v, def) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'number') return v;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!m) throw new UsageError(`bad duration "${v}" (use 90s, 10m, 2h)`);
  const unit = (m[2] || 's').toLowerCase();
  return Math.round(parseFloat(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit]);
}

export function fmtDur(ms) {
  if (ms == null || !isFinite(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

export function fmtAgo(ts) { return ts ? fmtDur(Date.now() - ts) + ' ago' : '-'; }

export const posixQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
export const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// JSON with every non-ASCII code unit escaped, so nothing on the wire depends on a code page.
export function jsonAscii(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function oneLine(s, max = 240) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function randomId(n = 5) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(n);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return;
  if (IS_WIN) { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; }
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + randomId(4) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 20 || !IS_WIN) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      const until = Date.now() + 25; while (Date.now() < until) {}
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
