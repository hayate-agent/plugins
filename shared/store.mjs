import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** One host-owned instance. Subscribers are projections, never part of the commit. */
export class Store {
  #data; #initial; #serial = Promise.resolve(); #listeners = new Set(); #closed = false;
  constructor(file, initial) { this.file = file; this.#data = structuredClone(initial); this.#initial = structuredClone(initial); }
  #validate(data) {
    if (!data || data.version !== 1 || Object.entries(this.#initial).some(([key, initial]) => !Object.hasOwn(data, key) || typeof data[key] !== typeof initial || Array.isArray(data[key]) !== Array.isArray(initial) || (initial !== null && typeof initial === 'object' && data[key] === null))) throw Error('Invalid or unsupported plugin store');
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      this.#validate(data);
      this.#data = data;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  read() { return structuredClone(this.#data); }
  subscribe(listener) { if (this.#closed) throw Error('Workspace stopping'); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  change(mutator) {
    if (this.#closed) return Promise.reject(Error('Workspace stopping'));
    const work = this.#serial.then(async () => {
      const data = structuredClone(this.#data);
      const result = structuredClone(await mutator(data));
      const serialized = JSON.stringify(structuredClone(data));
      const committed = JSON.parse(serialized);
      this.#validate(committed);
      const directory = path.dirname(this.file);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const fd = await open(temp, 'wx', 0o600);
        try { await fd.writeFile(serialized); await fd.sync(); } finally { await fd.close(); }
        await rename(temp, this.file);
        const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
      } finally { await rm(temp, { force: true }); }
      this.#data = committed;
      for (const listener of [...this.#listeners]) {
        if (!this.#listeners.has(listener)) continue;
        try { listener(); } catch { /* committed data wins */ }
      }
      return result;
    });
    this.#serial = work.catch(() => {});
    return work;
  }
  async stop() { this.#closed = true; await this.#serial; this.#listeners.clear(); }
}
