import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { hostsFile } from './store.mjs';
import { IS_WIN, UsageError, posixQuote, psQuote, readJson, writeJsonAtomic } from './util.mjs';

export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];
export const CWD_MARK = 'AGY_DISPATCH_CWD=';
export const PID_MARK = 'AGY_DISPATCH_PID=';

export function loadHosts() {
  const cfg = readJson(hostsFile(), null) || {};
  return { hosts: cfg.hosts || {} };
}
export function saveHosts(cfg) { writeJsonAtomic(hostsFile(), cfg); }

export function localHost() {
  const cfg = loadHosts();
  return { name: 'local', local: true, os: IS_WIN ? 'windows' : 'posix', ...(cfg.hosts.local || {}) };
}

export function getHost(name) {
  if (!name || name === 'local') return localHost();
  const cfg = loadHosts();
  const h = cfg.hosts[name];
  if (!h) {
    const known = ['local', ...Object.keys(cfg.hosts)].join(', ');
    throw new UsageError(`unknown host "${name}" (known: ${known}). Add one with: hosts add ${name} --ssh <ssh-alias>`);
  }
  return { name, ...h };
}

export function listHosts() {
  const cfg = loadHosts();
  return [localHost(), ...Object.entries(cfg.hosts).filter(([n]) => n !== 'local').map(([name, h]) => ({ name, ...h }))];
}

function posixCd(cwd) {
  if (!cwd || cwd === '~') return 'cd';
  if (cwd.startsWith('~/')) return 'cd "$HOME"/' + posixQuote(cwd.slice(2));
  return 'cd ' + posixQuote(cwd);
}
function posixExe(p) {
  if (p.startsWith('~/')) return '"$HOME"/' + posixQuote(p.slice(2));
  return posixQuote(p);
}
function psPath(p) {
  if (!p || p === '~') return '$HOME';
  if (/^~[\\/]/.test(p)) return '(Join-Path $HOME ' + psQuote(p.slice(2)) + ')';
  return psQuote(p);
}

// How to start "agy <args>" on a host. Remote commands report the resolved working directory on
// stderr (CWD_MARK) before exec'ing agy, so the broker learns the absolute path ACP needs.
export function agySpawnSpec(host, agyArgs, cwd) {
  if (host.local) {
    const override = process.env.AGY_DISPATCH_AGY_CMD ? JSON.parse(process.env.AGY_DISPATCH_AGY_CMD) : null;
    const base = override || [host.agy || 'agy'];
    return { cmd: base[0], args: [...base.slice(1), ...agyArgs], cwd };
  }
  if (!host.ssh) throw new UsageError(`host "${host.name}" has no ssh alias`);
  const ssh = ['-T', ...SSH_OPTS, ...(host.sshOptions || []), host.ssh];
  const agy = host.agy || 'agy';
  if (host.os === 'windows') {
    const script = [
      'Set-Location -LiteralPath ' + psPath(cwd) + ' -ErrorAction Stop',
      "[Console]::Error.WriteLine('" + CWD_MARK + "' + (Get-Location).Path)",
      "[Console]::Error.WriteLine('" + PID_MARK + "' + $PID)",
      '& ' + psQuote(agy) + ' ' + agyArgs.map(psQuote).join(' '),
      'exit $LASTEXITCODE',
    ].join('; ');
    return { cmd: 'ssh', args: [...ssh, script], remote: true };
  }
  const script = posixCd(cwd) + ' && printf ' + posixQuote(CWD_MARK + '%s\\n') + ' "$(pwd)" >&2 && printf ' + posixQuote(PID_MARK + '%s\\n') + ' "$$" >&2 && exec ' + posixExe(agy) + ' ' + agyArgs.map(posixQuote).join(' ');
  return { cmd: 'ssh', args: [...ssh, script], remote: true };
}

