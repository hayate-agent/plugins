import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { Identity, passwordRecord } from '../../identity/service.mjs';
import { WebUIChannel } from '../index.mjs';
import { Workspace } from '../../workspace/service.mjs';
export async function tlsFixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'webui-tls-'));
  try {
    const keyFile = path.join(home, 'key.pem'), certFile = path.join(home, 'cert.pem');
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { timeout: 15000 });
    await chmod(keyFile, 0o600);
    const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const origin = `https://localhost:${port}`; const password = 'fixture-password-long';
    const identity = new Identity({ username: 'admin', password: await passwordRecord(password), persist: config => writeFile(path.join(home, 'account-fixture.json'), JSON.stringify(config), { mode: 0o600 }) });
    const network = { host: '127.0.0.1', origin, keyFile, certFile };
    const workspace = new Workspace({ home, cwd: home, executionContexts: { async bind() {} } }); await workspace.open();
    const services = { get: name => name === 'identity' ? { version: 1, implementation: identity } : name === 'workspaces' ? { version: 1, implementation: workspace } : undefined };
    const channel = new WebUIChannel({ home, port, network, services });
    await channel.start(async () => {});
    const call = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
      const req = request(origin + route, { method, rejectUnauthorized: false, family: 4, headers: { ...(body ? { 'Content-Type': 'application/json', Origin: origin, 'X-Hayate-WebUI': '1' } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', part => chunks.push(part)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    return { home, network, services, identity, channel, workspace, origin, password, call,
      async stop() { await channel.stop(); await workspace.stop(); identity.stop(); await rm(home, { recursive: true, force: true }); } };
  } catch (error) { await rm(home, { recursive: true, force: true }); throw error; }
}
