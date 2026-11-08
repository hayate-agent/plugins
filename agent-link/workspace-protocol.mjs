const deny = () => Object.assign(Error('Peer request refused'), { status: 403 });
export const CAPABILITIES = ['projects', 'streams', 'messages', 'activity'];

/** Same target-owned authorization for direct HTTPS and outbound WSS. */
export async function workspaceRequest(workspace, config, owner, capability, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw deny();
  const snapshot = workspace.snapshot(owner), allowed = new Set(Object.values(config.projects ?? {}));
  if (config.shareStandalone === true) allowed.add(null);
  const features = ['read-markers', 'idempotent-stream-create', 'organize-streams', ...(config.shareStandalone === true ? ['standalone-chats'] : [])];
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
    if (input.action === 'move') {
      stream(input.streamId); if (!allowed.has(input.projectId)) throw deny();
      await workspace.update(owner, 'stream', input.streamId, { projectId: input.projectId }); return { moved: true };
    }
    if (input.action === 'create' && allowed.has(input.projectId)) return workspace.createStream(owner, { projectId: input.projectId, title: input.title, idempotencyKey: input.idempotencyKey });
  }
  if (capability === 'messages') {
    stream(input.streamId);
    if (input.action === 'read') return workspace.stream(owner, input.streamId);
    if (input.action === 'mark-read') { await workspace.update(owner, 'stream', input.streamId, { read: true }); return { read: true }; }
    if (input.action === 'send') return workspace.submit(owner, input.streamId, { id: input.id, text: input.text });
  }
  if (capability === 'activity' && input.action === 'list') return { streams: snapshot.streams.filter(value => allowed.has(value.projectId)).map(({ id, projectId, activity, unread }) => ({ id, projectId, activity, unread })) };
  throw deny();
}
