import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Per-operator WebUI preferences, stored on the server so every browser of the operator sees the same sidebar, theme and titles. */
export const THEMES = Object.freeze(['green', 'blue', 'gray', 'red', 'violet', 'sand', 'slate', 'rose']);
export const MODES = Object.freeze(['system', 'light', 'dark']);
const MAX_HIDDEN = 2000, MAX_TITLE = 60;
// Same shapes the browser builds: a bare agent id, or `project:<agent>:<id>` / `chat:<agent>:<id>` (agent `local` = the host's own agent).
const KEY = /^(?:(?:project|chat):[^\s:]{1,200}:\S{1,200}|[^\s:]{1,200})$/;
export const defaults = Object.freeze({ theme: 'green', mode: 'system', pageTitle: '', headerTitle: '', hidden: [], revision: 0 });
const bad = message => Object.assign(new Error(message), { status: 400 });

function text(value, name) {
  if (typeof value !== 'string' || value.length > MAX_TITLE || /[\u0000-\u001f\u007f]/.test(value)) throw bad(`${name} must be text of at most ${MAX_TITLE} characters`);
  return value.trim();
}
function keys(value, name) {
  if (!Array.isArray(value)) throw bad(`${name} must be a list`);
  for (const key of value) if (typeof key !== 'string' || !KEY.test(key)) throw bad(`${name} contains an invalid item`);
  return value;
}

/** Validates a client patch and applies it to `current`. Unknown fields are refused. `hide`/`show` change single items, so two
 *  browsers hiding different things never overwrite each other. */
export function applyPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Preferences patch must be an object');
  const allowed = new Set(['theme', 'mode', 'pageTitle', 'headerTitle', 'hide', 'show']);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw bad(`Unknown preference: ${key}`);
  const next = { ...current, hidden: [...current.hidden] };
  if (patch.theme !== undefined) { if (!THEMES.includes(patch.theme)) throw bad('Unknown theme'); next.theme = patch.theme; }
  if (patch.mode !== undefined) { if (!MODES.includes(patch.mode)) throw bad('Unknown mode'); next.mode = patch.mode; }
  if (patch.pageTitle !== undefined) next.pageTitle = text(patch.pageTitle, 'pageTitle');
  if (patch.headerTitle !== undefined) next.headerTitle = text(patch.headerTitle, 'headerTitle');
  const hide = patch.hide === undefined ? [] : keys(patch.hide, 'hide'), show = patch.show === undefined ? [] : keys(patch.show, 'show');
  const hidden = new Set(next.hidden); for (const key of show) hidden.delete(key); for (const key of hide) hidden.add(key);
  if (hidden.size > MAX_HIDDEN) throw bad(`At most ${MAX_HIDDEN} hidden items`); // also bounds a single huge list
  next.hidden = [...hidden].sort();
  return next;
}

export class Preferences {
  #file; #data = { ...defaults, hidden: [] }; #serial = Promise.resolve();
  constructor(file) { this.#file = file; }
  get value() { return structuredClone(this.#data); }
  async load() {
    try {
      const stored = JSON.parse(await readFile(this.#file, 'utf8'));
      const clean = applyPatch({ ...defaults }, { theme: stored.theme, mode: stored.mode, pageTitle: stored.pageTitle, headerTitle: stored.headerTitle, hide: stored.hidden });
      this.#data = { ...clean, revision: Number.isSafeInteger(stored.revision) && stored.revision >= 0 ? stored.revision : 0 };
    } catch { /* Missing, damaged or hostile file: start from the defaults; the next change rewrites it. */ }
    return this.value;
  }
  /** Serialised, atomic read-modify-write. */
  patch(patch) {
    const run = this.#serial.then(async () => {
      const next = applyPatch(this.#data, patch); next.revision = this.#data.revision + 1;
      await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const temp = `${this.#file}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(next), { mode: 0o600 }); await rename(temp, this.#file); }
      catch (error) { await rm(temp, { force: true }); throw error; }
      this.#data = next; return this.value;
    });
    this.#serial = run.catch(() => {});
    return run;
  }
}
