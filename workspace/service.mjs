import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Store } from '../shared/store.mjs';
import { Files } from './files.mjs';
const id = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const title = value => { if (typeof value !== 'string' || !value.trim() || value.length > 160) throw Error('A title of 1–160 characters is required'); return value.trim(); };
const actor = value => { if (typeof value !== 'string' || !value || value.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(value)) throw Error('Authenticated workspace principal required'); return value; };
const settings = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['model', 'thinking', 'instructions', 'color'].includes(k))) throw Error('Invalid workspace settings');
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw Error('Settings must be strings');
    if (key === 'model' && (!item.includes('/') || /\s/.test(item))) throw Error('Use a configured provider/model reference');
    if (key === 'color' && !/^#[a-f0-9]{6}$/i.test(item)) throw Error('Use a six-digit color');
  }
  return structuredClone(value);
};

/** Transport-independent project domain. Owns no browser, HTTP listener or second agent runtime. */
export class Workspace {
  #deliver; #live = new Map(); #pending = new Set(); #stopping = false; #listeners = new Set(); #notification; #transports = new Map();
  constructor({ home, cwd, roots = [cwd], executionContexts, agent = 'Hayate' }) {
    this.agent = agent; this.contexts = executionContexts; this.cwd = cwd;
    this.store = new Store(path.join(home, 'workspace/state.json'), { version: 1, projects: [], streams: [], settings: {} });
    this.files = new Files(roots);
    this.store.subscribe(() => this.#publish());
  }
  #publish() { for (const listener of this.#listeners) try { listener(); } catch { /* projection failure never affects durable state */ } }
  #activityChanged() {
    if (this.#stopping || this.#notification) return;
    this.#notification = setTimeout(() => { this.#notification = undefined; this.#publish(); }, 60);
  }
  async open() { await this.files.start(); await this.store.load(); }
  #project(data, principal, projectId) {
    actor(principal); const value = data.projects.find(p => p.id === projectId && p.owner === principal);
    if (!value) throw Error('Project not found'); return value;
  }
  #stream(data, principal, streamId) {
    actor(principal); const value = data.streams.find(s => s.id === streamId && s.owner === principal);
    if (!value) throw Error('Stream not found'); return value;
  }
  registerTransport(name, transport) {
    if (this.#transports.has(name) || typeof transport?.view !== 'function' || typeof transport?.submit !== 'function') throw Error('Invalid or duplicate conversation transport');
    this.#transports.set(name, transport); this.#publish();
    return () => { this.#transports.delete(name); this.#publish(); };
  }
  #external(stream) {
    if (!stream.legacy) return {};
    const transport = this.#transports.get(stream.legacy.channel);
    if (!transport) return { messages: [], unavailable: true, activity: null };
    return transport.view(stream.legacy.conversationId);
  }
  snapshot(principal) {
    actor(principal); const data = this.store.read();
    const streams = data.streams.filter(s => s.owner === principal).map(({ messages, receipts, owner, ...stream }) => ({ ...stream,
      updatedAt: stream.legacy ? this.#external(stream).updatedAt ?? stream.updatedAt : stream.updatedAt,
      unread: stream.completed > (stream.read ?? 0), activity: stream.legacy ? this.#external(stream).activity ?? null : this.#live.get(stream.id) ?? null }));
    const projects = data.projects.filter(p => p.owner === principal).map(({ owner, ...project }) => ({ ...project,
      unread: streams.some(s => s.projectId === project.id && s.unread && !s.deleted),
      active: streams.filter(s => s.projectId === project.id && s.activity).length }));
    return { agent: this.agent, projects, streams, settings: Object.hasOwn(data.settings, principal) ? data.settings[principal] : {}, roots: this.files.roots() };
  }
  stream(principal, streamId) {
    const { owner, receipts, ...stream } = this.#stream(this.store.read(), principal, streamId);
    return { ...stream, ...this.#external(stream), unread: stream.completed > (stream.read ?? 0), activity: stream.legacy ? this.#external(stream).activity ?? null : this.#live.get(streamId) ?? null };
  }
  subscribe(listener) { if (this.#stopping) throw Error('Workspace stopping'); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async createProject(principal, input) {
    actor(principal);
    const cwd = await this.files.resolve(input.cwd);
    const directories = [...new Set(await Promise.all([cwd, ...(input.directories ?? [])].map(p => this.files.resolve(p))))];
    const repositories = await Promise.all((input.repositories ?? []).map(p => this.files.repository(p)));
    const project = { id: randomUUID(), owner: principal, title: title(input.title), parentId: input.parentId ?? null,
      cwd, directories, repositories, settings: settings(input.settings ?? {}), createdAt: Date.now(), updatedAt: Date.now() };
    await this.store.change(data => {
      if (project.parentId) this.#project(data, principal, project.parentId);
      data.projects.push(project);
    });
    return structuredClone(project);
  }
  async createStream(principal, input) {
    if (!this.contexts) throw Error('The host execution-context capability is required; presentation-only cwd changes are refused');
    actor(principal);
    const data = this.store.read(); const project = input.projectId == null ? null : this.#project(data, principal, input.projectId);
    if (input.idempotencyKey !== undefined && !id(input.idempotencyKey)) throw Error('Stream creation key must be a UUID');
    const creation = { projectId: project?.id ?? null, title: title(input.title ?? 'New chat'), cwd: input.cwd ?? project?.cwd ?? this.cwd };
    const previous = data.streams.find(stream => stream.owner === principal && input.idempotencyKey && stream.creationKey === input.idempotencyKey);
    if (previous) {
      if (JSON.stringify(previous.creation) !== JSON.stringify(creation)) throw Error('Stream creation identity conflict');
      return this.stream(principal, previous.id);
    }
    if (project?.deleted || project?.archived) throw Error('Restore the project before creating a stream');
    const cwd = await this.files.resolve(creation.cwd);
    const directories = [...new Set(await Promise.all([cwd, ...(project?.directories ?? [cwd])].map(p => this.files.resolve(p))))];
    const stream = { id: randomUUID(), owner: principal, projectId: project?.id ?? null, title: creation.title,
      cwd, directories, settings: settings(input.settings ?? {}), completed: 0, read: 0,
      messages: [], receipts: [], ...(input.idempotencyKey ? { creationKey: input.idempotencyKey, creation } : {}), createdAt: Date.now(), updatedAt: Date.now() };
    // Context is durable before a stream can accept any work. An orphan binding
    // after a presentation-store failure cannot execute a model turn.
    await this.contexts.bind(`plugin:workspaces:${stream.id}`, { cwd, directories });
    const selected = await this.store.change(next => {
      if (project) { const current = this.#project(next, principal, project.id); if (current.deleted || current.archived) throw Error('Restore the project before creating a stream'); }
      const previous = next.streams.find(value => value.owner === principal && input.idempotencyKey && value.creationKey === input.idempotencyKey);
      if (previous) { if (JSON.stringify(previous.creation) !== JSON.stringify(creation)) throw Error('Stream creation identity conflict'); return previous.id; }
      next.streams.push(stream); return stream.id;
    });
    return this.stream(principal, selected);
  }
  async attachConversation(principal, { conversationId, title: label, projectId }) {
    if (!id(conversationId) || !this.contexts?.get) throw Error('Existing conversation and host context required');
    const data = this.store.read();
    const previous = data.streams.find(stream => stream.owner === principal && stream.legacy?.conversationId === conversationId);
    if (previous) { if (projectId !== undefined) await this.update(principal, 'stream', previous.id, { projectId }); return this.stream(principal, previous.id); }
    // Keep the original runtime key, transcript, tools and approvals. Project
    // organization never impersonates a new workspace session or changes cwd.
    const context = this.contexts.get(`webui:${conversationId}`);
    await this.contexts.bind(`webui:${conversationId}`, context);
    const project = projectId ? this.#project(data, principal, projectId) : null;
    const stream = { id: randomUUID(), owner: principal, projectId: project?.id ?? null, title: title(label), cwd: context.cwd, directories: context.directories,
      legacy: { channel: 'webui', conversationId }, settings: {}, messages: [], receipts: [], completed: 0, read: 0, createdAt: Date.now(), updatedAt: Date.now() };
    const selected = await this.store.change(next => {
      const previous = next.streams.find(value => value.owner === principal && value.legacy?.conversationId === conversationId);
      if (previous) return previous.id;
      next.streams.push(stream); return stream.id;
    });
    return this.stream(principal, selected);
  }
  async externalTurn(conversationId, taskId, phase) {
    if (!['completed', 'failed', 'cancelled'].includes(phase)) return;
    await this.store.change(data => {
      const stream = data.streams.find(stream => stream.legacy?.conversationId === conversationId);
      if (!stream || stream.lastTurn === taskId) return;
      stream.lastTurn = taskId; stream.completed++; stream.phase = phase; stream.updatedAt = Date.now();
    });
  }
  externalChanged() { this.#publish(); }
  async update(principal, kind, objectId, patch) {
    if (!['project', 'stream', 'global'].includes(kind)) throw Error('Unknown settings scope');
    if (kind === 'global') {
      actor(principal); const value = settings(patch);
      await this.store.change(data => { data.settings[principal] = value; }); return;
    }
    if (!patch || typeof patch !== 'object' || Object.keys(patch).some(k => !['title', 'settings', 'archived', 'deleted', 'parentId', 'projectId', 'read'].includes(k))) throw Error('Invalid workspace patch');
    await this.store.change(data => {
      const object = kind === 'project' ? this.#project(data, principal, objectId) : this.#stream(data, principal, objectId);
      if (patch.title !== undefined) object.title = title(patch.title);
      if (patch.settings !== undefined) object.settings = settings(patch.settings);
      for (const key of ['archived', 'deleted']) if (patch[key] !== undefined) {
        if (typeof patch[key] !== 'boolean') throw Error('Expected boolean lifecycle flag');
        object[key] = patch[key];
      }
      if (patch.read !== undefined && kind === 'stream') object.read = object.completed;
      if (patch.parentId !== undefined && kind === 'project') {
        const seen = new Set([object.id]); let current = patch.parentId;
        while (current) { if (seen.has(current)) throw Error('Project hierarchy cannot contain a cycle'); seen.add(current); current = this.#project(data, principal, current).parentId; }
        object.parentId = patch.parentId;
      }
      if (patch.projectId !== undefined && kind === 'stream') {
        const destination = patch.projectId === null ? null : this.#project(data, principal, patch.projectId);
        if (destination?.deleted || destination?.archived) throw Error('Destination project is unavailable');
        object.projectId = destination?.id ?? null; // Organize only: never silently retarget execution cwd.
      }
      if (kind === 'project') object.updatedAt = Date.now();
    });
  }
  async convert(principal, streamId) {
    const stream = this.#stream(this.store.read(), principal, streamId);
    const project = await this.createProject(principal, { title: stream.title, cwd: stream.cwd, directories: stream.directories, parentId: stream.projectId });
    await this.update(principal, 'stream', stream.id, { projectId: project.id });
    return project;
  }
  async submit(principal, streamId, message) {
    if (this.#stopping || !this.#deliver) throw Error('Workspace ingress is not running');
    if (!id(message.id) || typeof message.text !== 'string' || !message.text.trim()) throw Error('A stable message UUID and text are required');
    const data = this.store.read(); const stream = this.#stream(data, principal, streamId);
    const project = stream.projectId == null ? null : this.#project(data, principal, stream.projectId);
    if (stream.deleted || stream.archived || project?.deleted || project?.archived) throw Error('Restore the stream/project before sending');
    const selection = { ...(Object.hasOwn(data.settings, principal) ? data.settings[principal] : {}), ...(project?.settings ?? {}), ...stream.settings };
    const { model, thinking, instructions } = selection;
    const input = { session: streamId, target: streamId, sender: principal, id: `${streamId}:${message.id}`, text: message.text.trim(),
      turn: Object.fromEntries(Object.entries({ model, thinking, instructions }).filter(([, value]) => value !== undefined)) };
    const work = (async () => {
      const turn = await this.store.change(next => {
        const current = this.#stream(next, principal, streamId);
        const existing = current.messages.find(m => m.id === message.id);
        if (existing && (existing.role !== 'user' || existing.text !== input.text)) throw Error('Message identity conflict');
        if (!existing) { current.updatedAt = Date.now(); current.messages.push({ id: message.id, role: 'user', text: input.text, turn: input.turn, accepted: false, at: current.updatedAt }); }
        return structuredClone(existing?.turn ?? input.turn);
      });
      if (this.#stopping) throw Error('Workspace stopping; retry the same message');
      // Selection is captured once from operator-owned settings. The host
      // validates turn overrides and retains authority/approval/tool policy.
      if (stream.legacy) {
        const transport = this.#transports.get(stream.legacy.channel);
        if (!transport) throw Error('Original conversation transport is unavailable');
        await transport.submit(stream.legacy.conversationId, { id: message.id, text: input.text }, turn);
      } else await this.#deliver({ ...input, turn });
      await this.store.change(next => { this.#stream(next, principal, streamId).messages.find(m => m.id === message.id).accepted = true; });
      return { accepted: true, id: message.id };
    })();
    this.#pending.add(work); try { return await work; } finally { this.#pending.delete(work); }
  }
  channel = {
    name: 'workspaces',
    start: async deliver => { this.#stopping = false; this.#deliver = deliver; },
    send: async (to, text, meta = {}) => {
      await this.store.change(data => {
        const stream = data.streams.find(s => s.id === to.target); if (!stream) throw Error('Workspace stream not found');
        if (meta.deliveryId && stream.receipts.includes(meta.deliveryId)) return;
        if (meta.deliveryId) stream.receipts.push(meta.deliveryId);
        stream.messages.push({ id: randomUUID(), role: 'assistant', text, at: Date.now(), outcome: meta.outcome, progress: meta.presentation === 'progress' });
        stream.updatedAt = Date.now();
      });
      if (meta.presentation !== 'progress' && !meta.approvalId) this.#live.delete(to.target);
    },
    turnEvent: (to, event) => {
      const activity = this.#live.get(to.target) ?? { text: '', tools: {}, completed: 0, failed: 0, startedAt: Date.now() };
      if (event.type === 'text') activity.text += event.delta;
      if (event.type === 'tool') {
        const key = String(event.name); if (['__proto__', 'constructor', 'prototype'].includes(key)) return;
        activity.tools[key] = Math.max(0, (activity.tools[key] ?? 0) + (event.phase === 'start' ? 1 : -1));
        if (event.phase === 'end') { activity.completed++; if (event.error) activity.failed++; }
      }
      this.#live.set(to.target, activity);
      this.#activityChanged();
    },
    typing: async (to, on) => {
      if (on && !this.#live.has(to.target)) this.#live.set(to.target, { text: '', tools: {}, completed: 0, failed: 0, startedAt: Date.now() });
      if (!on && !this.#live.get(to.target)?.text) this.#live.delete(to.target);
      this.#activityChanged();
    },
    turnStatus: async (to, input, phase) => {
      await this.store.change(data => {
        const stream = data.streams.find(s => s.id === to.target); if (!stream) return;
        stream.phase = phase;
        if (phase !== 'started' && stream.lastCompletedTurn !== input.id) {
          stream.completed++; stream.lastCompletedTurn = input.id; stream.updatedAt = Date.now();
        }
      });
    },
    stop: async () => { this.#stopping = true; this.#deliver = undefined; clearTimeout(this.#notification); this.#notification = undefined; await Promise.allSettled([...this.#pending]); this.#live.clear(); },
  };
  async stop() { await this.channel.stop(); await this.store.stop(); this.#listeners.clear(); }
}
