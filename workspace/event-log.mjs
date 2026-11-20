import { randomUUID } from 'node:crypto';

/** Streaming change log (protocol `stream-delta-v1`), identical envelope to the PI
 * connector: `{ v, epoch, session, seq, kind, data }`.
 *
 * The workspace stays the source of truth. This log only keeps a bounded,
 * disposable window of recent per-stream changes so clients can stream deltas and
 * repair short gaps. `epoch` changes when the window restarts (clients reset),
 * `seq` is contiguous per stream within one epoch, `since()` returns the missing
 * events or `{ reset: true }` when the gap is no longer retained. */
export const MAX_EVENT_BYTES = 64 * 1024;

export function createEventLog({ maxEventsPerSession = 512, maxBytesPerSession = 1024 * 1024, maxSessions = 128, epoch = randomUUID() } = {}) {
  const sessions = new Map(), listeners = new Set(); let generation = 0;
  const state = id => {
    let entry = sessions.get(id);
    if (entry) { sessions.delete(id); sessions.set(id, entry); return entry; }
    entry = { epoch: `${epoch}.${++generation}`, seq: 0, events: [], bytes: 0 };
    sessions.set(id, entry);
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    return entry;
  };
  return {
    epoch,
    append(session, kind, data = {}) {
      if (typeof session !== 'string' || !session || typeof kind !== 'string') throw Error('Invalid stream event');
      const entry = state(session);
      const envelope = { v: 1, epoch: entry.epoch, session, seq: entry.seq + 1, kind, data };
      const size = Buffer.byteLength(JSON.stringify(envelope));
      if (size > MAX_EVENT_BYTES) throw Error('Stream event exceeds frame budget');
      entry.seq = envelope.seq; entry.events.push({ envelope, size }); entry.bytes += size;
      while (entry.events.length > maxEventsPerSession || entry.bytes > maxBytesPerSession) entry.bytes -= entry.events.shift().size;
      for (const listener of listeners) { try { listener(envelope); } catch { /* A broken consumer never affects the producer. */ } }
      return envelope;
    },
    tracked(session) { return sessions.has(session); },
    head(session) { const entry = state(session); return { epoch: entry.epoch, session, seq: entry.seq }; },
    since(session, seq, { epoch: clientEpoch, limit = 256 } = {}) {
      const entry = state(session), current = entry.seq, sessionEpoch = entry.epoch;
      const reset = { epoch: sessionEpoch, session, seq: current, reset: true, events: [] };
      if (clientEpoch !== undefined && clientEpoch !== sessionEpoch) return reset;
      if (!Number.isSafeInteger(seq) || seq < 0 || seq > current) return reset;
      if (seq === current) return { epoch: sessionEpoch, session, seq: current, events: [] };
      const first = entry.events[0]?.envelope.seq ?? current + 1;
      if (seq + 1 < first) return reset;
      // Bounded by count and bytes (a repair answer stays well below the response budget).
      const events = []; let bytes = 0;
      for (const item of entry.events) {
        if (item.envelope.seq <= seq) continue;
        if (events.length >= Math.max(1, Math.min(limit, 512)) || events.length && bytes + item.size > 160000) break;
        events.push(item.envelope); bytes += item.size;
      }
      // A truncated answer continues from its LAST returned event, never from the head.
      const more = events.at(-1).seq < current;
      return { epoch: sessionEpoch, session, seq: more ? events.at(-1).seq : current, events, more };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    forget(session) { sessions.delete(session); },
  };
}

/** Coalesces token text into a few frames per second, never reorders around other events. */
export function createTextCoalescer(log, { flushMs = 50, maxChars = 16000, timers = globalThis } = {}) {
  const buffers = new Map();
  const flush = session => {
    const pending = buffers.get(session); if (!pending) return;
    buffers.delete(session); timers.clearTimeout(pending.timer);
    let text = pending.text;
    while (text) {
      let cut = Math.min(text.length, maxChars);
      while (cut > 1 && JSON.stringify(text.slice(0, cut)).length > 48 * 1024) cut = Math.floor(cut / 2);
      if (cut < text.length && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
      try { log.append(session, 'text.delta', { delta: text.slice(0, cut) }); } catch { /* clients repair from the durable entry */ }
      text = text.slice(Math.max(1, cut));
    }
  };
  return {
    text(session, delta) {
      if (typeof delta !== 'string' || !delta) return;
      let pending = buffers.get(session);
      if (!pending) { pending = { text: '', timer: timers.setTimeout(() => flush(session), flushMs) }; pending.timer?.unref?.(); buffers.set(session, pending); }
      pending.text += delta;
      if (pending.text.length >= maxChars) flush(session);
    },
    flush,
    event(session, kind, data) { flush(session); return log.append(session, kind, data); },
    stop() { for (const [session, pending] of buffers) { timers.clearTimeout(pending.timer); buffers.delete(session); } },
  };
}
