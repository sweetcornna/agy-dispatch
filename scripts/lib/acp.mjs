import { EventEmitter } from 'node:events';
import { jsonAscii } from './util.mjs';

// JSON-RPC 2.0 over newline-delimited stdio, as spoken by "agy acp".
export class Rpc extends EventEmitter {
  constructor(writable, readable, { onRaw } = {}) {
    super();
    this.w = writable;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onRaw = onRaw || (() => {});
    let buf = '';
    readable.setEncoding('utf8');
    readable.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.trim()) this._line(line);
      }
    });
    readable.on('end', () => this._close('agent closed its output'));
    readable.on('error', (e) => this._close('read error: ' + e.message));
    writable.on('error', (e) => this._close('write error: ' + e.message));
  }
  _line(line) {
    this.onRaw('<', line);
    let m;
    try { m = JSON.parse(line); } catch { this.emit('garbage', line); return; }
    this.emit('activity');
    if (m.method && m.id !== undefined) { this.emit('request', m.id, m.method, m.params || {}); return; }
    if (m.method) { this.emit('notification', m.method, m.params || {}); return; }
    if (m.id !== undefined && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) { const e = new Error(m.error.message || 'rpc error'); e.code = m.error.code; e.data = m.error.data; p.reject(e); }
      else p.resolve(m.result);
    }
  }
  _send(obj) {
    if (this.closed) throw new Error('connection closed');
    const line = jsonAscii(obj);
    this.onRaw('>', line);
    this.w.write(line + '\n');
  }
  call(method, params, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('connection closed'));
      const id = this.nextId++;
      const p = { resolve, reject, method, timer: null };
      if (timeoutMs > 0) p.timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`), { timeout: true })); }, timeoutMs);
      this.pending.set(id, p);
      try { this._send({ jsonrpc: '2.0', id, method, params }); } catch (e) { this.pending.delete(id); clearTimeout(p.timer); reject(e); }
    });
  }
  notify(method, params) { try { this._send({ jsonrpc: '2.0', method, params }); } catch {} }
  respond(id, result) { try { this._send({ jsonrpc: '2.0', id, result }); } catch {} }
  respondError(id, code, message) { try { this._send({ jsonrpc: '2.0', id, error: { code, message } }); } catch {} }
  _close(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(reason), { closed: true })); }
    this.pending.clear();
    this.emit('close', reason);
  }
  close(reason = 'closed by client') { this._close(reason); }
}
