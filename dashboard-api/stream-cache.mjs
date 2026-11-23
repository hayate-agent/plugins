/** Bounded, disposable WebUI cache for stream-delta-v1 envelopes.
 *
 * The agents stay the single source of truth. This cache only holds a recent
 * window of per-session events so `changes?since` after a reconnect can be
 * answered centrally. It is never authoritative: a miss, an epoch change or a
 * window gap simply falls through to the agent. A restart empties it and the
 * system stays correct. No media bytes are ever stored (envelopes carry none).
 *
 * Extension points:
 * - CacheStore: `get(key)`, `set(key, value, size)`, `delete(key)`, `stats()`.
 * Authorization is never decided here: callers combine every hit with an agent
 * request (see WorkspaceHTTP.changes). `dropAgent(principal, agentId)` removes
 * all cached sessions of a removed agent (hygiene).
 *   The default store is in-memory with LRU eviction, a global byte cap and an
 *   idle TTL. Other stores (e.g. shared memory caches) can be injected.
 * - EventSink: `{ onEvent(envelope, meta) }`. Delivered asynchronously through a
 *   bounded queue; slow or failing sinks never affect delivery (auditing, export).
 * - EventSource: `{ subscribe(listener) -> unsubscribe }`. Anything producing
 *   envelopes (relay, other systems) can feed `ingest` via `attach(source)`.
 */
export const CACHE_DEFAULTS = Object.freeze({ maxBytes: 256 * 1024 * 1024, idleTtlMs: 24 * 60 * 60 * 1000, maxEventsPerSession: 2000, maxBytesPerSession: 8 * 1024 * 1024, sinkQueue: 1024 });

export function createMemoryCacheStore({ maxBytes = CACHE_DEFAULTS.maxBytes, idleTtlMs = CACHE_DEFAULTS.idleTtlMs, now = Date.now } = {}) {
 const entries = new Map(); let bytes = 0, evictions = 0, expirations = 0;
 const remove = key => { const entry = entries.get(key); if (!entry) return; entries.delete(key); bytes -= entry.size; };
 const expire = () => { const limit = now() - idleTtlMs; for (const [key, entry] of entries) { if (entry.used > limit) break; remove(key); expirations++; } };
 return {
  get(key) {
   expire();
   const entry = entries.get(key); if (!entry) return undefined;
   entries.delete(key); entry.used = now(); entries.set(key, entry); // LRU + idle order
   return entry.value;
  },
  set(key, value, size) {
   if (!Number.isSafeInteger(size) || size < 0) throw Error('Cache entry size required');
   remove(key);
   if (size > maxBytes) return false;
   entries.set(key, { value, size, used: now() }); bytes += size;
   while (bytes > maxBytes) { remove(entries.keys().next().value); evictions++; }
   return true;
  },
  delete: remove,
  stats() { expire(); return { entries: entries.size, bytes, maxBytes, evictions, expirations }; },
 };
}

export function createStreamCache({ store = createMemoryCacheStore(), maxSessions = 16384, sinks = [], maxEventsPerSession = CACHE_DEFAULTS.maxEventsPerSession, maxBytesPerSession = CACHE_DEFAULTS.maxBytesPerSession, sinkQueue = CACHE_DEFAULTS.sinkQueue } = {}) {
 let hits = 0, misses = 0, sinkDropped = 0, sinkFailures = 0;
 const sinkList = [...sinks];
 const queue = []; let draining = false;
 const drain = async () => {
  if (draining) return; draining = true;
  try {
   while (queue.length) {
    const [envelope, meta] = queue.shift();
    for (const sink of sinkList) { try { await sink.onEvent?.(envelope, meta); } catch { sinkFailures++; } }
   }
  } finally { draining = false; }
 };
 const key = (principal, agentId, session) => JSON.stringify(['stream', principal, agentId, session]);
 // Globally bounded index of cached windows. Evicting an index entry also
 // deletes its store entry, so nothing cached is ever unreachable for dropAgent.
 const index = new Map(); // store key -> [principal, agentId]
 return {
  /** Adds one envelope. Out-of-order, duplicate or foreign-epoch input never
   * corrupts the window: a non-contiguous event restarts it. */
  ingest(principal, agentId, envelope) {
   if (!envelope || typeof envelope.session !== 'string' || typeof envelope.epoch !== 'string' || !Number.isSafeInteger(envelope.seq)) return false;
   const id = key(principal, agentId, envelope.session);
   let window = store.get(id);
   if (window && window.epoch === envelope.epoch && envelope.seq <= window.last) return false; // duplicate
   if (!window || window.epoch !== envelope.epoch || envelope.seq !== window.last + 1) window = { epoch: envelope.epoch, first: envelope.seq, last: envelope.seq - 1, events: [], bytes: 0 };
   const size = Buffer.byteLength(JSON.stringify(envelope));
   window.events.push({ envelope, size }); window.bytes += size; window.last = envelope.seq;
   while (window.events.length > maxEventsPerSession || window.bytes > maxBytesPerSession) { window.bytes -= window.events.shift().size; window.first++; }
   store.set(id, window, window.bytes + 256);
   index.delete(id); index.set(id, [principal, agentId]);
   while (index.size > maxSessions) { const oldest = index.keys().next().value; index.delete(oldest); store.delete(oldest); }
   if (sinkList.length) {
    if (queue.length >= sinkQueue) { queue.shift(); sinkDropped++; }
    queue.push([envelope, { principal, agentId }]); void drain();
   }
   return true;
  },
  /** Cached answer for `changes?since`, or `undefined` when only the agent can
   * answer (unknown session, other epoch, cursor outside the cached window). */
  since(principal, agentId, session, seq, epoch, limit = 128) {
   const window = typeof session === 'string' ? store.get(key(principal, agentId, session)) : undefined;
   // The cache never decides that nothing is newer: an event may exist at the
   // agent that never reached this relay (that is why the client asks). Only a
   // cursor strictly inside the window is served; `more: true` makes the client
   // confirm the head with the agent in its next request.
   if (!window || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(seq) || typeof epoch !== 'string' || epoch !== window.epoch || seq < window.first - 1 || seq >= window.last) { misses++; return undefined; }
   hits++;
   const events = [], count = Math.min(limit, 512);
   for (const item of window.events) {
    if (item.envelope.seq <= seq) continue;
    events.push(item.envelope);
    if (events.length >= count) break;
   }
   return { epoch: window.epoch, session, seq: events.at(-1).seq, events, more: true, truncated: events.at(-1).seq < window.last, cached: true };
  },
  attach(source, principal, resolve = event => event) {
   return source.subscribe(event => { const value = resolve(event); if (value) this.ingest(principal, value.agentId, value.envelope); });
  },
  dropAgent(principal, agentId) {
   for (const [id, [p, a]] of index) if (p === principal && a === agentId) { index.delete(id); store.delete(id); }
  },
  addSink(sink) { sinkList.push(sink); return () => { const index = sinkList.indexOf(sink); if (index >= 0) sinkList.splice(index, 1); }; },
  stats() { return { ...store.stats(), indexed: index.size, hits, misses, sinkDropped, sinkFailures, sinkQueued: queue.length }; },
 };
}
