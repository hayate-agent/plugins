// Trusted local GatewayModule v1. No Slack SDK or Core imports required.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SlackFiles } from './slack-files.mjs';
import { SlackUploader } from './slack-upload.mjs';
import { SlackThreads } from './slack-threads.mjs';
import { conversationPolicy, conversationRule, channelAllowed, userAllowed } from './conversation-policy.mjs';

export class SlackDeliveryError extends Error {
  constructor(message, { retryAt, ambiguous = false } = {}) {
    super(message);
    this.retryAt = retryAt;
    this.ambiguous = ambiguous;
  }
}

function deliveryUuid(value) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export class SlackGateway {
  name = 'slack';
  conversationPolicy = 1;
  configureGateway(settings) {
    this.policy = conversationPolicy(settings.conversation);
  }
  constructor(options, transport = {}) {
    this.options = options;
    this.policy = conversationPolicy(options.conversation);
    this.fetch = transport.fetch ?? globalThis.fetch;
    this.Socket = transport.WebSocket ?? globalThis.WebSocket;
    this.pending = new Set();
    this.stopped = true;
    this.connectTimeoutMs = transport.connectTimeoutMs ?? 15000;
    this.stopTimeoutMs = transport.stopTimeoutMs ?? 15000;
    this.reconnectMs = transport.reconnectMs ?? 2000;
    this.reconnectMaxMs = transport.reconnectMaxMs ?? 30000;
    this.failures = 0;
    this.now = transport.now ?? Date.now;
    this.rateLimits = new Map();
    if (options.attachmentRoot) this.uploader = new SlackUploader({ root: options.attachmentRoot,
      api: (method, body) => this.api(method, body), fetch: this.fetch });
  }
  async api(method, body, token = this.options.botToken, signal) {
    const retryAt = this.rateLimits.get(method) ?? 0;
    if (this.now() < retryAt) throw new SlackDeliveryError(`Slack ${method}: rate limited`, { retryAt });
    let response;
    const read = ['users.conversations', 'conversations.info', 'files.getUploadURLExternal', 'files.info'].includes(method);
    const query = read ? '?' + new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])) : '';
    try {
      response = await this.fetch(`https://slack.com/api/${method}${query}`, {
        method: read ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        ...(!read ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
    } catch {
      // Never include fetch/provider exceptions: they may contain credentials or payloads.
      throw new SlackDeliveryError(`Slack ${method}: transport failed`, { ambiguous: method === 'chat.postMessage' });
    }
    if (response.status === 429) {
      const raw = response.headers?.get('retry-after')?.trim();
      // Slack specifies seconds. Invalid headers get a conservative one-minute cooldown.
      const seconds = raw && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
        ? Math.max(1, Number(raw)) : 60;
      const retryAt = Math.min(Number.MAX_SAFE_INTEGER, this.now() + seconds * 1000);
      this.rateLimits.set(method, retryAt);
      throw new SlackDeliveryError(`Slack ${method}: rate limited`, { retryAt });
    }
    if (!response.ok) throw new SlackDeliveryError(`Slack ${method}: HTTP ${response.status}`, {
      ambiguous: method === 'chat.postMessage' && response.status >= 500,
    });
    let result;
    try { result = await response.json(); }
    catch { throw new SlackDeliveryError(`Slack ${method}: invalid response`, { ambiguous: method === 'chat.postMessage' }); }
    if (!result || result.ok !== true) {
      // Only static known error codes enter logs; never echo arbitrary Slack response data.
      const known = ['invalid_auth', 'token_revoked', 'missing_scope', 'channel_not_found', 'not_in_channel',
        'is_archived', 'msg_too_long', 'no_text', 'restricted_action', 'ratelimited'];
      const code = known.includes(result?.error) ? result.error : 'request rejected';
      if (code === 'ratelimited') this.rateLimits.set(method, this.now() + 60000);
      throw new SlackDeliveryError(`Slack ${method}: ${code}`, { retryAt: this.rateLimits.get(method) });
    }
    return result;
  }
  async start(deliver) {
    if (!this.stopped || this.starting || this.connecting || this.pending.size ||
        (this.socket && this.socket.readyState !== 3)) throw Error('Slack gateway has not quiesced');
    this.deliver = deliver;
    this.stopped = false;
    this.closing = false;
    this.failures = 0;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.starting = (async () => {
      const identity = await this.api('auth.test', {}, this.options.botToken, signal);
      signal.throwIfAborted();
      if (!/^T[A-Z0-9]+$/.test(identity.team_id ?? '') || !identity.user_id ||
          (this.options.teamId && identity.team_id !== this.options.teamId)) throw Error('Slack workspace identity mismatch');
      this.options.teamId = identity.team_id;
      this.botId = identity.user_id;
      await this.connect();
      signal.throwIfAborted();
    })();
    try { await this.starting; }
    catch (error) {
      this.stopped = true;
      this.controller.abort();
      clearTimeout(this.timer); this.timer = undefined;
      this.socket?.close();
      throw error;
    } finally { this.starting = undefined; }
  }
  async connect() {
    if (this.socket && this.socket.readyState !== 3) throw Error('Previous Slack socket has not closed');
    const signal = this.controller.signal;
    const result = await this.api('apps.connections.open', {}, this.options.appToken, signal);
    signal.throwIfAborted();
    const url = new URL(result.url);
    if (url.protocol !== 'wss:') throw Error('Slack requires a secure socket');
    const socket = new this.Socket(url.toString());
    this.socket = socket;
    socket.addEventListener('close', () => this.scheduleReconnect(), { once: true });
    socket.addEventListener('error', () => socket.close());
    socket.addEventListener('message', event => {
      if (this.stopped || this.socket !== socket) return;
      const work = this.receive(event.data, socket).catch(() => {
        // Never acknowledge failed durable acceptance; Slack may redeliver.
        socket.close();
      });
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    });
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('close', closed);
        signal.removeEventListener('abort', aborted);
        if (error) { socket.close(); reject(error); } else resolve();
      };
      const opened = () => finish();
      const closed = () => finish(Error('Slack socket closed before opening'));
      const aborted = () => finish(Error('Slack socket connection cancelled'));
      const timer = setTimeout(() => finish(Error('Slack socket connection timed out')), this.connectTimeoutMs);
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('close', closed, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  scheduleReconnect() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connecting = this.connect()
        .catch(() => this.scheduleReconnect())
        .finally(() => { this.connecting = undefined; });
    }, Math.min(this.reconnectMaxMs, this.reconnectMs * 2 ** Math.min(this.failures++, 10)));
  }
  async receive(raw, socket) {
    const envelope = JSON.parse(String(raw));
    if (envelope.type === 'disconnect') { socket.close(); return; }
    if (!envelope.envelope_id) return;
    const payload = envelope.payload;
    const event = payload?.event;
    if (envelope.type !== 'events_api' || payload?.team_id !== this.options.teamId ||
        !event || !/^[CGD][A-Z0-9]+$/.test(event.channel ?? '') ||
        !channelAllowed(this.policy, event.channel) ||
        (this.options.channels && !this.options.channels.includes(event.channel))) {
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id })); return;
    }
    // Our own root posts (including file-share echoes) engage a thread but must
    // never trigger a model turn or a bot loop.
    if (event.type === 'message' && event.user === this.botId && /^\d+\.\d+$/.test(event.thread_ts ?? event.ts ?? '') &&
        (!event.subtype || event.subtype === 'file_share')) {
      await this.options.threads?.add(`${payload.team_id}:${event.channel}:${event.thread_ts ?? event.ts}`);
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id })); return;
    }
    const admittedPolicy = this.policy;
    const rule = conversationRule(admittedPolicy, event.channel);
    if (!userAllowed(rule, event.user) || rule.activation === 'disabled' ||
        event.bot_id || event.user === this.botId || (event.subtype && event.subtype !== 'file_share')) {
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id })); return;
    }
    const direct = event.type === 'message' && event.channel_type === 'im' && event.channel.startsWith('D');
    // Slack can deliver the same addressed message as message.channels/groups
    // as well as app_mention. Accept either; Core deduplicates by message ts.
    const mention = event.type === 'app_mention' || (event.type === 'message' &&
      typeof event.text === 'string' && !!this.botId && event.text.includes(`<@${this.botId}>`));
    const threadKey = `${payload?.team_id}:${event?.channel}:${event?.thread_ts ?? event?.ts}`;
    const continuation = rule.activation === 'threads' && event?.type === 'message' && typeof event.thread_ts === 'string' &&
      await this.options.threads?.has(threadKey);
    const open = rule.activation === 'open' && event.type === 'message';
    if (envelope.type === 'events_api' && payload?.team_id === this.options.teamId &&
        (mention || direct || continuation || open) && (!event.subtype || event.subtype === 'file_share') && !event.bot_id &&
        event.user && event.user !== this.botId && /^[CGD][A-Z0-9]+$/.test(event.channel ?? '') &&
        (!this.options.channels || this.options.channels.includes(event.channel))) {
      if (!payload.event_id || typeof event.ts !== 'string' || !/^\d+\.\d+$/.test(event.ts) ||
          (event.thread_ts !== undefined && !/^\d+\.\d+$/.test(event.thread_ts)) ||
          (event.text !== undefined && typeof event.text !== 'string') || (event.text === undefined && !event.files?.length)) throw Error('Invalid Slack event');
      const thread = direct ? 'dm' : rule.replyLocation === 'channel' ? 'channel' : event.thread_ts ?? event.ts;
      if (typeof thread !== 'string') throw Error('Invalid Slack thread');
      let files = event.files ?? [];
      if (!Array.isArray(files) || files.length > 4) throw Error('Slack attachment count exceeds limit');
      if (files.length && !this.options.files) throw Error('Slack attachment storage is not configured');
      if (this.options.files?.metadata) {
        files = await Promise.all(files.map(file => this.options.files.metadata(file, this.controller?.signal)));
      }
      const sessionKey = `slack:${payload.team_id}:${event.channel}:${thread}`;
      if (files.reduce((sum, file) => sum + (Number.isSafeInteger(file?.size) && file.size >= 0 ? file.size : Infinity), 0) > 20 * 1024 * 1024) throw Error('Slack attachment total exceeds limit');
      const attachments = [];
      for (const file of files) {
        const reference = await this.options.files.download(file, this.controller?.signal, sessionKey);
        attachments.push({ sessionKey, sha256: reference.sha256, size: reference.size, name: reference.name });
      }
      // Persist engagement before acceptance: a concurrent message event must
      // see the same thread, and a post-accept crash must not lose engagement.
      if (mention && this.options.threads) await this.options.threads.add(threadKey);
      if (this.policy !== admittedPolicy) throw Error('Conversation policy changed during ingress; retry under current rules');
      await this.deliver({
        ...(attachments.length ? { attachments } : {}),
        id: `slack:${payload.team_id}:${event.channel}:${event.ts}`,
        sessionKey,
        sender: `slack:${payload.team_id}:${event.user}`,
        text: (event.text ?? '').replaceAll(`<@${this.botId}>`, '').trim(), source: 'channel',
        replyOptional: !direct && !mention && !continuation || undefined,
        replyTo: { channel: 'slack', target: event.channel,
          ...(direct ? event.thread_ts ? { thread: event.thread_ts } : {} : rule.replyLocation === 'thread' ? { thread: event.thread_ts ?? event.ts } : {}) },
      });
    }
    // Channel.start callback resolves only after durable Core inbox acceptance.
    socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
  }
  async send(to, text, meta = {}) {
    // Fence synchronously before stop snapshots work. Track the whole delivery,
    // including response bodies and upload persistence, not just the HTTP request.
    if (this.closing) throw Error('Slack gateway is stopping');
    const work = this.sendMessage(to, text, meta);
    this.pending.add(work);
    try { await work; } finally { this.pending.delete(work); }
  }
  async sendMessage(to, text, meta) {
    if (to.channel !== 'slack' || !/^[CGD][A-Z0-9]+$/.test(to.target ?? '') ||
        !channelAllowed(this.policy, to.target) ||
        (this.options.channels && !this.options.channels.includes(to.target)) ||
        (to.thread !== undefined && !/^\d+\.\d+$/.test(to.thread))) throw Error('Slack destination is not allowed');
    if (meta.attachments?.length) {
      if (!this.uploader || !meta.deliveryId || meta.attachments.length !== 1) throw Error('File upload requires one scoped file and delivery ID');
      const sessionKey = meta.attachmentSessionKey ?? `slack:${this.options.teamId}:${to.target}:${to.thread ?? 'dm'}`;
      if (meta.attachments[0].sessionKey !== sessionKey) throw Error('File upload session mismatch');
      await this.uploader.send({ sessionKey, to, reference: meta.attachments[0], deliveryId: meta.deliveryId,
        caption: text, scopedSend: !!meta.attachmentSessionKey });
      if (to.thread) await this.options.threads?.add(`${this.options.teamId}:${to.target}:${to.thread}`);
      return;
    }
    // One logical outbound delivery remains one API operation; no partial chunk replay.
    // Slack truncates above 40k; fail explicitly instead of silently losing content.
    if ([...text].length > 39000) throw Error('Slack reply exceeds supported message length');
    const posted = await this.api('chat.postMessage', {
      channel: to.target, ...(to.thread ? { thread_ts: to.thread } : {}), text,
      unfurl_links: false, unfurl_media: false,
      ...(meta.deliveryId ? { client_msg_id: deliveryUuid(JSON.stringify([this.options.teamId, to.target, to.thread, meta.deliveryId])) } : {}),
    });
    const thread = to.thread ?? posted.ts;
    if (!to.target.startsWith('D') && this.options.threads && /^\d+\.\d+$/.test(thread ?? '')) {
      // A thread started by this bot is engaged too, including after restart.
      // Persistence failure after posting is an uncertain effect, never a resend.
      await this.options.threads.add(`${this.options.teamId}:${to.target}:${thread}`);
    }
  }
  messaging = {
    describe: () => ({ text: true, files: !!this.uploader && this.options.outboundAttachments !== false, maxFileBytes: 10 * 1024 * 1024, threads: true,
      conversation: structuredClone(this.policy),
      connected: !this.stopped && this.socket?.readyState === 1,
      destinationFormat: 'Slack channel/conversation ID (C…, G…, D…); omit thread for a new channel post, or use its exact message timestamp for a thread reply.',
      ...(this.options.teamId ? { workspace: this.options.teamId } : {}),
      ...(this.options.channels ? { allowedTargets: [...this.options.channels] } : {}) }),
    destinations: async ({ limit = 50, cursor } = {}, signal) => {
      if (this.closing || this.stopped) throw Error('Slack gateway is not connected');
      const work = (async () => {
        const result = await this.api('users.conversations', { types: 'public_channel,private_channel',
          exclude_archived: true, limit, ...(cursor ? { cursor } : {}) }, this.options.botToken, signal);
        return { destinations: (result.channels ?? []).slice(0, limit)
          .filter(item => /^[CGD][A-Z0-9]+$/.test(item.id ?? '') && channelAllowed(this.policy, item.id) &&
            (!this.options.channels || this.options.channels.includes(item.id)))
          .map(item => ({ target: item.id, ...(typeof item.name === 'string' ? { name: item.name.slice(0, 200) } : {}),
            kind: item.is_im ? 'dm' : item.is_private ? 'private-channel' : 'channel' })),
          ...(result.response_metadata?.next_cursor ? { nextCursor: result.response_metadata.next_cursor } : {}) };
      })();
      this.pending.add(work);
      try { return await work; } finally { this.pending.delete(work); }
    },
  };
  async stop(budgetMs = this.stopTimeoutMs) {
    this.closing = true;
    this.stopped = true;
    clearTimeout(this.timer); this.timer = undefined;
    const socket = this.socket;
    let closed = Promise.resolve();
    if (socket && socket.readyState !== 3) {
      closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
    }
    this.controller?.abort();
    if (socket && socket.readyState !== 3) socket.close();
    // A settled failed delivery is drained too; its error still reaches Core's
    // outbox. A timeout or unclosed socket must never claim quiescence.
    const drained = Promise.allSettled([closed, this.starting, this.connecting, ...this.pending]);
    let timer;
    try {
      await Promise.race([drained, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Slack gateway shutdown did not quiesce')), budgetMs);
      })]);
    } finally { clearTimeout(timer); }
  }
}

