import { describeAgentFailure } from './relay-errors.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

/** One idempotency ledger for agent commands, shared by the browser WebSocket
 * (`command` frames) and the POST fallback. A given (principal, opId) executes
 * at most once: a duplicate while running awaits the same execution, a duplicate
 * afterwards receives the recorded outcome. A different payload under the same
 * opId is a conflict. Failures are recorded too and never re-executed under the
 * same opId: the outcome may be unknown, so clients reconcile (e.g. via
 * `submission-status`) and use a new opId for a deliberate retry.
 *
 * Restart safety: with `file`, every operation is journaled durably BEFORE it
 * executes and again with its outcome. After a restart, an operation that was
 * running is reported as outcome unknown (409, never executed again) and that
 * record never expires automatically (it occupies capacity; a full ledger
 * refuses new work). Completed ones keep their outcome for the TTL. An
 * unreadable journal or any damaged record fails closed. Duplicates after a
 * restart receive the exact recorded outcome.
 *
 * Only a payload fingerprint and bounded results are retained, never inputs
 * (media bytes stay out of the ledger). An entry is kept for the full TTL after
 * it finishes (running entries indefinitely), so dedup can never be lost to
 * eviction. When count or byte capacity is reached, NEW operations are refused
 * without executing (`executed: false`); clients may retry later.
 */
/** opId = `<issued ms base36>-<random>`. The issue time bounds the dedup window:
 * an opId is accepted only while `issued >= now - (ttl - skew)` and
 * `issued <= now + skew`. Entries are kept at least `ttl` after their first
 * arrival, so a retry can never arrive after its record was pruned; a late retry
 * is refused without execution (`executed: false`) instead of running twice. */
export const OP_ID = /^([0-9a-z]{1,11})-[A-Za-z0-9_-]{16,52}$/;
export const issueOpId = (now = Date.now()) => `${now.toString(36)}-${globalThis.crypto.randomUUID()}`;
const UNKNOWN = { ok: false, status: 409, executed: 'unknown', error: 'Operation outcome unknown after restart; reconcile before retrying with a new opId' };

