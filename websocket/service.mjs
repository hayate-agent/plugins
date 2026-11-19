import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

// Network resources live for the plugin lifetime, not the lifetime of a tool call.
export class WebSockets {
  constructor({ deliver, ingress, correlate, maxConnections = 64, maxPayload = 1024 * 1024, maxPending = 32 } = {}) {
    this.ingress = ingress; this.correlate = correlate;
    this.deliver = deliver; this.maxConnections = maxConnections;
    this.maxPayload = maxPayload; this.maxPending = maxPending;
    this.connections = new Map(); this.listeners = new Map(); this.stopped = false;
  }
  check(owner) {
    if (this.stopped) throw Error('WebSocket service stopped');
    if (typeof owner !== 'string' || !owner) throw Error('Session required');
  }
  owned(owner, id, map = this.connections) {
    this.check(owner); const row = map.get(id);
    if (!row || row.owner !== owner) throw Error('Unknown WebSocket resource');
    return row;
  }
  capacity() {
    if (this.connections.size >= this.maxConnections) throw Error('Connection limit reached');
  }
  async connect(owner, { url, headers, reconnectMs = 0, ca, signal, profile, binding } = {}) {
    this.check(owner); this.capacity();
    let address; try { address = new URL(url); } catch { throw Error('Invalid WebSocket URL'); }
    if (!['ws:', 'wss:'].includes(address.protocol)) throw Error('Expected ws or wss URL');
    if (!Number.isInteger(reconnectMs) || reconnectMs < 0 || reconnectMs > 300000) throw Error('Invalid reconnect interval');
    if (signal?.aborted) throw Error('Connection cancelled');
    const row = { id: randomUUID(), owner, kind: 'client', pending: 0, reconnectMs, closed: false,
      profile: this.ingress?.profile(profile), binding, controller: new AbortController() };
    this.connections.set(row.id, row);
    const open = () => {
      if (row.closed || this.stopped) return;
      try {
        const socket = new WebSocket(address, { headers, ca, maxPayload: this.maxPayload, handshakeTimeout: 10000 });
        row.socket = socket; this.attach(row, socket);
        socket.once('close', () => {
          if (!row.closed && !this.stopped && reconnectMs) row.timer = setTimeout(open, reconnectMs);
        });
      } catch {
        row.closed = true; this.connections.delete(row.id);
      }
    };
    open();
    try {
      await new Promise((resolve, reject) => {
        const socket = row.socket;
        if (!socket) { reject(Error('Connection failed')); return; }
        const cleanup = () => { socket.off('open', ok); socket.off('error', fail); socket.off('close', fail); signal?.removeEventListener('abort', cancel); };
        const ok = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(Error('WebSocket connection failed')); };
        const cancel = () => { cleanup(); reject(Error('Connection cancelled')); };
        socket.once('open', ok); socket.once('error', fail); socket.once('close', fail);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      });
    } catch (error) {
      row.closed = true; clearTimeout(row.timer); this.connections.delete(row.id);
      row.socket?.terminate(); throw error;
    }
    return this.describe(row);
  }
  attach(row, socket) {
    socket.on('error', () => {}); // Never expose remote URLs, headers or credentials in diagnostics.
    socket.on('message', (data, binary) => {
      if (row.closed || this.stopped) return;
      if (row.pending >= this.maxPending) { socket.close(1013, 'Event queue full'); return; }
      row.pending++;
      const profile = row.profile; // Configuration changes affect only later received frames.
      // Each socket has an ordered, bounded delivery queue. No automatic effect replay.
      row.tail = (row.tail ?? Promise.resolve()).then(() => {
        if (row.closed || this.stopped) return;
        const eventId = randomUUID();
        const frame = { type: 'websocket.message', encoding: binary ? 'base64' : 'utf8',
          data: data.toString(binary ? 'base64' : 'utf8') };
        if (this.ingress) return this.ingress.process(frame, {
          owner: row.owner, connection: row.id, listener: row.listener, eventId,
          signal: row.controller.signal, send: (data, encoding) => this.send(row.owner, row.id, data, encoding),
          correlate: this.correlate, binding: row.binding,
        }, profile);
        return this.deliver?.({ session: row.owner, target: row.id, id: eventId,
          text: JSON.stringify({ ...frame, connection: row.id, listener: row.listener }) });
      }).catch(() => { socket.close(1011, 'Event delivery failed'); }).finally(() => { row.pending--; });
    });
    socket.on('close', () => {
      if (!row.reconnectMs || row.closed) this.connections.delete(row.id);
    });
  }
  async listen(owner, { host = '127.0.0.1', port = 0, token, profile, binding } = {}) {
    this.check(owner);
    if (this.listeners.size >= 16) throw Error('Listener limit reached');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid port');
    if (token !== undefined && (typeof token !== 'string' || !token)) throw Error('Invalid bearer token');
    const row = { id: randomUUID(), owner, kind: 'listener', profile: this.ingress?.profile(profile), binding };
    const server = new WebSocketServer({ host, port, maxPayload: this.maxPayload,
      verifyClient: ({ req }) => {
        if (!token) return true;
        const actual = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token}`);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      } });
    row.server = server; this.listeners.set(row.id, row);
    server.on('error', () => {});
    server.on('connection', socket => {
      if (this.stopped || this.connections.size >= this.maxConnections) { socket.on('error', () => {}); socket.terminate(); return; }
      const peer = { id: randomUUID(), owner, kind: 'peer', listener: row.id, socket, pending: 0, closed: false,
        profile: row.profile, binding: row.binding, controller: new AbortController() };
      this.connections.set(peer.id, peer); this.attach(peer, socket);
    });
    try {
      await new Promise((resolve, reject) => {
        const ok = () => { server.off('error', fail); resolve(); };
        const fail = () => { server.off('listening', ok); reject(Error('WebSocket listener failed')); };
        server.once('listening', ok); server.once('error', fail);
      });
    } catch (error) { this.listeners.delete(row.id); server.close(); throw error; }
    if (this.stopped) { server.close(); throw Error('WebSocket service stopped'); }
    return { id: row.id, kind: row.kind, address: server.address() };
  }
  configure(owner, id, profile) {
    if (!this.ingress) throw Error('Ingress not configured');
    const row = this.owned(owner, id, this.listeners.has(id) ? this.listeners : this.connections);
    row.profile = this.ingress.profile(profile);
    // Listener changes apply to existing and future peers. Received frames retain their old profile.
    if (row.kind === 'listener') for (const peer of this.connections.values()) {
      if (peer.listener === id) peer.profile = row.profile;
    }
  }
  describe(row) { return { id: row.id, kind: row.kind, listener: row.listener, state: row.socket?.readyState ?? WebSocket.CLOSED }; }
  list(owner) {
    this.check(owner);
    return { connections: [...this.connections.values()].filter(x => x.owner === owner).map(x => this.describe(x)),
      listeners: [...this.listeners.values()].filter(x => x.owner === owner).map(x => ({ id: x.id, address: x.server.address() })) };
  }
  async send(owner, id, data, encoding = 'utf8') {
    const row = this.owned(owner, id);
    if (typeof data !== 'string' || !['utf8', 'base64'].includes(encoding)) throw Error('Expected utf8 or base64 string');
    if (data.length > this.maxPayload * 2) throw Error('Message too large');
    const bytes = Buffer.from(data, encoding);
    if (bytes.length > this.maxPayload) throw Error('Message too large');
    if (row.socket.readyState !== WebSocket.OPEN) throw Error('WebSocket not open');
    if (row.socket.bufferedAmount + bytes.length > this.maxPayload * 2) throw Error('WebSocket send buffer full');
    await new Promise((resolve, reject) => row.socket.send(bytes, { binary: encoding === 'base64' }, error => error ? reject(Error('WebSocket send failed')) : resolve()));
  }
  close(owner, id) {
    this.check(owner);
    if (this.listeners.has(id)) {
      const row = this.owned(owner, id, this.listeners); this.listeners.delete(id);
      for (const peer of [...this.connections.values()]) if (peer.listener === id) this.close(owner, peer.id);
      row.server.close(); return;
    }
    const row = this.owned(owner, id); row.closed = true; row.controller?.abort();
    clearTimeout(row.timer); this.connections.delete(id); row.socket?.terminate();
  }
  stop() {
    if (this.stopped) return;
    for (const row of [...this.listeners.values()]) this.close(row.owner, row.id);
    for (const row of [...this.connections.values()]) this.close(row.owner, row.id);
    this.stopped = true;
  }
}
