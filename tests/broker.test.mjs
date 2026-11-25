import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'scripts', 'agy.mjs');
const FAKE = path.join(here, 'fake-agy.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agyd-test-'));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'agyd-ws-'));
const env = { ...process.env, AGY_DISPATCH_HOME: HOME, AGY_DISPATCH_AGY_CMD: JSON.stringify([process.execPath, FAKE]) };

function cli(args, { input, extraEnv } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...extraEnv }, input, encoding: 'utf8', cwd: WS, timeout: 60000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const idOf = (out) => (out.match(/started (\S+)/) || [])[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function state(id) { return JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', id, 'state.json'), 'utf8')); }
async function until(pred, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return false; }

test('one-shot run returns the reply and stops the session; unicode and quotes survive', () => {
  const task = 'normal 中文 "quoted" -dash\nline2';
  const r = cli(['run', '--write', '-'], { input: task });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /hello world: normal 中文 "quoted" -dash\nline2/);
  assert.match(r.out, /stopped; resume anytime/);
});

test('start → watch --until turn → send mid-turn → result → stop', async () => {
  const s = cli(['start', '--write', '--', 'slow']);
  const id = idOf(s.out);
  assert.ok(id, s.out);
  const m = cli(['send', id, '--', 'steer this']);
  assert.match(m.out, /added to the running turn|turn \d+ started/, m.out);
  const w = cli(['watch', id, '--until', 'turn', '--all']);
  assert.match(w.out, /turn 1 finished/);
  const res = cli(['result', id]);
  assert.match(res.out, /got mid-turn: steer this/);
  const st = cli(['stop', id]);
  assert.match(st.out, /stopped/);
  assert.equal(state(id).status, 'stopped');
});

test('send resumes a stopped session via session/load without replaying history into the turn', async () => {
  const s = cli(['start', '--write', '--', 'normal first']);
  const id = idOf(s.out);
  cli(['wait', id]);
  cli(['stop', id]);
  const r = cli(['send', id, '--', 'normal second']);
  assert.match(r.out, /session resumed/, r.out);
  const w = cli(['wait', id]);
  assert.match(w.out, /world: normal second/);
  assert.doesNotMatch(w.out, /REPLAYED HISTORY/);
  cli(['stop', id]);
});

test('watchdog: silent turn is cancelled, stuck agy is killed and the conversation reloaded', async () => {
  const s = cli(['start', '--write', '--idle-timeout', '2s', '--cancel-grace', '2s', '--', 'hang']);
  const id = idOf(s.out);
  assert.ok(id, s.out);
  const w = cli(['watch', id, '--until', 'turn', '--all']);
  assert.match(w.out, /STALL: no activity/);
  assert.match(w.out, /KILLED agy/);
  assert.ok(await until(() => state(id).status === 'idle'), 'should recover to idle');
  const log = cli(['log', id]).out;
  assert.match(log, /recovered/);
  const r = cli(['send', id, '--', 'normal after recovery']);
  assert.match(r.out, /sent to/);
  assert.match(cli(['wait', id]).out, /world: normal after recovery/);
  cli(['stop', id]);
});

test('send --interrupt cancels the running turn and starts a new one', async () => {
  const id = idOf(cli(['start', '--write', '--', 'slow']).out);
  const r = cli(['send', id, '--interrupt', '--', 'normal interrupted']);
  assert.match(r.out, /turn 2 started/, r.out);
  assert.equal(JSON.parse(cli(['result', id, '--turn', '1', '--json']).out).record.stopReason, 'cancelled');
  assert.match(cli(['wait', id]).out, /world: normal interrupted/);
  cli(['stop', id]);
});

test('cancel stops a running turn but keeps the session', async () => {
  const id = idOf(cli(['start', '--write', '--', 'hang-cancellable']).out);
  const c = cli(['cancel', id]);
  assert.match(c.out, /cancel sent/);
  const w = cli(['wait', id]);
  assert.match(w.out, /cancelled/);
  assert.equal(state(id).status, 'idle');
  cli(['stop', id]);
});

test('approval requests surface to the caller and can be answered', async () => {
  const id = idOf(cli(['start', '--write', '--', 'permission']).out);
  const w1 = cli(['wait', id]);
  assert.equal(w1.code, 3, w1.out);
  assert.match(w1.out, /APPROVAL #1 needed: rm -rf build/);
  const a = cli(['answer', id, '1', 'deny']);
  assert.match(a.out, /answered #1: deny/);
  const w2 = cli(['wait', id]);
  assert.match(w2.out, /"optionId":"reject"/);
  cli(['stop', id]);
});

test('unanswered approval is auto-denied after --ask-timeout', async () => {
  const id = idOf(cli(['start', '--write', '--ask-timeout', '2s', '--', 'permission']).out);
  await until(() => state(id).status === 'needs_input');
  const w = cli(['watch', id, '--until', 'turn', '--all']);
  assert.match(w.out, /APPROVAL #1/);
  assert.ok(await until(() => state(id).status !== 'needs_input', 10000), 'timeout should resolve the approval');
  const w2 = cli(['wait', id]);
  assert.match(w2.out, /"optionId":"reject"/);
  assert.match(cli(['log', id]).out, /not answered in time/);
  cli(['stop', id]);
});

test('read-only session: approvals denied by policy and workspace writes cancel the turn', async () => {
  const id = idOf(cli(['start', '--', 'write']).out);
  const w = cli(['wait', id]);
  assert.match(w.out, /read-only violation/);
  const id2 = idOf(cli(['start', '--', 'permission']).out);
  const w2 = cli(['wait', id2]);
  assert.match(w2.out, /"optionId":"reject"/);
  assert.match(w2.out, /continued read-only/, 'a denial should nudge agy to carry on');
  const id3 = idOf(cli(['start', '--', 'rocmd']).out);
  const w3 = cli(['wait', id3]);
  assert.match(w3.out, /ls=allow rm=reject saw-note=true/);
  cli(['stop', '--all']);
});

test('agy crash mid-turn: turn ends, broker restarts agy and reloads the conversation', async () => {
  const id = idOf(cli(['start', '--write', '--', 'crash']).out);
  const w = cli(['watch', id, '--until', 'turn', '--all']);
  assert.match(w.out, /agy process exited \(code 3\)/);
  assert.ok(await until(() => state(id).status === 'idle'));
  assert.match(cli(['log', id]).out, /recovered/);
  cli(['stop', id]);
});

test('questions from agy end the turn and are shown with a reply hint', () => {
  const r = cli(['run', '--write', '--', 'ask']);
  assert.match(r.out, /agy is asking:/);
  assert.match(r.out, /Favorite color\? +\[red \| blue\]/);
  assert.match(r.out, /session \S+ kept/);
  cli(['stop', '--all']);
});

test('sign-in failure is reported fast with a hint, not a hang', () => {
  const t0 = Date.now();
  const r = cli(['start', '--', 'normal'], { extraEnv: { FAKE_AUTH_FAIL: '1' } });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /not signed in/);
  assert.ok(Date.now() - t0 < 15000);
});

test('idle sessions park themselves and resume on send', async () => {
  const id = idOf(cli(['start', '--write', '--idle-exit', '2s', '--', 'normal x']).out);
  assert.ok(await until(() => state(id).status === 'parked', 15000), 'should park');
  const r = cli(['send', id, '--', 'normal again']);
  assert.match(r.out, /session resumed/);
  assert.match(cli(['wait', id]).out, /world: normal again/);
  cli(['stop', id]);
});

test('usage errors exit 64', () => {
  assert.equal(cli(['start', '--mode', 'auto', '--', 'x']).code, 64);
  assert.equal(cli(['bogus']).code, 64);
  assert.equal(cli(['start', '--host', 'nope', '--', 'x']).code, 64);
});

test.after(() => { cli(['stop', '--all']); });
