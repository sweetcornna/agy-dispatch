// A scripted stand-in for "agy acp", driven by the prompt text. Used by the tests only.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'acp') { process.stderr.write('fake agy: only acp\n'); process.exit(2); }
const log = (m) => { if (process.env.FAKE_AGY_LOG) fs.appendFileSync(process.env.FAKE_AGY_LOG, m + '\n'); };
let buf = '';
let sid = null;
let pendingPrompt = null; // {id, cancelOnly}
let reqId = 1000;
const waiting = new Map();
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const upd = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (t) => upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
process.stdin.on('end', () => process.exit(0));

async function handle(m) {
  log('<- ' + JSON.stringify(m));
  if (m.id !== undefined && !m.method) { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m.result); } return; }
  const { id, method, params } = m;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (method === 'session/new') {
    if (process.env.FAKE_AUTH_FAIL) return send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Authentication required' } });
    sid = 'fake-' + Date.now();
    return send({ jsonrpc: '2.0', id, result: { sessionId: sid, models: { availableModels: [{ modelId: 'fake-model' }] } } });
  }
  if (method === 'session/load') { sid = params.sessionId; chunk('REPLAYED HISTORY'); return send({ jsonrpc: '2.0', id, result: {} }); }
  if (method === 'session/set_model' || method === 'session/set_mode' || method === 'session/close') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'session/cancel') {
    if (pendingPrompt && !pendingPrompt.ignoreCancel) { const p = pendingPrompt; pendingPrompt = null; send({ jsonrpc: '2.0', id: p.id, result: { stopReason: 'cancelled' } }); }
    return;
  }
  if (method === 'session/prompt') {
    const text = params.prompt.map((p) => p.text).join('');
    if (pendingPrompt) { // mid-turn message: finish the earlier request early, keep working (agy behaviour)
      send({ jsonrpc: '2.0', id: pendingPrompt.id, result: { stopReason: 'end_turn' } });
      pendingPrompt = { id, ignoreCancel: pendingPrompt.ignoreCancel };
      chunk('got mid-turn: ' + text);
      return;
    }
    pendingPrompt = { id };
    const done = (stopReason = 'end_turn') => { if (pendingPrompt && pendingPrompt.id === id) { pendingPrompt = null; send({ jsonrpc: '2.0', id, result: { stopReason } }); } else if (pendingPrompt) { const p = pendingPrompt; pendingPrompt = null; send({ jsonrpc: '2.0', id: p.id, result: { stopReason } }); } };
    if (text.startsWith('normal')) {
      chunk('hello '); await sleep(100);
      upd({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'run_command', kind: 'execute', title: 'echo hi', status: 'in_progress' });
      await sleep(100);
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { exit_code: 0 } });
      chunk('world: ' + text); return done();
    }
    if (text.startsWith('slow')) {
      for (let k = 0; k < 6 && pendingPrompt; k++) { chunk('tick' + k + ' '); await sleep(500); }
      return done();
    }
    if (text.startsWith('hang-cancellable')) return; // waits for session/cancel
    if (text.startsWith('hang')) { pendingPrompt.ignoreCancel = true; return; }
    if (text.startsWith('crash')) { chunk('about to crash'); await sleep(100); process.exit(3); }
    if (text.startsWith('ask')) {
      upd({ sessionUpdate: 'tool_call', toolCallId: 'q1', name: 'ask_question', kind: 'other', rawInput: { questions: [{ question: 'Favorite color?', options: ['red', 'blue'] }] }, status: 'in_progress' });
      chunk('What is your favorite color?'); return done();
    }
    if (text.startsWith('write')) {
      upd({ sessionUpdate: 'tool_call', toolCallId: 'w1', name: 'write_file', kind: 'edit', title: 'File x.txt', locations: [{ path: process.cwd() + '/x.txt' }], status: 'in_progress' });
      await sleep(200);
      return done();
    }
    if (text.startsWith('permission')) {
      const rid = reqId++;
      const answer = new Promise((r) => waiting.set(rid, r));
      send({ jsonrpc: '2.0', id: rid, method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 'p1', title: 'rm -rf build' }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'always', kind: 'allow_always', name: 'Always' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] } });
      const res = await answer;
      chunk('permission outcome: ' + JSON.stringify(res && res.outcome)); return done();
    }
    chunk('echo: ' + text); return done();
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown ' + method } });
}