// Run a short command (on a host) and capture output, with a hard timeout.
export function runCapture(cmd, args, { timeoutMs = 30000, input, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ code: 127, out: '', err: String(e.message || e) }); }
    const t = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch {} resolve({ code: null, out, err: err + '\n[timed out]', timedOut: true }); } }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(t); resolve({ code: 127, out, err: err + String(e.message || e) }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

export function sshCapture(host, script, opts) {
  return runCapture('ssh', ['-T', ...SSH_OPTS, ...(host.sshOptions || []), host.ssh, script], opts);
}

// Work out OS and agy location for an ssh alias.
export async function probeSsh(alias, sshOptions = []) {
  const h = { ssh: alias, sshOptions };
  const r = await sshCapture(h, 'uname -s', { timeoutMs: 25000 });
  if (r.code === 255 || r.timedOut) return { ok: false, error: (r.err || 'ssh failed').trim().split('\n').slice(-2).join(' ') };
  if (r.code === 0 && /^(Linux|Darwin|FreeBSD)/m.test(r.out)) {
    const find = await sshCapture(h, 'p=$(command -v agy 2>/dev/null || true); [ -z "$p" ] && [ -x "$HOME/.local/bin/agy" ] && p="$HOME/.local/bin/agy"; [ -z "$p" ] && p=$("$SHELL" -lc "command -v agy" 2>/dev/null || true); echo "AGY=$p"; [ -n "$p" ] && "$p" --version 2>/dev/null | head -1', { timeoutMs: 25000 });
    const agy = (find.out.match(/^AGY=(.*)$/m) || [])[1]?.trim() || '';
    const version = find.out.split('\n').filter((l) => l && !l.startsWith('AGY='))[0]?.trim() || '';
    return { ok: true, os: 'posix', uname: r.out.trim(), agy, version };
  }
  const w = await sshCapture(h, '$c = Get-Command agy -ErrorAction SilentlyContinue; if ($c) { "AGY=" + $c.Source; & $c.Source --version } else { "AGY=" }', { timeoutMs: 25000 });
  if (/AGY=/.test(w.out)) {
    const agy = (w.out.match(/AGY=(.*)/) || [])[1]?.trim() || '';
    const version = w.out.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('AGY='))[0]?.trim() || '';
    return { ok: true, os: 'windows', agy, version };
  }
  return { ok: false, error: 'could not detect remote OS: ' + (r.err || r.out).trim().slice(0, 200) };
}

// Is agy signed in on the host? "agy models" fails fast with "Please sign in" when not.
export async function authCheck(host) {
  let r;
  if (host.local) {
    const spec = agySpawnSpec(host, ['models'], process.cwd());
    r = await runCapture(spec.cmd, spec.args, { timeoutMs: 45000 });
  } else if (host.os === 'windows') {
    r = await sshCapture(host, '& ' + psQuote(host.agy || 'agy') + ' models 2>&1 | ForEach-Object { "$_" }; exit $LASTEXITCODE', { timeoutMs: 60000 });
  } else {
    r = await sshCapture(host, 'exec ' + posixExe(host.agy || 'agy') + ' models', { timeoutMs: 60000 });
  }
  const text = (r.out + '\n' + r.err);
  if (/sign in|Authentication required|log in/i.test(text)) return { signedIn: false, detail: 'not signed in' };
  if (r.timedOut) return { signedIn: null, detail: 'timed out' };
  if (r.code === 0) return { signedIn: true, models: text.split(/\r?\n/).filter((l) => /\t/.test(l)).map((l) => l.split('\t')[0].trim()) };
  return { signedIn: null, detail: text.trim().split(/\r?\n/).slice(-1)[0] || 'exit ' + r.code };
}

export function loginHint(host) {
  if (host.local) return 'run: agy   (sign in once in the TUI)';
  return `run in Claude Code:  ! ssh -t ${host.ssh} ${host.os === 'windows' ? 'agy' : posixExe(host.agy || 'agy')}   (sign in once; the token is kept for later SSH sessions)`;
}
