import test from 'node:test';
import assert from 'node:assert/strict';
import { Workspace } from '../service.mjs';

test('workspace project summaries match per-project scans for mixed lifecycle and ownership', () => {
 const service = new Workspace({ home: '/tmp/workspace-summary', cwd: '/tmp' });
 const projects = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, owner: i % 7 === 0 ? 'other' : 'operator' }));
 const streams = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, owner: i % 11 === 0 ? 'other' : 'operator', projectId: `p${i % 105}`, completed: i % 3, read: 0, deleted: i % 5 === 0, archived: i % 13 === 0, messages: [], receipts: [], legacy: { channel: 'probe', conversationId: `s${i}` } }));
 service.store.read = () => ({ projects, streams, settings: {} });
 service.registerTransport('probe', { async submit() {}, view: id => ({ activity: Number(id.slice(1)) % 4 === 0 ? { phase: 'running' } : null }) });
 const result = service.snapshot('operator');
 for (const project of result.projects) {
  assert.equal(project.unread, result.streams.some(s => s.projectId === project.id && s.unread && !s.deleted));
  assert.equal(project.active, result.streams.filter(s => s.projectId === project.id && s.activity).length);
 }
 assert.equal(result.projects.length, projects.filter(p => p.owner === 'operator').length);
});

test('empty projects retain false unread and zero active', () => {
 const service = new Workspace({ home: '/tmp/workspace-summary', cwd: '/tmp' });
 service.store.read = () => ({ projects: [{ id: 'empty', owner: 'operator' }], streams: [], settings: {} });
 assert.deepEqual(service.snapshot('operator').projects, [{ id: 'empty', unread: false, active: 0 }]);
});
