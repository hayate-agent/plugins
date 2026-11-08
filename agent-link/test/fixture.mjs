import { mkdtemp, mkdir, chmod, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AgentLink } from '../server.mjs';
import { HayateAdapter } from '../transport.mjs';
import { AgentHub } from '../../agent-hub/service.mjs';
import { LocalVault } from '../../credentials/vault.mjs';
import { Workspace } from '../../workspace/service.mjs';

export async function setup(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'hayate-peers-'));
  const targetHome = path.join(home, 'target'), centralHome = path.join(home, 'central'); await mkdir(targetHome); await mkdir(centralHome);
  const keyFile = path.join(home, 'key.pem'), certFile = path.join(home, 'cert.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']); await chmod(keyFile, 0o600);
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const vault = new LocalVault(centralHome); await vault.open(); const targetVault = new LocalVault(targetHome); await targetVault.open();
  const central = new AgentHub({ home: centralHome, credentials: vault }); await central.open();
  const target = new AgentHub({ home: targetHome, credentials: targetVault }); await target.open();
  const bindings = new Map(); const workspace = new Workspace({ home: targetHome, cwd: targetHome, executionContexts: { async bind(key, value) { bindings.set(key, value); } } }); await workspace.open();
  const project = await workspace.createProject('operator', { title: 'Target checkout', cwd: targetHome });
  const other = await workspace.createProject('operator', { title: 'Private project', cwd: targetHome });
  const received = []; await workspace.channel.start(async message => { received.push(message); await workspace.channel.send({ target: message.target }, 'Remote answer', { deliveryId: message.id }); await workspace.channel.turnStatus({ target: message.target }, { id: message.id }, 'completed'); });
  const origin = `https://127.0.0.1:${port}`;
  const config = { host: '127.0.0.1', port, origin, keyFile, certFile, projects: { 'central-project': project.id } };
  const server = new AgentLink({ home: targetHome, agent: 'Target Hayate', hub: target, workspace, config }); await server.open();
  const adapter = new HayateAdapter([{ origin, caFile: certFile }]); central.registerAdapter('hayate', adapter);
  t.after(async () => { await central.stop(); await server.stop(); await target.stop(); await workspace.stop(); await vault.stop(); await targetVault.stop(); await rm(home, { recursive: true, force: true }); });
  return { home, centralHome, targetHome, targetVault, central, target, workspace, bindings, project, other, received, origin, adapter, server, config };
}
