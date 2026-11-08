import { realpath, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const inside = (base, candidate) => { const relative = path.relative(base, candidate); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

/** Server-side picker; roots are operator configuration, not arbitrary HTTP paths. */
export class Files {
  #roots = [];
  constructor(roots) { this.configured = roots; }
  async start() {
    if (!Array.isArray(this.configured) || !this.configured.length || this.configured.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw Error('Configure absolute workspace roots');
    this.#roots = [...new Set(await Promise.all(this.configured.map(p => realpath(p))))];
    for (const p of this.#roots) if (!(await stat(p)).isDirectory()) throw Error('Workspace root is not a directory');
  }
  roots() { return [...this.#roots]; }
  async resolve(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error('Absolute server directory required');
    const candidate = await realpath(value);
    if (!this.#roots.some(root => inside(root, candidate))) throw Error('Directory is outside operator-configured workspace roots');
    if (!(await stat(candidate)).isDirectory()) throw Error('Directory required');
    return candidate;
  }
  async browse(value) {
    const directory = await this.resolve(value);
    const entries = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try { const resolved = await this.resolve(path.join(directory, entry.name)); entries.push({ name: entry.name, path: resolved }); }
      catch { /* no escape through links, stale or unreadable entries */ }
    }
    return { directory, parent: this.#roots.includes(directory) ? null : path.dirname(directory), entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
  }
  async repository(value) {
    const cwd = await this.resolve(value);
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 10000, maxBuffer: 128000 });
    const root = await this.resolve(stdout.trim());
    let origin;
    try {
      origin = (await exec('git', ['-C', root, 'remote', 'get-url', 'origin'], { timeout: 10000, maxBuffer: 128000 })).stdout.trim();
      // Never project credentials accidentally embedded in a configured remote URL.
      if (origin.includes('://')) { const url = new URL(origin); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; origin = url.href; }
    } catch { origin = undefined; }
    return { directory: root, origin };
  }
}
