import { oneLine, fmtDur } from './util.mjs';

// Turn one broker event into one progress line (or null to skip it).
// "self" is the command prefix to suggest, e.g. node /path/agy.mjs
export function renderEvent(e, id, { verbose = false, self = 'agy.mjs' } = {}) {
  const p = `[${id}]`;
  switch (e.type) {
    case 'broker_start': return verbose ? `${p} broker started (pid ${e.pid})` : null;
    case 'ready': return `${p} ready on ${e.host || '?'} · cwd ${e.cwd}${e.resumed ? ' · conversation reloaded' : ''}`;
    case 'turn_start': return `${p} turn ${e.turn} started`;
    case 'user': return e.injected ? `${p} you → agy (mid-turn): ${oneLine(e.text, 200)}` : `${p} you → agy: ${oneLine(e.text, 200)}`;
    case 'text': return `${p} agy: ${oneLine(e.text, 500)}`;
    case 'tool': return `${p} ${e.name}: ${oneLine(e.title, 160)}`;
    case 'tool_done':
      if (!e.ok) return `${p} ${e.name} failed${e.exit != null ? ' (exit ' + e.exit + ')' : ''} after ${fmtDur(e.ms)}: ${oneLine(e.title, 120)}`;
      return verbose ? `${p} ${e.name} done in ${fmtDur(e.ms)}` : null;
    case 'steps': {
      const st = e.steps || [];
      const done = st.filter((x) => /done|complete|success/i.test(x.status)).length;
      const cur = st.find((x) => /progress|active|running/i.test(x.status));
      const failed = st.filter((x) => /fail/i.test(x.status)).length;
      return `${p} steps ${done}/${st.length}${failed ? ' (' + failed + ' failed)' : ''}${cur ? ' · now: ' + oneLine(cur.title, 120) : ''}`;
    }
    case 'question': {
      const qs = (e.questions || []).map((q) => oneLine(q.question, 200) + (q.options && q.options.length ? ' [' + q.options.join(' | ') + ']' : '')).join(' / ');
      return `${p} QUESTION from agy: ${qs} → reply: ${self} send ${id} -- "<answer>"`;
    }
    case 'permission': return `${p} APPROVAL #${e.req} needed: ${e.title} → ${self} answer ${id} ${e.req} allow|always|deny  (auto-deny in ${fmtDur(e.timeoutMs)})`;
    case 'request': return `${p} REQUEST #${e.req} ${e.method}: ${oneLine(e.params, 300)} → ${self} answer ${id} ${e.req} '<json>'`;
    case 'answered': return `${p} answered #${e.req}: ${e.value}`;
    case 'permission_auto': return verbose ? `${p} auto-approved: ${e.title}` : null;
    case 'permission_denied': return `${p} denied by policy: ${e.title}`;
    case 'permission_timeout': return `${p} approval #${e.req} not answered in time → denied: ${e.title}`;
    case 'violation': return `${p} READ-ONLY VIOLATION: ${e.name} ${e.title} → turn cancelled (restart with --write to allow edits)`;
    case 'stall': return `${p} STALL: no activity for ${fmtDur(e.idleMs)} (${e.phase}) → cancelling the turn`;
    case 'turn_timeout': return `${p} TURN TIMEOUT after ${fmtDur(e.ms)} → cancelling`;
    case 'cancel': return `${p} cancel sent: ${e.reason}`;
    case 'kill': return `${p} KILLED agy: ${e.reason}`;
    case 'agent_exit': return `${p} agy process exited (code ${e.code}${e.signal ? ', ' + e.signal : ''})${e.stderr ? ': ' + e.stderr : ''}`;
    case 'recovering': return `${p} restarting agy and reloading the conversation (attempt ${e.attempt}): ${e.reason}`;
    case 'recovered': return `${p} recovered; the conversation is intact — send a message to continue`;
    case 'turn_end': {
      const q = e.question && e.question.length ? ' · agy is waiting for your answer (send)' : '';
      const notes = e.notes && e.notes.length ? ' · ' + oneLine(e.notes.join('; '), 200) : '';
      return `${p} turn ${e.turn} finished: ${e.stopReason} in ${fmtDur(e.ms)}, ${e.chars} chars${q}${notes} → ${self} result ${id}`;
    }
    case 'title': return verbose ? `${p} title: ${e.title}` : null;
    case 'warn': return `${p} warning: ${e.message}`;
    case 'error': return `${p} error: ${e.message}`;
    case 'failed': return `${p} FAILED: ${e.message}`;
    case 'dead': return `${p} DEAD: ${e.reason || e.message}`;
    case 'parked': return `${p} parked (${e.reason}); agy process stopped, ${self} send resumes it`;
    case 'stopped': return `${p} stopped (${e.reason || 'requested'})`;
    case 'ack': return verbose && e.ok === false ? `${p} command rejected: ${e.error}` : null;
    default: return verbose ? `${p} ${e.type}` : null;
  }
}

export const END_TYPES = new Set(['stopped', 'parked', 'dead', 'failed']);
export const INPUT_TYPES = new Set(['permission', 'request']);
