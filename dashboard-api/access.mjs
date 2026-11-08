import { open, constants } from 'node:fs/promises';
import { isIP } from 'node:net';
import { createSecureContext } from 'node:tls';
export const cookieName = '__Host-hayate_operator';
const forbidden = message => Object.assign(Error(message), { status: 401 });
export async function networkOptions(config, services) {
  if (!config) return { host: '127.0.0.1' };
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !isIP(config.host)) throw Error('Explicit HTTPS origin and literal bind IP required');
  const identity = services?.get('identity');
  if (identity?.version !== 1 || ['login', 'authenticate', 'revoke'].some(name => typeof identity.implementation?.[name] !== 'function')) throw Error('HTTPS WebUI requires identity service version 1');
  const read = async (filename, privateFile) => {
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || privateFile && (stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.mode & 0o077)) throw Error('TLS key must be a private operator-owned regular file');
      return await file.readFile();
    } finally { await file.close(); }
  };
  const tls = { key: await read(config.keyFile, true), cert: await read(config.certFile, false), minVersion: 'TLSv1.2' };
  createSecureContext(tls); // Validate before UI modules acquire resources.
  return { host: config.host, origin: origin.origin, identity: identity.implementation, tls };
}
export function sessionToken(req) {
  const values = (req.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(cookieName + '='));
  return values.length === 1 ? values[0].slice(cookieName.length + 1) : undefined;
}
export function cookie(token, lifetime) {
  return `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(lifetime / 1000))}`;
}
export function requireSession(identity, req, origin) {
  const session = identity.authenticate(sessionToken(req), origin);
  if (!session || session.principal !== 'operator') throw forbidden('Authentication required');
  return session;
}