export default {
  apiVersion: 1,
  updateAdmission: 'foreground-owned',
  async create(context) {
    const e = process.env;
    const names = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'];
    if (!names.some(name => e[name])) return undefined;
    if (!names.every(name => e[name]?.trim())) throw Error('Incomplete Slack gateway configuration');
    if (context.inboundAttachments !== 1) throw Error('Slack gateway requires Core inbound attachment contract v1');
    const channels = e.SLACK_CHANNEL_IDS?.trim() ? e.SLACK_CHANNEL_IDS.split(',').map(s => s.trim()) : undefined;
    if ((e.SLACK_TEAM_ID && !/^T[A-Z0-9]+$/.test(e.SLACK_TEAM_ID)) || channels?.some(s => !/^[CG][A-Z0-9]+$/.test(s))) throw Error('Invalid optional Slack workspace/channel restrictions');
    return { channel: new SlackGateway({ appToken: e.SLACK_APP_TOKEN, botToken: e.SLACK_BOT_TOKEN, teamId: e.SLACK_TEAM_ID, channels,
      threads: new SlackThreads(path.join(context.home, 'slack-threads')),
      attachmentRoot: path.join(context.home, 'attachments'), outboundAttachments: context.outboundAttachments === 1,
      files: new SlackFiles({ root: path.join(context.home, 'attachments'), botToken: e.SLACK_BOT_TOKEN,
        info: async (id, signal) => {
          const response = await globalThis.fetch('https://slack.com/api/files.info?file=' + encodeURIComponent(id),
            { headers: { Authorization: `Bearer ${e.SLACK_BOT_TOKEN}` }, redirect: 'error',
              signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
          if (!response.ok) throw Error('Slack file metadata lookup failed');
          const result = await response.json();
          if (result.ok !== true || result.file?.id !== id) throw Error('Slack file metadata is unavailable');
          return result.file;
        } }) }) };
  },
};