export function createCommandLedger({ file, skewMs = 60_000, maxEntries = 4096, maxBytes = 8 * 1024 * 1024, ttlMs = 15 * 60 * 1000, maxResultBytes = 200_000, now = Date.now } = {}) {
 const entries = new Map(); let bytes = 0;
 let state = file ? 'loading' : 'ready', loaded, writes = Promise.resolve();
 const remove = key => { const entry = entries.get(key); if (!entry) return; entries.delete(key); bytes -= entry.size; };
 // Only expired, finished entries are removed. Never anything younger.
 const prune = () => {
  const limit = now() - ttlMs;
  for (const [key, entry] of entries) if (!entry.running && !entry.unknown && entry.finishedAt <= limit) remove(key);
 };
 const snapshot = () => [...entries].map(([key, entry]) => ({ key, fingerprint: entry.fingerprint, running: entry.running, unknown: entry.unknown === true, finishedAt: entry.running ? null : entry.finishedAt,
  outcome: entry.running ? null : entry.journal }));
 const validKey = key => { try { const value = JSON.parse(key); return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && OP_ID.test(value[1]) && JSON.stringify(value) === key; } catch { return false; } };
 const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
 const validOutcome = outcome => {
  if (!object(outcome)) return false;
  const keys = Object.keys(outcome);
  // Any JSON value is a valid recorded result (arrays, primitives, null).
  if (outcome.ok === true) return Object.hasOwn(outcome, 'result') && outcome.result !== undefined && keys.every(key => ['ok', 'result'].includes(key));
  return outcome.ok === false && Number.isInteger(outcome.status) && outcome.status >= 400 && outcome.status <= 599 && typeof outcome.error === 'string' && outcome.error.length <= 500
   && (outcome.executed === undefined || outcome.executed === false || outcome.executed === 'unknown')
   && keys.every(key => ['ok', 'status', 'error', 'executed', 'result'].includes(key));
 };
 // Serialized atomic rewrites. Any failed write makes the ledger fail closed:
 // every queued and later write is refused, so no later snapshot can overwrite
 // the journal and no queued operation executes after a failure.
 const persist = () => {
  if (!file) return Promise.resolve();
  if (state === 'failed') return Promise.reject(Error('Operation ledger unavailable'));
  const write = writes.then(async () => {
   if (state === 'failed') throw Error('Operation ledger unavailable');
   // Durable: fsync the new file, rename atomically, fsync the directory.
   const temporary = `${file}.${randomUUID()}.tmp`;
   const handle = await open(temporary, 'w', 0o600);
   try { await handle.writeFile(JSON.stringify({ version: 1, entries: snapshot() })); await handle.sync(); } finally { await handle.close(); }
   await rename(temporary, file);
   const directory = await open(path.dirname(file), 'r');
   try { await directory.sync(); } finally { await directory.close(); }
  });
  writes = write.catch(() => { state = 'failed'; });
  return write;
 };
 const load = async () => {
  if (!file) return;
  try {
   await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
   let journal;
   try { journal = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
   if (journal !== undefined && (journal?.version !== 1 || !Array.isArray(journal.entries))) throw Error('Invalid command journal');
   // Any damaged record fails closed: dedup history is never silently dropped.
   for (const item of journal?.entries ?? []) {
    if (typeof item?.key !== 'string' || !validKey(item.key) || entries.has(item.key) || !/^[0-9a-f]{64}$/.test(item.fingerprint ?? '') || typeof item.running !== 'boolean' || typeof item.unknown !== 'boolean') throw Error('Damaged command journal entry');
    // Consistent state: running = no outcome/timestamp; finished = valid outcome
    // and timestamp; unknown only for finished records holding the unknown outcome.
    if (item.running && (item.unknown || item.outcome !== null || item.finishedAt !== null)) throw Error('Damaged command journal entry');
    if (!item.running && (!validOutcome(item.outcome) || !Number.isFinite(item.finishedAt) || item.finishedAt <= 0 || item.finishedAt > now() + 60_000)) throw Error('Damaged command journal entry');
    if (item.unknown && JSON.stringify(item.outcome) !== JSON.stringify(UNKNOWN)) throw Error('Damaged command journal entry');
    const unknown = item.running || item.unknown;
    const outcome = unknown ? UNKNOWN : item.outcome;
    const size = 256 + Buffer.byteLength(JSON.stringify(outcome));
    entries.set(item.key, { fingerprint: item.fingerprint, running: false, unknown, finishedAt: unknown ? now() : item.finishedAt, journal: outcome, outcome: Promise.resolve(outcome), size });
    bytes += size;
   }
   const before = entries.size;
   prune();
   state = 'ready';
   if (entries.size !== before) await persist();
  } catch { state = 'failed'; }
 };
 loaded = load();
 return {
  ready: () => loaded,
  get state() { return state; },
  /** Waits for pending journal writes (shutdown). */
  async close() { await loaded; await writes; },
  /** Runs `execute` once per (principal, opId). Resolves to the outcome
   * `{ ok, result?, status?, error?, executed? }`; never rejects. */
  async run(principal, opId, payload, execute) {
   if (typeof principal !== 'string' || !OP_ID.test(opId ?? '')) return { ok: false, status: 400, executed: false, error: 'Valid opId required' };
   await loaded;
   if (state !== 'ready') return { ok: false, status: 503, executed: false, error: 'Operation ledger unavailable; nothing was executed' };
   const issued = parseInt(OP_ID.exec(opId)[1], 36);
   const key = JSON.stringify([principal, opId]);
   const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
   prune();
   const known = entries.get(key);
   if (!known && (issued > now() + skewMs || issued <= now() - (ttlMs - skewMs))) return { ok: false, status: 409, executed: false, error: 'Operation identifier expired or clock skewed; nothing was executed. Reconcile, then issue a new opId' };
   if (known) {
    if (known.fingerprint !== fingerprint) return { ok: false, status: 409, executed: false, error: 'Operation identity conflict: opId reused for different content' };
    return { ...await known.outcome, duplicate: true };
   }
   // Reserve the worst-case outcome size up front: completions never exceed maxBytes.
   const reserve = 256 + maxResultBytes + 512;
   if (entries.size >= maxEntries || bytes + reserve > maxBytes) return { ok: false, status: 503, executed: false, error: 'Too many recent operations; nothing was executed, retry later' };
   let settle; const entry = { fingerprint, running: true, size: reserve, finishedAt: Infinity, outcome: new Promise(resolve => { settle = resolve; }) };
   entries.set(key, entry); bytes += entry.size;
   // Durable begin record before any side effect; re-checked after the write.
   try { await persist(); if (state !== 'ready') throw Error('Operation ledger unavailable'); } catch {
    remove(key); const refused = { ok: false, status: 503, executed: false, error: 'Operation ledger unavailable; nothing was executed' };
    settle(refused); return refused;
   }
   let outcome;
   try {
    const result = await execute();
    let text; try { text = JSON.stringify(result ?? {}); } catch { text = undefined; }
    outcome = typeof text !== 'string' ? { ok: true, result: { unserializable: true } }
     : Buffer.byteLength(text) > maxResultBytes ? { ok: true, result: { tooLarge: true } } : { ok: true, result: result ?? {} };
   } catch (error) {
    const failure = error?.status ? { status: Number.isInteger(error.status) ? error.status : 502, error: String(error.message).slice(0, 500) } : describeAgentFailure(error);
    outcome = { ok: false, ...failure };
   }
   entry.running = false; entry.finishedAt = now();
   // The journal holds the exact outcome the first caller received (results are
   // already bounded by maxResultBytes; the whole ledger by maxBytes), so a
   // duplicate after a restart gets the identical answer.
   entry.journal = outcome.ok ? outcome : { ...outcome, error: outcome.error.slice(0, 500) };
   const size = Math.min(reserve, 256 + Buffer.byteLength(JSON.stringify(outcome))); bytes += size - entry.size; entry.size = size;
   settle(outcome);
   await persist().catch(() => {});
   return outcome;
  },
  /** Recorded outcome without executing anything (status query). */
  async status(principal, opId) {
   await loaded;
   const entry = entries.get(JSON.stringify([principal, opId]));
   if (!entry) return { state: state === 'ready' ? 'unknown' : 'unavailable' };
   if (entry.running) return { state: 'running' };
   const outcome = await entry.outcome;
   return { state: outcome.ok ? 'completed' : outcome.executed === 'unknown' ? 'unknown-outcome' : 'failed', ...outcome };
  },
  get size() { return entries.size; },
 };
}
