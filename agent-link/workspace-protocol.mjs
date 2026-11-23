const deny = () => Object.assign(Error('Peer request refused'), { status: 403 });
export const CAPABILITIES = ['projects', 'streams', 'messages', 'activity'];

/** Same target-owned authorization for direct HTTPS and outbound WSS. */
export async function workspaceRequest(workspace, config, owner, capability, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw deny();
  const snapshot = workspace.snapshot(owner), allowed = new Set(Object.values(config.projects ?? {}));
  if (config.shareStandalone === true) allowed.add(null);
  const features = ['read-markers', 'idempotent-stream-create', 'organize-streams', 'rename-streams', 'stream-lifecycle-v1', 'fork-streams', 'pi-live-v1', ...(config.shareStandalone === true ? ['standalone-chats'] : [])];
  const stream = id => { const value = workspace.stream(owner, id); if (!allowed.has(value.projectId)) throw deny(); return value; };
  if (capability === 'projects') {
    if (input.action === 'resolve') {
      const projectId = Object.hasOwn(config.projects ?? {}, input.projectId) ? config.projects[input.projectId] : null;
      return { projectId: typeof projectId === 'string' && allowed.has(projectId) ? projectId : null, features };
    }
    if (input.action === 'list') return { projects: snapshot.projects.filter(project => allowed.has(project.id)) };
    if (input.action === 'apply') {
      const project = input.project, local = config.projects?.[project?.id];
      if (typeof local !== 'string' || !Object.hasOwn(config.projects, project.id)) throw deny();
      await workspace.update(owner, 'project', local, { title: project.title, settings: project.settings ?? {} });
      return { projectId: local, applied: true };
    }
  }
  if (capability === 'streams') {
    if (input.action === 'list') return { features, streams: snapshot.streams.filter(value => allowed.has(value.projectId) && (input.projectId === undefined || value.projectId === input.projectId)) };
    if (input.action === 'fork') {
      stream(input.streamId);
      return workspace.forkStream(owner, input.streamId, { idempotencyKey: input.idempotencyKey, title: input.title });
    }
    if (input.action === 'rename') {
      stream(input.streamId);
      await workspace.update(owner, 'stream', input.streamId, { title: input.title });
      return workspace.stream(owner, input.streamId);
    }
    // Archive / delete (both recoverable: only flags, history stays) and restore. Booleans only, at least one.
    if (input.action === 'lifecycle') {
      stream(input.streamId);
      const patch = {};
      for (const key of ['archived', 'deleted']) if (input[key] !== undefined) { if (typeof input[key] !== 'boolean') throw deny(); patch[key] = input[key]; }
      if (!Object.keys(patch).length) throw deny();
      await workspace.update(owner, 'stream', input.streamId, patch);
      const { archived, deleted } = workspace.stream(owner, input.streamId);
      return { archived: archived === true, deleted: deleted === true };
    }
    if (input.action === 'move') {
      stream(input.streamId); if (!allowed.has(input.projectId)) throw deny();
      await workspace.update(owner, 'stream', input.streamId, { projectId: input.projectId }); return { moved: true };
    }
    if (input.action === 'create' && allowed.has(input.projectId)) return workspace.createStream(owner, { projectId: input.projectId, title: input.title, idempotencyKey: input.idempotencyKey });
  }
  if (capability === 'messages') {
    stream(input.streamId);
    // Same bounded page as the PI connector (newest first, `before` cursor).
    if (input.action === 'read') return workspace.page ? workspace.page(owner, input.streamId, { before: typeof input.before === 'string' ? input.before : undefined }) : workspace.stream(owner, input.streamId);
    if (input.action === 'submission-status') {
      if (typeof input.id !== 'string') throw deny();
      const prior = workspace.stream(owner, input.streamId).messages?.find(item => item.id === input.id && item.role === 'user');
      return { status: prior ? (prior.accepted ? 'accepted' : 'unknown') : 'unknown' };
    }
    // stream-delta-v1 fallback. Workspace streams publish no delta log yet, so a
    // client always resynchronizes by loading one bounded page (never a replay).
    if (input.action === 'changes') return workspace.changes ? workspace.changes(owner, input.streamId, { since: input.since, epoch: typeof input.epoch === 'string' ? input.epoch : undefined }) : { epoch: null, session: input.streamId, seq: 0, reset: true, events: [] };
    if (input.action === 'image-read') return workspace.imageChunk ? workspace.imageChunk(owner, input.streamId, typeof input.messageId === 'string' ? input.messageId : '', input.index, input.offset ?? 0) : (() => { throw deny(); })();
    if (input.action === 'media-chunk') return workspace.uploadMedia(owner, input.streamId, input.chunk);
    if (input.action === 'mark-read') { await workspace.update(owner, 'stream', input.streamId, { read: true }); return { read: true }; }
    if (input.action === 'send') return workspace.submit(owner, input.streamId, { id: input.id, text: input.text, ...(input.attachments ? { attachments: input.attachments } : {}) });
  }
  if (capability === 'activity' && input.action === 'list') return { streams: snapshot.streams.filter(value => allowed.has(value.projectId)).map(({ id, projectId, activity, unread }) => ({ id, projectId, activity, unread })) };
  throw deny();
}
