// Local bootstrap only. Password never enters argv, shell history or agent transcripts.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { passwordRecord } from './service.mjs';
const [home, username] = process.argv.slice(2);
if (!home || !path.isAbsolute(home) || !username || !process.stdin.isTTY) throw Error('Usage in a local terminal: node identity/setup.mjs /absolute/agent-home username');
const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
const terminal = createInterface({ input: process.stdin, output: silent, terminal: true });
try {
  process.stderr.write('Password (hidden, at least 12 characters): ');
  const password = await terminal.question('');
  process.stderr.write('\nConfirm password: ');
  if (await terminal.question('') !== password) throw Error('Passwords do not match');
  const record = await passwordRecord(password);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = await open(path.join(home, 'identity.json'), 'wx', 0o600);
  try { await file.writeFile(JSON.stringify({ username, password: record }, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  process.stderr.write('\nIdentity created; existing configuration is never overwritten.\n');
} finally { terminal.close(); }
