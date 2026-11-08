import { randomBytes, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(derive);
const digest = value => createHash('sha256').update(value).digest('hex');
const deny = (status = 401) => Object.assign(Error(status === 429 ? 'Login temporarily rate limited' : 'Authentication required'), { status });
export async function passwordRecord(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw Error('Use a password of 12–1024 characters');
  const salt = randomBytes(32).toString('hex');
  return { algorithm: 'scrypt-v1', salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
}

/** Single-operator authentication, reusable by trusted transports. No HTTP or UI dependencies.
 * Session tokens exist only in memory and the transport's secure credential custody.
 * Process restart revokes every session. Principal is intentionally fixed until all
 * legacy transports/data have multiuser ownership contracts. */
export class Identity {
  #sessions = new Map(); #limits = new Map(); #inflight = 0; #closed = false; #changes = Promise.resolve(); #persist;
  constructor({ username, password, sessionLifetimeMs = 3600000, now = Date.now, persist }) {
    if (typeof username !== 'string' || !username || username.length > 100 || password?.algorithm !== 'scrypt-v1' || !/^[a-f0-9]{64}$/.test(password.salt) || !/^[a-f0-9]{128}$/.test(password.hash) || !Number.isSafeInteger(sessionLifetimeMs) || sessionLifetimeMs < 1000 || sessionLifetimeMs > 86400000) throw Error('Invalid identity configuration');
    this.username = username; this.password = password; this.lifetime = sessionLifetimeMs; this.now = now; this.#persist = persist;
  }
  async login(username, password, { audience, client }) {
    if (this.#closed) throw deny(503);
    if (typeof audience !== 'string' || !audience.startsWith('https://') || typeof client !== 'string' || client.length > 200) throw deny();
    const now = this.now();
    for (const [key, value] of this.#limits) if (value.until <= now) this.#limits.delete(key);
    const key = digest(client); const limit = this.#limits.get(key);
    if ((limit?.attempts ?? 0) >= 5 || this.#inflight >= 4 || this.#limits.size >= 2048 && !limit) throw deny(429);
    this.#limits.set(key, { attempts: (limit?.attempts ?? 0) + 1, until: limit?.until ?? now + 60000 });
    this.#inflight++;
    try {
      const candidate = typeof password === 'string' && password.length <= 1024 ? password : '';
      const actual = await scrypt(candidate, this.password.salt, 64);
      const valid = timingSafeEqual(actual, Buffer.from(this.password.hash, 'hex'));
      if (!valid || username !== this.username || this.#closed) throw deny();
      // Rate-limit successful logins too: a known password is not a resource quota bypass.
      for (const [id, session] of this.#sessions) if (session.expiresAt <= now) this.#sessions.delete(id);
      if (this.#sessions.size >= 256) throw deny(429);
      const token = randomBytes(32).toString('base64url'); const expiresAt = this.now() + this.lifetime;
      this.#sessions.set(digest(token), { principal: 'operator', audience, expiresAt });
      return { token, expiresAt, principal: 'operator' };
    } finally { this.#inflight--; }
  }
  authenticate(token, audience) {
    if (this.#closed || typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
    const key = digest(token); const session = this.#sessions.get(key);
    if (!session || session.audience !== audience) return null;
    if (session.expiresAt <= this.now()) { this.#sessions.delete(key); return null; }
    return { principal: session.principal, expiresAt: session.expiresAt };
  }
  account(token, audience) {
    if (!this.authenticate(token, audience)) throw deny();
    return { username: this.username, editable: typeof this.#persist === 'function' };
  }
  changeCredentials(token, { audience, client }, { username, currentPassword, newPassword }) {
    const work = this.#changes.then(async () => {
      if (!this.#persist || !this.authenticate(token, audience)) throw deny();
      if (typeof username !== 'string' || !username.trim() || username.trim().length > 100) throw Object.assign(Error('Username must be 1–100 characters'), { status: 400 });
      let confirmation;
      try { confirmation = await this.login(this.username, currentPassword, { audience, client }); }
      catch (error) { if (error.status === 401) throw Object.assign(Error('Current password is incorrect'), { status: 400 }); throw error; }
      this.revoke(confirmation.token, audience);
      let password = this.password;
      if (newPassword !== undefined && newPassword !== '') {
        try { password = await passwordRecord(newPassword); }
        catch { throw Object.assign(Error('New password must be 12–1024 characters'), { status: 400 }); }
      }
      if (this.#closed || !this.authenticate(token, audience)) throw deny();
      const config = { username: username.trim(), password, sessionLifetimeMs: this.lifetime };
      await this.#persist(config);
      this.username = config.username; this.password = password; this.#sessions.clear();
      return { changed: true, signInRequired: true };
    });
    this.#changes = work.catch(() => {}); return work;
  }
  revoke(token, audience) { if (this.authenticate(token, audience)) this.#sessions.delete(digest(token)); }
  stop() { this.#closed = true; this.#sessions.clear(); this.#limits.clear(); }
}
