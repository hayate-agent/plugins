import { readFile, mkdir, chmod, lstat, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSecureContext } from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import { LocalVault } from '../credentials/vault.mjs';
import identityPlugin from '../identity/index.mjs';
import { Workspace } from '../workspace/service.mjs';
import { AgentHub } from '../agent-hub/service.mjs';
import { HayateAdapter } from '../agent-link/transport.mjs';
import { AgentRelay } from '../agent-link/websocket-relay.mjs';
import { WebUIChannel } from './index.mjs';

/** Registry/API/WSS administration only: no Core, model, shell or agent runtime. */
export async function createAdministration({ home, origin, port = 3211, host = '127.0.0.1', keyFile, certFile, directPeers = [], allowOperatorTargets = true }) {
  if (!home || !keyFile || !certFile) throw Error('Private data home and native TLS material required');
  let closing = false, stopping; const pending = new Set(), services = new Map(), cleanup = [];
  const foregroundWork = work => {
    if (closing) return Promise.reject(Error('Administration is stopping'));
    const operation = Promise.resolve().then(work); pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
  };
  const register = (name, implementation) => { if (services.has(name)) throw Error('Duplicate administration service'); services.set(name, { version: 1, implementation }); };
  let channel;
  const stop = () => stopping ??= (async () => {
    closing = true;
    await channel?.stop();
    for (const action of [...cleanup].reverse()) await action();
    await Promise.allSettled([...pending]);
  })();
  try {
    await mkdir(home, { recursive: true, mode: 0o700 }); const stat = await lstat(home);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw Error('Private operator-owned administration directory required');
    await chmod(home, 0o700);
    const vault = new LocalVault(home); await vault.open(); cleanup.push(() => vault.stop()); register('credentials', vault);
    await identityPlugin.activate({ home, foregroundWork, onStop: action => cleanup.push(action), registerService: (name, version, implementation) => { if (version !== 1) throw Error('Unsupported identity service'); register(name, implementation); } });
    const workspace = new Workspace({ home, cwd: home, roots: [home], agent: 'Agent administration' }); await workspace.open(); cleanup.push(() => workspace.stop()); register('workspaces', workspace);
    const relay = new AgentRelay({ home, origin, foregroundWork }); await relay.open({ listen: false }); cleanup.push(() => relay.stop()); register('agent-link-relay', relay);
    const hub = new AgentHub({ home, credentials: vault, foregroundWork }); await hub.open(); cleanup.push(() => hub.stop());
    hub.registerAdapter('hayate', new HayateAdapter(directPeers, { allowOperatorTargets })); hub.registerAdapter('hayate-wss', relay.adapter); register('agent-hub', hub);
    channel = new WebUIChannel({ home, agent: 'Agent administration', localAgent: false, port, network: { host, origin, keyFile, certFile }, services: { get: name => services.get(name) } });
    await channel.start(async () => { throw Error('No local execution runtime; select a registered agent'); });
    return { channel, relay, hub, foregroundWork, reloadTLS: () => foregroundWork(() => channel.reloadTLS()), stop };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const home = process.env.HAYATE_ADMIN_HOME;
  if (!home) throw Error('HAYATE_ADMIN_HOME is required');
  let tlsDigest;
  const source = process.env.HAYATE_ADMIN_TLS_SOURCE;
  const mirrorTLS = async () => {
    if (!source) return false;
    const key = await readFile(path.join(source, 'tls.key')), cert = await readFile(path.join(source, 'tls.crt'));
    createSecureContext({ key, cert });
    const digest = createHash('sha256').update(key).update(cert).digest('hex'); if (digest === tlsDigest) return false;
    const directory = path.join(home, 'tls'); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    for (const [name, data] of [['tls.key', key], ['tls.crt', cert]]) { const temporary = path.join(directory, '.' + randomUUID()); await writeFile(temporary, data, { mode: 0o600, flag: 'wx' }); await rename(temporary, path.join(directory, name)); }
    tlsDigest = digest; return true;
  };
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (process.env.HAYATE_ADMIN_BOOTSTRAP_IDENTITY) {
    const bootstrap = await readFile(process.env.HAYATE_ADMIN_BOOTSTRAP_IDENTITY);
    try { await writeFile(path.join(home, 'identity.json'), bootstrap, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  await mirrorTLS();
  const administration = await createAdministration({ home, origin: process.env.HAYATE_ADMIN_ORIGIN, host: process.env.HAYATE_ADMIN_HOST ?? '127.0.0.1', port: Number(process.env.HAYATE_ADMIN_PORT ?? 3211), keyFile: source ? path.join(home, 'tls/tls.key') : process.env.HAYATE_ADMIN_TLS_KEY, certFile: source ? path.join(home, 'tls/tls.crt') : process.env.HAYATE_ADMIN_TLS_CERT });
  console.log('Hayate standalone agent administration ready');
  let reloading = false;
  const reload = async () => { if (reloading) return; reloading = true; try { if (await mirrorTLS()) await administration.reloadTLS(); } catch { tlsDigest = undefined; console.error('TLS reload failed; retaining existing listener'); } finally { reloading = false; } };
  const timer = source ? setInterval(() => { void reload(); }, 30000) : undefined; timer?.unref();
  process.on('SIGHUP', () => { void reload(); });
  process.once('SIGTERM', () => { clearInterval(timer); void administration.stop().catch(() => { process.exitCode = 1; }); });
  process.once('SIGINT', () => { clearInterval(timer); void administration.stop().catch(() => { process.exitCode = 1; }); });
}
